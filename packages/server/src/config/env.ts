import { existsSync } from "node:fs";
import { config } from "@dotenvx/dotenvx";

/**
 * Load the committed, dotenvx-encrypted `.env.production` into process.env,
 * when it is present: a production run on a laptop (`migrate-cli` against the
 * live database, say), with the private key from `.env.keys`.
 *
 * The deployed image does not carry the file. Coolify's environment is the
 * runtime source, filled by `hatchkit sync` from this file, so in the
 * container this is a no-op. Values already in the environment win, as with
 * `dotenvx run`.
 */
export function loadEnvironment(file = ".env.production") {
  if (process.env.NODE_ENV !== "production" || !existsSync(file)) return;
  config({ path: file, quiet: true });
}

export function commitSha() {
  const value = process.env.COMMIT_SHA ?? "";
  return /^[a-f0-9]{40}$/.test(value) ? value : "";
}
