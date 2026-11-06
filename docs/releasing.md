# Releasing the npm package

Maintainer-only. Moved out of the README on 2026-11-06. The steps are unchanged; the tarball contents below were re-checked against `package.json`.

`@trebeljahr/sprite-tools` ships from the repo root. The published tarball is scoped via the `files` field in `package.json` and contains `dist/cli/`, `dist/mcp/`, the compiled `dist/src/lib/` algorithm modules, the static web app export in `out/`, `plugin.json`, `mcp.json`, the README, and the LICENSE. It carries no Next.js source and no app dependencies, and nothing from `packages/server`.

```bash
pnpm release           # patch bump (default)
pnpm release:minor
pnpm release:major
```

Each command runs in this order:

1. **`release-prep`** — refuses to release if the working tree is dirty or if the local version is behind what's already on npm.
2. **`release-bump`** — bumps `package.json`, commits, and tags atomically.
3. **`_release:finish`** — builds the CLI + MCP, typechecks, `npm publish`es, and pushes the tag.

`prepublishOnly` re-runs the CLI + MCP builds as a final safety net before npm uploads the tarball.

As of 2026-11-06 the package has not been published: `npm view @trebeljahr/sprite-tools` returns 404.
