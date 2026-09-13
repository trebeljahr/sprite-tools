// Node-side zlib inflate for .ase cel data.
//
// Deliberately NOT re-exported from index.ts: that barrel is what the browser
// bundle imports, and pulling `node:zlib` into a client graph breaks the
// Turbopack build. CLI and MCP import this module directly.

import { inflateSync } from "node:zlib";

export function inflateNode(data: Uint8Array): Uint8Array {
  const out = inflateSync(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
  return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
}
