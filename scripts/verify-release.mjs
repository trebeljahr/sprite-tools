import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ORIGIN = "https://sprites.trebeljahr.com";
const ALIASES = [];
const pause = (ms) => new Promise((done) => setTimeout(done, ms));

// This proves which build public HTTP serves. The deployment operator must
// also inspect Coolify's exact deployment and running container image digest.
export async function verifyRelease(
  commit,
  { fetch: request = fetch, sleep = pause, attempts = 90, stableSamples = 16 } = {},
) {
  if (!/^[a-f0-9]{40}$/.test(commit ?? "")) {
    throw new Error("Expected a full lowercase Git commit SHA.");
  }
  let consecutive = 0;
  let lastFailure = "No matching build observed.";
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const options = {
        method: "GET",
        redirect: "manual",
        cache: "no-store",
        headers: { "Cache-Control": "no-cache, no-store" },
        signal: AbortSignal.timeout(5000),
      };
      const nonce = `${commit}-${attempt}-${Date.now()}`;
      const version = await request(`${ORIGIN}/version.json?release=${nonce}`, options);
      if (version.status !== 200) throw new Error(`Version endpoint returned ${version.status}.`);
      if (!(version.headers.get("cache-control") ?? "").includes("no-store")) {
        throw new Error("Version endpoint must disable caching.");
      }
      if ((await version.json()).commit !== commit) {
        throw new Error("Public version is not the expected commit.");
      }
      const page = await request(`${ORIGIN}/?release=${nonce}`, {
        ...options,
        signal: AbortSignal.timeout(5000),
      });
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
      const health = await request(`${ORIGIN}/api/health/accounts?release=${nonce}`, {
        ...options,
        signal: AbortSignal.timeout(5000),
      });
      if (
        health.status !== 200 ||
        !(health.headers.get("cache-control") ?? "").includes("no-store") ||
        (await health.json()).ready !== true
      ) {
        throw new Error("Account database readiness failed.");
      }
      consecutive += 1;
      if (consecutive >= stableSamples) {
        for (const alias of ALIASES) {
          const response = await request(`${alias}/?release=${nonce}`, {
            ...options,
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
        return { commit, samples: consecutive };
      }
    } catch (error) {
      consecutive = 0;
      lastFailure = error instanceof Error ? error.message : "HTTP verification failed.";
    }
    if (attempt + 1 < attempts) await sleep(2000);
  }
  throw new Error(`Release did not remain healthy at ${commit}: ${lastFailure}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await verifyRelease(process.argv[2]);
    console.log(
      `Public release verified: ${result.commit} (${result.samples} consecutive samples).`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Release verification failed.");
    process.exitCode = 1;
  }
}
