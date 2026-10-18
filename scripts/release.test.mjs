import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { clientVersion } from "./client-version.mjs";
import { verifyClient, verifyServer } from "./verify-release.mjs";
import { writeReleases } from "./write-releases.mjs";
import { writeVersion } from "./write-version.mjs";

const SHA = "a".repeat(40);
const OLD_SHA = "b".repeat(40);

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
  serverCommits = [SHA],
  cache = "no-store",
  healthCache = "no-store",
  homepage = 200,
  htmlCommit = SHA,
  accounts = true,
} = {}) {
  let versions = 0;
  let healths = 0;
  const requests = [];
  return {
    requests,
    fetch: async (url, options) => {
      requests.push({ url, options });
      const target = new URL(url);
      if (target.pathname === "/api/health") {
        const version = serverCommits[Math.min(healths++, serverCommits.length - 1)];
        return Response.json(
          { ready: accounts, version },
          { status: accounts ? 200 : 503, headers: { "cache-control": healthCache } },
        );
      }
      if (target.pathname === "/api/health/accounts") {
        return Response.json(
          { ready: accounts },
          { status: accounts ? 200 : 503, headers: { "cache-control": healthCache } },
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
const paths = (http) => http.requests.map(({ url }) => new URL(url).pathname);

test("verification tolerates old/new overlap but restarts its stable sample window", async () => {
  const client = fakeHttp({ commits: [SHA, OLD_SHA, SHA, SHA] });
  assert.deepEqual(await verifyClient(SHA, { ...quick, fetch: client.fetch }), {
    commit: SHA,
    samples: 2,
  });
  assert.equal(paths(client).filter((path) => path === "/version.json").length, 4);
  const server = fakeHttp({ serverCommits: [SHA, OLD_SHA, SHA, SHA] });
  assert.deepEqual(await verifyServer(SHA, { ...quick, fetch: server.fetch }), {
    commit: SHA,
    samples: 2,
  });
  assert.deepEqual(new Set(paths(server)), new Set(["/api/health"]));
  for (const { url, options } of [...client.requests, ...server.requests]) {
    assert.ok(url.startsWith("https://sprites.trebeljahr.com/"));
    assert.equal(options.method, "GET");
    assert.equal(options.redirect, "manual");
    assert.equal(options.cache, "no-store");
    assert.ok(new URL(url).searchParams.get("release"));
    assert.ok(options.signal instanceof AbortSignal);
  }
});

test("a queued or perpetually old release never passes HTTP verification", async () => {
  await assert.rejects(
    verifyClient(SHA, { ...quick, fetch: fakeHttp({ commits: [OLD_SHA] }).fetch }),
    /not the expected commit/,
  );
  await assert.rejects(
    verifyServer(SHA, { ...quick, fetch: fakeHttp({ serverCommits: [OLD_SHA] }).fetch }),
    /not the expected commit/,
  );
});

test("cached responses, broken pages, stale HTML and unready accounts each fail closed", async () => {
  for (const scenario of [
    { cache: "public, max-age=3600" },
    { homepage: 503 },
    { htmlCommit: OLD_SHA },
  ]) {
    await assert.rejects(
      verifyClient(SHA, { ...quick, fetch: fakeHttp(scenario).fetch }),
      /Release did not remain healthy/,
    );
  }
  for (const scenario of [{ accounts: false }, { healthCache: "public, max-age=60" }]) {
    await assert.rejects(
      verifyServer(SHA, { ...quick, fetch: fakeHttp(scenario).fetch }),
      /readiness failed/,
    );
  }
});

test("invalid release identity fails before making any request", async () => {
  const http = fakeHttp();
  await assert.rejects(verifyClient("latest", { ...quick, fetch: http.fetch }), /full lowercase/);
  await assert.rejects(
    verifyServer(SHA.slice(0, 7), { ...quick, fetch: http.fetch }),
    /full lowercase/,
  );
  assert.equal(http.requests.length, 0);
});

test("network failures reset readiness and time out without mutations", async () => {
  let requests = 0;
  await assert.rejects(
    verifyServer(SHA, {
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

test("verification stops at its time budget when requests are slow", async () => {
  let clock = 0;
  const http = fakeHttp({ commits: [OLD_SHA] });
  await assert.rejects(
    verifyClient(SHA, {
      fetch: http.fetch,
      sleep: async () => {
        clock += 60000;
      },
      now: () => clock,
    }),
    /not the expected commit/,
  );
  assert.equal(http.requests.length, 9);
});

test("the client release list follows the carry manifest, own release first", () => {
  const directory = mkdtempSync(join(tmpdir(), "sprite-tools-releases-"));
  try {
    const manifest = (releases) =>
      writeFileSync(
        join(directory, "release-assets.json"),
        JSON.stringify({ schema: 1, releases: releases.map((sha) => ({ sha, files: [] })) }),
      );
    manifest([SHA, OLD_SHA]);
    assert.deepEqual(writeReleases(directory), [SHA, OLD_SHA]);
    assert.deepEqual(JSON.parse(readFileSync(join(directory, "releases.json"))), {
      schema: 2,
      releases: [SHA, OLD_SHA],
    });
    manifest([SHA, SHA, `${OLD_SHA}-local`, OLD_SHA]);
    assert.deepEqual(writeReleases(directory), [SHA, OLD_SHA]);
    for (const invalid of [[], ["latest"], [SHA.slice(0, 7)], [`${SHA}-local`]]) {
      manifest(invalid);
      assert.throws(() => writeReleases(directory), /full-SHA releases/);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the deploy job activates only the version uploaded for its commit", () => {
  const version = (id, tag, created) => ({
    id,
    annotations: { "workers/tag": tag },
    metadata: { created_on: created },
  });
  const first = "11111111-1111-4111-8111-111111111111";
  const retry = "22222222-2222-4222-8222-222222222222";
  const other = "33333333-3333-4333-8333-333333333333";
  const list = [
    version(first, SHA, "2026-10-15T10:00:00Z"),
    version(other, OLD_SHA, "2026-10-15T11:00:00Z"),
    version(retry, SHA, "2026-10-15T12:00:00Z"),
  ];
  assert.equal(clientVersion(SHA, list), retry);
  assert.throws(() => clientVersion("c".repeat(40), list), /No client version/);
  assert.throws(() => clientVersion("latest", list), /full lowercase/);
});
