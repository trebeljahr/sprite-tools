import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SHA = /^[a-f0-9]{40}$/;

// /releases.json tells open tabs which releases' browser files this upload
// still carries (src/components/release-notice.tsx). It is derived from the
// carry manifest that scripts/carry-static.mjs writes, own release first.
// The manifest may also hold a rebuild of this commit or a hand-seeded
// `<sha>-local` release; tabs only know full SHAs, so list each SHA once.
export function writeReleases(out) {
  const manifest = JSON.parse(readFileSync(join(out, "release-assets.json"), "utf8"));
  const ids = (manifest.releases ?? []).map((entry) => entry?.sha);
  const releases = [...new Set(ids.filter((id) => SHA.test(id ?? "")))];
  if (manifest.schema !== 1 || !SHA.test(ids[0] ?? "") || releases.length > 6) {
    throw new Error("release-assets.json does not list full-SHA releases.");
  }
  writeFileSync(join(out, "releases.json"), `${JSON.stringify({ schema: 2, releases })}\n`);
  return releases;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(`Releases served: ${writeReleases(process.argv[2] ?? "out").join(", ")}`);
}
