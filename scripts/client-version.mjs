import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Picks the Worker version the client job uploaded for a commit, from
// `wrangler versions list --json`. Each upload is tagged with its full SHA.
export function clientVersion(commit, versions) {
  if (!/^[a-f0-9]{40}$/.test(commit ?? "")) {
    throw new Error("Expected a full lowercase Git commit SHA.");
  }
  if (!Array.isArray(versions)) throw new Error("Unexpected Worker version list.");
  const matches = versions.filter(
    (version) =>
      version?.annotations?.["workers/tag"] === commit && /^[0-9a-f-]{36}$/.test(version.id ?? ""),
  );
  if (matches.length === 0) throw new Error(`No client version was uploaded for ${commit}.`);
  matches.sort((a, b) =>
    String(b.metadata?.created_on ?? "").localeCompare(String(a.metadata?.created_on ?? "")),
  );
  return matches[0].id;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [commit, file] = process.argv.slice(2);
  try {
    const text = readFileSync(file, "utf8");
    console.log(clientVersion(commit, JSON.parse(text.slice(text.indexOf("[")))));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Client version lookup failed.");
    process.exitCode = 1;
  }
}
