// CLI/MCP self-version lookup.
//
// Walks up from this file's directory until it finds @trebeljahr/sprite-tools'
// own package.json. Works from all three callsites with the same code:
//   - tsx dev path:   <repo>/cli/lib/version.ts            → <repo>/package.json
//   - compiled:       <repo>/dist/cli/lib/version.js       → <repo>/package.json
//   - npm-installed:  .../sprite-tools/dist/cli/lib/...    → .../sprite-tools/package.json
//
// Returns "0.0.0" on any failure so callers can splat it into version
// strings without try/catching.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const PACKAGE_NAME = "@trebeljahr/sprite-tools";

export function getCliVersion(): string {
  try {
    let dir = __dirname;
    while (dir !== dirname(dir)) {
      const candidate = join(dir, "package.json");
      if (existsSync(candidate)) {
        const pkg = JSON.parse(readFileSync(candidate, "utf-8"));
        if (pkg.name === PACKAGE_NAME) return pkg.version ?? "0.0.0";
      }
      dir = dirname(dir);
    }
  } catch {
    // Fall through to default.
  }
  return "0.0.0";
}
