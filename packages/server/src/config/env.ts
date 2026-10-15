import { existsSync } from "node:fs";
import { config } from "@dotenvx/dotenvx";

/**
 * Load the committed, dotenvx-encrypted `.env.production` into process.env.
 *
 * The image carries the encrypted file and Coolify supplies its private key
 * (DOTENV_PRIVATE_KEY_PRODUCTION) together with the plain runtime variables.
 * Values already in the environment win, as with `dotenvx run`. Loading here
 * instead of wrapping the process in `dotenvx run` keeps Node as the process
 * that receives `docker stop`'s SIGTERM, so the shutdown drain works without
 * a signal-forwarding entrypoint.
 */
export function loadEnvironment(file = ".env.production") {
  if (process.env.NODE_ENV !== "production" || !existsSync(file)) return;
  config({ path: file, quiet: true });
}

export function commitSha() {
  const value = process.env.COMMIT_SHA ?? "";
  return /^[a-f0-9]{40}$/.test(value) ? value : "";
}
