import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Built into public/, never read from a runtime environment that can drift
// from the image actually serving the request.
export function writeVersion(commit, directory = "public") {
  if (!/^[a-f0-9]{40}$/.test(commit ?? "")) {
    throw new Error("DEPLOYMENT_ID must be a full lowercase Git commit SHA.");
  }
  mkdirSync(directory, { recursive: true });
  writeFileSync(resolve(directory, "version.json"), `${JSON.stringify({ commit })}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  writeVersion(process.env.NEXT_DEPLOYMENT_ID, process.argv[2]);
}
