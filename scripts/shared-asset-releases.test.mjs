import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { join } from "node:path";
import test from "node:test";
import { publishRelease, STORE_ID } from "./shared-asset-releases.mjs";

const { handler } = createRequire(import.meta.url)("../shared-assets.cjs");
const ids = ["a", "b", "c", "d", "e"].map((x) => x.repeat(40));

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "sprite-shared-assets-"));
  const store = join(root, "store");
  await mkdir(join(store, "leases"), { recursive: true });
  await writeFile(join(store, ".store-identity.json"), JSON.stringify(STORE_ID));
  const sources = [];
  for (const id of ids) {
    const source = join(root, `image-${id[0]}`);
    await mkdir(join(source, "_next/static/chunks"), { recursive: true });
    await writeFile(join(source, "version.json"), JSON.stringify({ commit: id }));
    await writeFile(join(source, "_next/static/chunks", `${id}.js`), `window.revision='${id}';`);
    await writeFile(join(source, "_next/static/chunks/shared.js"), "window.shared=1;");
    // Turbopack chunk names may contain "~".
    await writeFile(join(source, "_next/static/chunks", `0${id[0]}~tilde.js`), `tilde-${id}`);
    sources.push(source);
  }
  const held = new Set();
  const lease = async (id) => {
    await writeFile(join(store, "leases", `${id}.lock`), "");
    held.add(id);
  };
  const publish = (i) =>
    publishRelease(sources[i], store, {
      isHeld: (path) => held.has(path.split("/").at(-1).slice(0, 40)),
    });
  const meta = async () => JSON.parse(await readFile(join(store, "releases.json"), "utf8"));
  const chunk = (id) => join(store, "_next/static/chunks", `${id}.js`);
  return { root, store, sources, held, lease, publish, meta, chunk };
}

test("each image publishes itself; overlap serves both and restarts never rewind the head", async () => {
  const f = await fixture();
  try {
    await f.lease(ids[0]);
    await f.publish(0);
    await f.lease(ids[1]);
    await f.publish(1);
    assert.deepEqual((await f.meta()).releases, [ids[1], ids[0]]);
    // An old server sees the new server's chunk, and the reverse.
    assert.equal(await readFile(f.chunk(ids[0]), "utf8"), `window.revision='${ids[0]}';`);
    assert.equal(await readFile(f.chunk(ids[1]), "utf8"), `window.revision='${ids[1]}';`);
    await f.publish(0); // restarting A within the window
    assert.equal((await f.meta()).head, ids[1]);
    f.held.delete(ids[1]);
    await f.lease(ids[2]);
    await f.publish(2);
    f.held.delete(ids[2]);
    await f.lease(ids[3]);
    await f.publish(3);
    const meta = await f.meta();
    assert.deepEqual(meta.window, [ids[3], ids[2], ids[1]]);
    assert.ok(meta.releases.includes(ids[0]), "A still runs and keeps its lease");
    await access(f.chunk(ids[0]));
    f.held.delete(ids[0]);
    await f.publish(3);
    assert.ok(!(await f.meta()).releases.includes(ids[0]));
    await assert.rejects(access(f.chunk(ids[0])));
    await assert.rejects(access(join(f.store, "releases", ids[0])));
    await access(join(f.store, "_next/static/chunks/shared.js"));
    // A rollback to an expired release becomes the new head.
    await f.lease(ids[0]);
    await f.publish(0);
    assert.equal((await f.meta()).head, ids[0]);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("refuses missing leases, collisions, foreign bundle files, bad leases and symlinks", async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.publish(0), /Missing image lease/);
    await f.lease(ids[0]);
    await f.publish(0);
    await writeFile(
      join(f.store, "releases", ids[0], "_next/static/chunks", `${ids[0]}.js`),
      "changed",
    );
    await assert.rejects(f.publish(0), /Immutable release collision/);
    await writeFile(
      join(f.store, "releases", ids[0], "_next/static/chunks", `${ids[0]}.js`),
      `window.revision='${ids[0]}';`,
    );
    await writeFile(join(f.sources[1], "_next/static/chunks/shared.js"), "window.shared=2;");
    await f.lease(ids[1]);
    await assert.rejects(f.publish(1), /Immutable asset collision/);
    await writeFile(join(f.sources[1], "_next/static/chunks/shared.js"), "window.shared=1;");
    await writeFile(join(f.sources[1], "server-secret.txt"), "never published");
    await assert.rejects(f.publish(1), /Unexpected file/);
    await rm(join(f.sources[1], "server-secret.txt"));
    await writeFile(join(f.store, "leases", "unknown.lock"), "");
    await assert.rejects(f.publish(1), /Invalid lease/);
    await rm(join(f.store, "leases", "unknown.lock"));
    await symlink("/tmp", join(f.store, "escape"));
    await assert.rejects(f.publish(1), /Unsupported/);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("caps accumulated store bytes and drops window entries whose files are gone", async () => {
  const f = await fixture();
  try {
    await f.lease(ids[0]);
    await f.publish(0);
    f.held.delete(ids[0]);
    await rm(join(f.store, "releases", ids[0]), { recursive: true });
    await f.lease(ids[1]);
    await f.publish(1);
    assert.deepEqual((await f.meta()).releases, [ids[1]]);
    const oversized = join(f.store, "interrupted-publication");
    await writeFile(oversized, "");
    await truncate(oversized, 257 * 1024 * 1024);
    await assert.rejects(f.publish(1), /capacity/);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("old and new servers serve each other's chunks and refuse mismatched RSC", async () => {
  const f = await fixture();
  const servers = [];
  const start = async (id) => {
    const shared = handler(f.store, id);
    const server = createServer((req, res) => {
      if (shared(req, res)) return;
      res.setHeader("Content-Type", "text/html");
      res.end(`<meta name="build-sha" content="${id}">`);
    });
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    return `http://127.0.0.1:${server.address().port}`;
  };
  try {
    await f.lease(ids[0]);
    await f.publish(0);
    const a = await start(ids[0]);
    // Published after A started: Next's own startup file index would miss it.
    await f.lease(ids[1]);
    await f.publish(1);
    const b = await start(ids[1]);
    for (const server of [a, b]) {
      for (const id of [ids[0], ids[1]]) {
        const r = await fetch(`${server}/_next/static/chunks/${id}.js?dpl=${id}`);
        assert.equal(r.status, 200);
        assert.match(r.headers.get("content-type"), /javascript/);
        assert.match(r.headers.get("cache-control"), /immutable/);
        assert.equal(await r.text(), `window.revision='${id}';`);
      }
      assert.equal((await (await fetch(`${server}/releases.json`)).json()).head, ids[1]);
      assert.equal(
        (await fetch(`${server}/_next/static/%2e%2e%2f.store-identity.json`)).status,
        400,
      );
      assert.equal((await fetch(`${server}/_next/static/chunks/missing.js`)).status, 404);
      const tilde = await fetch(`${server}/_next/static/chunks/0${ids[1][0]}~tilde.js`);
      assert.equal(tilde.status, 200);
      assert.equal(await tilde.text(), `tilde-${ids[1]}`);
      assert.equal(
        (await fetch(`${server}/_next/static/chunks/x.js`, { method: "POST" })).status,
        405,
      );
    }
    for (const [server, foreign] of [
      [a, ids[1]],
      [b, ids[0]],
    ]) {
      const r = await fetch(`${server}/editor/?_rsc=x`, {
        headers: { RSC: "1", "x-deployment-id": foreign },
      });
      assert.equal(r.status, 409);
    }
    const own = await fetch(`${b}/editor/?_rsc=x`, {
      headers: { RSC: "1", "x-deployment-id": ids[1] },
    });
    assert.equal(own.status, 200);
    const bad = await fetch(`${b}/editor/?_rsc=x`, {
      headers: { RSC: "1", "x-deployment-id": "../x" },
    });
    assert.equal(bad.status, 400);
  } finally {
    for (const server of servers) {
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    }
    await rm(f.root, { recursive: true, force: true });
  }
});
