/** Reject oversized/ZIP64 projects before a ZIP library decompresses any entry. */
export function checkCharacterZip(bytes: Uint8Array): void {
  if (bytes.length > 64 * 1024 * 1024) throw new Error("Character ZIP exceeds 64 MB.");
  const d = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let p = bytes.length - 22; p >= Math.max(0, bytes.length - 65557); p--)
    if (d.getUint32(p, true) === 0x06054b50) {
      end = p;
      break;
    }
  if (end < 0) throw new Error("Invalid character ZIP.");
  const count = d.getUint16(end + 10, true),
    size = d.getUint32(end + 12, true),
    start = d.getUint32(end + 16, true);
  if (
    count > 256 ||
    count === 65535 ||
    size === 0xffffffff ||
    start === 0xffffffff ||
    start + size > end
  )
    throw new Error("Unsupported or oversized character ZIP.");
  if (
    d.getUint16(end + 4, true) !== 0 ||
    d.getUint16(end + 6, true) !== 0 ||
    d.getUint16(end + 8, true) !== count
  )
    throw new Error("Multipart ZIPs are unsupported.");
  let pos = start,
    total = 0;
  for (let i = 0; i < count; i++) {
    if (pos + 46 > start + size || d.getUint32(pos, true) !== 0x02014b50)
      throw new Error("Invalid ZIP directory.");
    const expanded = d.getUint32(pos + 24, true),
      nameLength = d.getUint16(pos + 28, true),
      extra = d.getUint16(pos + 30, true),
      comment = d.getUint16(pos + 32, true);
    total += expanded;
    if (expanded > 20 * 1024 * 1024 || total > 192 * 1024 * 1024)
      throw new Error("Expanded character ZIP exceeds its size limit.");
    pos += 46 + nameLength + extra + comment;
    if (pos > start + size) throw new Error("Invalid ZIP entry.");
  }
  if (pos !== start + size) throw new Error("Invalid ZIP directory size.");
}

/** JSZip's streaming API lets us bound actual inflated bytes, including lying ZIP headers. */
export function readCharacterZipFile(file: unknown, limit: number): Promise<Uint8Array> {
  interface Stream {
    on(name: string, fn: (value: Uint8Array) => void): Stream;
    pause(): void;
    resume(): void;
  }
  const entry = file as { internalStream?: (type: string) => Stream };
  if (typeof entry?.internalStream !== "function")
    return Promise.reject(new Error("Missing ZIP file."));
  return new Promise((resolve, reject) => {
    const stream = entry.internalStream!("uint8array"),
      chunks: Uint8Array[] = [];
    let total = 0,
      failed = false;
    stream
      .on("data", (chunk) => {
        if (failed) return;
        total += chunk.length;
        if (total > limit) {
          failed = true;
          stream.pause();
          reject(new Error("Expanded ZIP file exceeds its size limit."));
          return;
        }
        chunks.push(chunk);
      })
      .on("error", () => {
        if (!failed) {
          failed = true;
          reject(new Error("ZIP file could not be decompressed."));
        }
      })
      .on("end", () => {
        if (failed) return;
        const out = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          out.set(chunk, offset);
          offset += chunk.length;
        }
        resolve(out);
      })
      .resume();
  });
}
