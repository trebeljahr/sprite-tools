// Browser-side zlib inflate for .ase cel data, via DecompressionStream.
//
// Aseprite compresses cels with zlib (RFC1950 wrapper over RFC1951 deflate),
// which is DecompressionStream("deflate") — NOT "deflate-raw". Getting that
// wrong fails on the two-byte zlib header rather than decoding garbage, so it
// is at least a loud mistake, but it is still worth stating.
//
// This keeps the toolkit's dependency footprint unchanged: no pako, no fflate.
// The Node side uses node:zlib instead (inflate-node.ts) — neither module is
// imported by the core parser, which takes an Inflate function instead.

export async function inflateWeb(data: Uint8Array): Promise<Uint8Array> {
  const stream = new DecompressionStream("deflate");

  // Write without awaiting: the write only settles once the transform has
  // consumed it, so awaiting here before reading would deadlock on any input
  // bigger than the internal queue.
  //
  // Both promises reject when the stream errors on corrupt data. The caller
  // already sees that failure from reader.read() below, so swallow it here —
  // otherwise a corrupt .aseprite raises an *unhandled* rejection alongside the
  // error we do surface, which under Node's default --unhandled-rejections=throw
  // takes the process down.
  const writer = stream.writable.getWriter();
  writer.write(data as unknown as BufferSource).catch(() => {});
  writer.close().catch(() => {});

  const reader = stream.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.length;
    }
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
