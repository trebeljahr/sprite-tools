import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ORIGIN = "https://sprites.trebeljahr.com";
const ALIASES = [];
const pause = (ms) => new Promise((done) => setTimeout(done, ms));

// The last images that served the whole Next app, pages and /api together.
// They have no /api/health, so a release that replaces one can check only
// account readiness for its baseline. Remove an entry once no rollback can
// return to it.
export const LEGACY_NEXT_RELEASES = new Set(["9bddc3f7014e122c433a6e443f6d83c0291bf726"]);

// This proves which build public HTTP serves. The deployment operator must
// also inspect Coolify's exact deployment and running container image digest.
// A server release needs three to four minutes before only the new build
// answers: image pull, 15s start period, then the old container's 20s drain.
// The wait is therefore nine minutes, bounded by time so slow requests cannot
// extend it.
async function sampled(
  commit,
  check,
  {
    fetch: request = fetch,
    sleep = pause,
    now = Date.now,
    attempts = 240,
    budgetMs = 540000,
    stableSamples = 16,
  } = {},
) {
  if (!/^[a-f0-9]{40}$/.test(commit ?? "")) {
    throw new Error("Expected a full lowercase Git commit SHA.");
  }
  let consecutive = 0;
  let lastFailure = "No matching build observed.";
  const started = now();
  for (let attempt = 0; attempt < attempts && now() - started < budgetMs; attempt += 1) {
    try {
      const nonce = `${commit}-${attempt}-${Date.now()}`;
      const get = (path) =>
        request(`${ORIGIN}${path}${path.includes("?") ? "&" : "?"}release=${nonce}`, {
          method: "GET",
          redirect: "manual",
          cache: "no-store",
          headers: { "Cache-Control": "no-cache, no-store" },
          signal: AbortSignal.timeout(5000),
        });
      await check(get, nonce);
      consecutive += 1;
      if (consecutive >= stableSamples) return { commit, samples: consecutive };
    } catch (error) {
      consecutive = 0;
      lastFailure = error instanceof Error ? error.message : "HTTP verification failed.";
    }
    if (attempt + 1 < attempts) await sleep(2000);
  }
  throw new Error(`Release did not remain healthy at ${commit}: ${lastFailure}`);
}

const uncached = (response) => (response.headers.get("cache-control") ?? "").includes("no-store");

/**
 * The accounts server (Coolify) on /api: /api/health names the commit its
 * image was built from and reports the account database ready. `legacy`
 * accepts a pre-split Next image, which can only report readiness.
 */
export function verifyServer(commit, { legacy = false, ...options } = {}) {
  return sampled(
    commit,
    async (get) => {
      const path = legacy ? "/api/health/accounts" : "/api/health";
      const health = await get(path);
      const body = health.status === 200 && uncached(health) ? await health.json() : {};
      if (body.ready !== true) throw new Error("Account database readiness failed.");
      if (!legacy && body.version !== commit) {
        throw new Error("Accounts server is not the expected commit.");
      }
    },
    options,
  );
}

/** The static client (Cloudflare Worker): uncached version.json and the homepage build. */
export function verifyClient(commit, options = {}) {
  return sampled(
    commit,
    async (get, nonce) => {
      const version = await get("/version.json");
      if (version.status !== 200) throw new Error(`Version endpoint returned ${version.status}.`);
      if (!uncached(version)) throw new Error("Version endpoint must disable caching.");
      if ((await version.json()).commit !== commit) {
        throw new Error("Public version is not the expected commit.");
      }
      const page = await get("/");
      const html = await page.text();
      if (page.status !== 200 || !html.includes("sprite-tools")) {
        throw new Error("The canonical homepage did not serve the application.");
      }
      const pageCommits = [
        ...html.matchAll(
          /<meta\b(?=[^>]*\bname=["']build-commit["'])(?=[^>]*\bcontent=["']([a-f0-9]{40})["'])[^>]*>/gi,
        ),
      ];
      if (pageCommits.length !== 1 || pageCommits[0][1] !== commit) {
        throw new Error("Homepage HTML is not the expected build.");
      }
      for (const alias of ALIASES) {
        const request = options.fetch ?? fetch;
        const response = await request(`${alias}/?release=${nonce}`, {
          method: "GET",
          redirect: "manual",
          cache: "no-store",
          signal: AbortSignal.timeout(5000),
        });
        await response.body?.cancel();
        const location = response.headers.get("location");
        const destination = location ? new URL(location, alias) : null;
        if (
          ![301, 308].includes(response.status) ||
          destination?.origin !== ORIGIN ||
          destination.pathname !== "/" ||
          destination.search !== `?release=${nonce}`
        ) {
          throw new Error(`Canonical redirect failed for ${alias}.`);
        }
      }
    },
    options,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [commit, part = "all"] = process.argv.slice(2);
  try {
    if (!["server", "client", "all"].includes(part))
      throw new Error("Part: server, client or all.");
    if (part !== "client") {
      const result = await verifyServer(commit);
      console.log(`Accounts server verified: ${result.commit} (${result.samples} samples).`);
    }
    if (part !== "server") {
      const result = await verifyClient(commit);
      console.log(`Static client verified: ${result.commit} (${result.samples} samples).`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Release verification failed.");
    process.exitCode = 1;
  }
}
