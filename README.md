# sprite-tools

[![npm](https://img.shields.io/npm/v/@trebeljahr/sprite-tools.svg)](https://www.npmjs.com/package/@trebeljahr/sprite-tools)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](#license)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen.svg)](#install)

A batteries-included toolkit for turning AI-generated or hand-drawn sprites into **game-ready assets** — collision polygons, pivot anchors, animation tags, pixel-art conversion, normal maps, palette swap, atlas packing, GIF export.

Three surfaces, one shared pipeline:

- **Web app** — interactive browser-based tools (no backend, no upload).
- **CLI (`sprite-tools`)** — 13 composable subcommands. Pipe-friendly, JSON on stdout, `stdin` on `-`.
- **MCP server (`sprite-tools-mcp`)** — exposes every tool over [Model Context Protocol](https://modelcontextprotocol.io) so Claude Desktop (and any MCP client) can drive the pipeline directly.

All three surfaces call the same algorithm modules and emit the same JSON shapes. Mix them freely.

## Quick taste

```bash
# Auto-detect grid, generate collision polygons + pivots + tags in one shot
sprite-tools meta hero.png \
  --collision --tolerance 4 \
  --pivot bottom-center \
  --tag idle=0-3 \
  --tag run=4-7:12:pingpong \
  --tag attack=8-11 \
  -o hero.json

# Turn any sprite into Game Boy pixel art
sprite-tools pixelate hero.png --pixel-size 4 --palette gameboy --dither -o hero-gb.png

# Derive a normal map for 2D lighting
sprite-tools normal-map hero.png -o hero-normal.png

# Pack a folder of loose sprites into an atlas + TexturePacker manifest
sprite-tools atlas sprites/*.png -o atlas.png --json atlas.json

# Pipe stdin to stdout
cat hero.png | sprite-tools trim - -o - | sprite-tools collision -
```

## Install

Published on npm as **[`@trebeljahr/sprite-tools`](https://www.npmjs.com/package/@trebeljahr/sprite-tools)**. One install ships both the `sprite-tools` CLI and the `sprite-tools-mcp` server.

```bash
# Global install — both binaries on your PATH
npm install -g @trebeljahr/sprite-tools

# Or run any command one-off without installing
npx @trebeljahr/sprite-tools meta hero.png --collision -o hero.json
```

Requires **Node 20+**. No native dependencies — PNG I/O is pure JS, so it installs portably with no `node-gyp` step. Full install options (pnpm, MCP client config, building from source) on the [Install docs page](https://github.com/trebeljahr/sprite-tools#install).

## MCP in Claude Desktop

Add to `claude_desktop_config.json` (macOS path: `~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "sprite-tools": { "command": "sprite-tools-mcp" }
  }
}
```

Restart Claude Desktop — 13 tools appear under the MCP menu. If `sprite-tools-mcp` isn't on the PATH Claude sees (common with `nvm`/`fnm`), set `command` to the absolute path printed by `which sprite-tools-mcp`.

## What's in the box

**Web app**: `/overview` (metadata composited on your sheet), `/collision`, `/pivot`, `/tags`, `/pixelate`, `/normal-map`, `/palette`, `/atlas`, `/gif`, plus the existing `/generate`, `/spritesheet` (Stitch), `/lasso`, `/` (Animate).

**CLI**: `info`, `detect`, `slice`, `trim`, `collision`, `pivot`, `tags`, `meta`, `palette`, `pixelate`, `normal-map`, `atlas`, `gif`.

**MCP**: same 13 tools with typed Zod input schemas.

## Docs

Full docs live in the app at `/docs`. Highlights:

- **Quickstart** — 5 minutes end-to-end.
- **CLI reference** — every flag + output shape.
- **JSON schemas** — the canonical data contract shared across all surfaces.
- **Algorithm notes** — how grid detection / contour tracing / bin packing work.
- **Contributing** — how to add a new tool.

Or run the app locally: `pnpm install && pnpm dev`, then open `http://localhost:3471/docs`.

## Architecture

```
src/lib/**             # pure algorithm modules (ImageData in, JSON/ImageData out)
cli/commands/**        # CLI wrappers via commander + pngjs
mcp/tools.ts           # MCP server (Zod schemas)
src/app/**/page.tsx    # web app routes
src/app/docs/**        # MDX docs
tests/**.test.ts       # vitest on every algorithm
```

Every tool has the same **shape**: a pure function, a CLI wrapper, an MCP tool, a React page. Adding new functionality means mirroring that pattern once.

## Development

```bash
git clone https://github.com/trebeljahr/sprite-tools.git
cd sprite-tools
pnpm install

# Web app (Next.js)
pnpm dev                # http://localhost:3471

# CLI / MCP — run uncompiled against TS source
pnpm cli:dev -- detect my-sheet.png
pnpm mcp:dev

# CLI / MCP — build, then symlink as global commands
pnpm install-local      # cli:build + mcp:build + npm install -g .

# Tests / typecheck / lint
pnpm test
pnpm typecheck
pnpm lint
```

## Releasing

`@trebeljahr/sprite-tools` ships from the repo root. The published tarball is scoped via the `files` field in `package.json` and contains `dist/cli/`, `dist/mcp/`, the compiled `dist/src/lib/` algorithm modules, the README, and the LICENSE — none of the Next.js app code or its dependencies.

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

## License

MIT. See [LICENSE](./LICENSE).
