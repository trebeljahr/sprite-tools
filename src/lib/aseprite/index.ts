// Public surface of the Aseprite reader.
//
// Browser-safe: everything re-exported here is DOM-free and Node-free. The
// `node:zlib` adapter lives in ./inflate-node and is imported directly by the
// CLI and MCP server, never from this barrel.

export * from "./types";
export { parseAseprite, isAsepriteFile } from "./parse";
export { blendModeFromId, blendInto } from "./blend";
export { compositeFrame, compositeFrames, type CompositeOptions } from "./composite";
export { inflateWeb } from "./inflate";

import { parseAseprite } from "./parse";
import { compositeFrames } from "./composite";
import type { AseCompositedFrame, AseDocument, ParseOptions } from "./types";

/**
 * Parse and composite in one call — what every surface (web, CLI, MCP) actually
 * wants. Keeping the two steps separately exported still allows layer-level
 * access for callers that want to extract individual layers as variants.
 */
export async function decodeAseprite(
  bytes: Uint8Array,
  opts: ParseOptions,
): Promise<{ doc: AseDocument; frames: AseCompositedFrame[] }> {
  const doc = await parseAseprite(bytes, opts);
  return { doc, frames: compositeFrames(doc) };
}
