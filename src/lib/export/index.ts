// Public surface of the engine exporters.
//
// One import site for all three consumers (web page, CLI `export` command,
// MCP tool) so none of them has to know which file a format lives in. Every
// format module is a pure NormalizedDoc -> string / object function; the
// shared contract and the `normalizeExportInput` funnel live in `./types`.
//
// Browser-safe: nothing reachable from here touches `node:` or the filesystem.

export * from "./types";
export * from "./godot";
export * from "./unity";
export * from "./aseprite";
export * from "./phaser";
