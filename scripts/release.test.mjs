import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { verifyRelease } from "./verify-release.mjs";
import { writeVersion } from "./write-version.mjs";

const SHA = "a".repeat(40);
const OLD_SHA = "b".repeat(40);
const ROOT = new URL("../", import.meta.url).pathname;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

test("the build writes an exact commit and rejects moving or abbreviated identities", () => {
  const directory = mkdtempSync(join(tmpdir(), "sprite-tools-version-"));
  try {
    writeVersion(SHA, directory);
    assert.deepEqual(JSON.parse(readFileSync(join(directory, "version.json"))), { commit: SHA });
    for (const invalid of [undefined, "", "latest", SHA.slice(0, 7), SHA.toUpperCase()]) {
      assert.throws(() => writeVersion(invalid, directory), /full lowercase Git commit SHA/);
    }
    assert.deepEqual(JSON.parse(readFileSync(join(directory, "version.json"))), { commit: SHA });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function fakeHttp({
  commits = [SHA],
  cache = "no-store",
  homepage = 200,
  htmlCommit = SHA,
  accounts = true,
  alias = 308,
  dropQuery = false,
} = {}) {
  let versions = 0;
  const requests = [];
  return {
    requests,
    fetch: async (url, options) => {
      requests.push({ url, options });
      const target = new URL(url);
      if (target.hostname !== "sprites.trebeljahr.com") {
        return new Response(null, {
          status: alias,
          headers: { location: `https://sprites.trebeljahr.com/${dropQuery ? "" : target.search}` },
        });
      }
      if (target.pathname === "/api/health/accounts") {
        return Response.json(
          { ready: accounts },
          { status: accounts ? 200 : 503, headers: { "cache-control": "no-store" } },
        );
      }
      if (target.pathname === "/version.json") {
        const commit = commits[Math.min(versions++, commits.length - 1)];
        return Response.json({ commit }, { headers: { "cache-control": cache } });
      }
      return new Response(
        `<html><head><meta name="build-commit" content="${htmlCommit}"/></head>sprite-tools</html>`,
        { status: homepage },
      );
    },
  };
}

const quick = { sleep: async () => {}, attempts: 5, stableSamples: 2 };

test("verification tolerates old/new overlap but restarts its stable sample window", async () => {
  const http = fakeHttp({ commits: [SHA, OLD_SHA, SHA, SHA] });
  assert.deepEqual(await verifyRelease(SHA, { ...quick, fetch: http.fetch }), {
    commit: SHA,
    samples: 2,
  });
  assert.equal(http.requests.filter(({ url }) => url.includes("/version.json")).length, 4);
  assert.equal(
    http.requests.filter(({ url }) => !url.startsWith("https://sprites.trebeljahr.com/")).length,
    0,
  );
  for (const { url, options } of http.requests) {
    assert.equal(options.method, "GET");
    assert.equal(options.redirect, "manual");
    assert.equal(options.cache, "no-store");
    assert.ok(new URL(url).searchParams.get("release"));
    assert.ok(options.signal instanceof AbortSignal);
  }
});

test("a queued or perpetually old release never passes HTTP verification", async () => {
  const http = fakeHttp({ commits: [OLD_SHA] });
  await assert.rejects(
    verifyRelease(SHA, { ...quick, fetch: http.fetch }),
    /not the expected commit/,
  );
});

test("cached version, broken homepage, and stale HTML each fail closed", async () => {
  for (const scenario of [
    { cache: "public, max-age=3600" },
    { homepage: 503 },
    { htmlCommit: OLD_SHA },
    { accounts: false },
  ]) {
    await assert.rejects(
      verifyRelease(SHA, { ...quick, fetch: fakeHttp(scenario).fetch }),
      /Release did not remain healthy/,
    );
  }
});

test("invalid release identity fails before making any request", async () => {
  const http = fakeHttp();
  await assert.rejects(verifyRelease("latest", { ...quick, fetch: http.fetch }), /full lowercase/);
  assert.equal(http.requests.length, 0);
});

test("network failures reset readiness and time out without mutations", async () => {
  let requests = 0;
  await assert.rejects(
    verifyRelease(SHA, {
      ...quick,
      fetch: async (_url, options) => {
        requests += 1;
        assert.equal(options.method, "GET");
        throw new Error("network unavailable");
      },
    }),
    /network unavailable/,
  );
  assert.equal(requests, quick.attempts);
});

test("preloaded server finishes in-flight work after the drain", {
  timeout: 10000,
}, async () => {
  const directory = mkdtempSync(join(tmpdir(), "sprite-tools-drain-"));
  const server = join(directory, "server.mjs");
  const wrapper = join(directory, "wrapper.mjs");
  const pidfile = join(directory, "drain.pid");
  writeFileSync(
    server,
    `
    import { createServer } from 'node:http';
    const server = createServer((request, response) => {
      if (request.url === '/slow') {
        response.writeHead(200);
        response.write('accepted\\n');
        setTimeout(() => response.end('completed\\n'), 1300);
      } else response.end('ok');
    });
    server.listen(0, '127.0.0.1', () => console.log('PORT=' + server.address().port));
    process.once('SIGTERM', () => server.close(() => process.exit(7)));
  `,
  );
  writeFileSync(
    wrapper,
    `
    import { spawn } from 'node:child_process';
    const child = spawn(process.execPath, ['--require', process.argv[2], process.argv[3]], { stdio: 'inherit' });
    process.on('SIGTERM', () => { child.kill('SIGKILL'); process.exit(99); });
    child.on('exit', code => process.exit(code ?? 98));
  `,
  );
  const child = spawn(
    "sh",
    [join(ROOT, "drain-entrypoint.sh"), process.execPath, wrapper, join(ROOT, "drain.cjs"), server],
    {
      env: {
        PATH: process.env.PATH,
        SHUTDOWN_DRAIN_SECONDS: "0.3",
        HEALTH_CHECK_PATH: "/api/health/accounts",
        HATCHKIT_DRAIN_PIDFILE: pidfile,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const exited = once(child, "exit");
  let output = "";
  child.stdout.on("data", (data) => {
    output += data;
  });
  child.stderr.on("data", (data) => {
    output += data;
  });
  try {
    for (let attempt = 0; !output.includes("PORT=") && attempt < 100; attempt += 1) await sleep(20);
    const port = output.match(/PORT=(\d+)/)?.[1];
    assert.ok(port, `Fixture did not start: ${output}`);
    const base = `http://127.0.0.1:${port}`;
    const options = { signal: AbortSignal.timeout(5000) };
    assert.equal((await fetch(`${base}/`, options)).status, 200);
    const accepted = await fetch(`${base}/slow`, options);
    const started = Date.now();
    child.kill("SIGTERM");
    await sleep(80);
    assert.equal((await fetch(`${base}/api/health/accounts?probe=1`, options)).status, 503);
    assert.equal((await fetch(`${base}/spritesheet`, options)).status, 200);
    assert.equal(await accepted.text(), "accepted\ncompleted\n");
    assert.ok(Date.now() - started > 900, "In-flight request must outlast the drain.");
    assert.deepEqual(
      await exited,
      [7, null],
      "App exit status must survive delayed signal delivery.",
    );
  } finally {
    try {
      process.kill(Number(readFileSync(pidfile, "utf8")), "SIGKILL");
    } catch {
      /* Fixture already stopped. */
    }
    child.kill("SIGKILL");
    await exited;
    rmSync(directory, { recursive: true, force: true });
  }
});
