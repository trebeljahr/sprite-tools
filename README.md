# sprite-tools

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

Requires Node 20+. No native dependencies.

```bash
git clone https://github.com/trebeljahr/sprite-tools.git
cd sprite-tools
npm install

# Build the CLI
npm run cli:build && npm link   # installs `sprite-tools` on PATH

# Build the MCP server
npm run mcp:build               # dist/mcp/index.js is executable

# Run the web app
npm run dev                     # http://localhost:3471
```

## MCP in Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "sprite-tools": { "command": "sprite-tools-mcp" }
  }
}
```

13 tools appear after a restart. See `docs/mcp/tools` in the running web app.

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

Run `npm run dev` and open `http://localhost:3471/docs`.

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

## License

MIT. See [LICENSE](./LICENSE).
