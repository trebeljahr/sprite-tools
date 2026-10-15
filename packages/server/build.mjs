// Bundles the server into dist/ so the image needs no node_modules: the
// workspace resolves Better Auth's optional Next/React peers from the web app,
// and a pnpm-deployed closure would carry them. pg-native is pg's optional
// native binding, which this server never enables.
import { rmSync } from "node:fs";
import { build } from "esbuild";

rmSync("dist", { recursive: true, force: true });

await build({
  entryPoints: {
    index: "src/index.ts",
    "migrate-cli": "src/migrate-cli.ts",
    "account-credit": "scripts/account-credit.mjs",
  },
  outdir: "dist",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  external: ["pg-native"],
  // CommonJS dependencies call require(); give the ESM bundle one.
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
  legalComments: "none",
  logLevel: "warning",
});
