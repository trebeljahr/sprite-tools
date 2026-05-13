# Contributing to sprite-tools

Thanks for helping improve sprite-tools. The project is built around one rule: every tool should share one tested algorithm core across the web app, CLI, and MCP server.

## Good first contributions

- Fix unclear docs, typos, or missing examples.
- Add focused tests around an existing algorithm.
- Improve CLI help text or MCP input descriptions.
- Add a small export format or option that maps cleanly across all surfaces.

Large new tools are welcome, but please open an issue first so the shape can be discussed before code is written.

## Local setup

```bash
pnpm install
pnpm dev
pnpm test
pnpm typecheck
pnpm lint
```

Useful development commands:

```bash
pnpm cli:dev -- info ./sprite.png
pnpm mcp:dev
pnpm cli:build
pnpm mcp:build
```

## Repository layout

```text
src/lib/**             pure algorithm modules
cli/commands/**        CLI wrappers
mcp/tools.ts           MCP tool registration and schemas
src/app/**             Next.js web app and docs
tests/**               Vitest coverage for algorithms
```

## Pull request checklist

- Keep the change focused.
- Add or update tests when behavior changes.
- Update README or docs for user-facing changes.
- Run `pnpm test`, `pnpm typecheck`, and `pnpm lint`.
- For CLI or MCP changes, run the relevant build command.

## Design notes

- Keep algorithm modules pure. They should accept `ImageData` plus options and return data or `ImageData`.
- Keep JSON output stable across web, CLI, and MCP.
- Prefer explicit option names over clever shortcuts.
- Avoid browser-only or Node-only globals inside `src/lib/**`.

## Release process

Releases are maintainer-only and publish `@trebeljahr/sprite-tools` to npm. The release scripts validate the working tree, bump the version, tag the commit, build the CLI and MCP outputs, typecheck, publish, and push the tag.

