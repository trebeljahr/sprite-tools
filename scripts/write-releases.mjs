import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// /releases.json tells open tabs which releases' browser files this upload
// still carries (src/components/release-notice.tsx). It is derived from the
// carry manifest that scripts/carry-static.mjs writes, own release first.
export function writeReleases(out) {
  const manifest = JSON.parse(readFileSync(join(out, "release-assets.json"), "utf8"));
  const releases = (manifest.releases ?? []).map((entry) => entry?.sha);
  if (
    manifest.schema !== 1 ||
    releases.length < 1 ||
    releases.length > 6 ||
    !releases.every((id) => /^[a-f0-9]{40}$/.test(id ?? ""))
  ) {
    throw new Error("release-assets.json does not list full-SHA releases.");
  }
  writeFileSync(join(out, "releases.json"), `${JSON.stringify({ schema: 2, releases })}\n`);
  return releases;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(`Releases served: ${writeReleases(process.argv[2] ?? "out").join(", ")}`);
}
