// .ase / .aseprite chunk decoder.
//
// Pure and DOM-free: zlib arrives as the injected `inflate` from ParseOptions,
// so the same code serves the browser bundle (DecompressionStream) and the
// CLI/MCP CommonJS builds (node:zlib). Decoded per the official format spec
// (aseprite/aseprite docs/ase-file-specs.md).
//
// Two structural facts drive most of the code below:
//
//   1. A chunk's declared size is SELF-INCLUSIVE — it covers the size DWORD and
//      the type WORD. So the payload is `chunkSize - 6`, and the next chunk
//      always starts at `chunkStart + chunkSize`. We compute that boundary
//      before touching the payload and advance by it unconditionally, which is
//      what makes an unknown or malformed chunk survivable instead of fatal.
//   2. Several repeated records embed a variable-length STRING mid-record
//      (palette entry names, tag names). Their stride is therefore not fixed,
//      and hand-rolled per-field offsets get it wrong on the second element.
//      Everything goes through a self-advancing cursor for that reason.
//
// Pixel decode is deferred to a pass after the whole file is walked: it needs
// the palette (for indexed files) and the layer's background flag, and nothing
// in the spec guarantees those chunks precede the cels that depend on them.
//
// Palettes are per frame. Aseprite keeps a palette list keyed by frame and a
// frame uses the most recent palette at or before it (Sprite::palette(frame)),
// so a palette chunk in frame 5 recolours frame 5 onward, never frames 0-4.

import { blendModeFromId } from "./blend";
import type {
  AseBlendMode,
  AseCel,
  AseColor,
  AseColorDepth,
  AseDocument,
  AseFrameInfo,
  AseLayer,
  AseLayerType,
  AseTag,
  AseTagDirection,
  Inflate,
  ParseOptions,
} from "./types";

const ASE_MAGIC = 0xa5e0;
const FRAME_MAGIC = 0xf1fa;
const HEADER_SIZE = 128;
const FRAME_HEADER_SIZE = 16;
const CHUNK_HEADER_SIZE = 6;

/** Tag loop directions 0..3. Id 3 exists and is routinely dropped by readers. */
const TAG_DIRECTIONS: readonly AseTagDirection[] = [
  "forward",
  "reverse",
  "pingpong",
  "pingpong-reverse",
];

const UTF8 = new TextDecoder();

/**
 * Ceiling on palette entries. Both the declared palette size and the entry
 * range in a 0x2019 chunk are untrusted DWORDs that we grow an array to reach,
 * so a corrupt (or hostile) file can otherwise ask for four billion entries and
 * wedge the tab before a single pixel is decoded. Aseprite's own palettes top
 * out at 256 — indices are a BYTE in indexed images — so this is orders of
 * magnitude past anything real while still being bounded.
 */
const MAX_PALETTE_ENTRIES = 0x10000;

function hex(value: number, digits: number): string {
  return `0x${value.toString(16).padStart(digits, "0")}`;
}

function rgbHex(r: number, g: number, b: number): string {
  const two = (v: number) => v.toString(16).padStart(2, "0");
  return `#${two(r)}${two(g)}${two(b)}`;
}

/**
 * Thrown when a read inside a chunk would cross that chunk's declared end.
 * Caught per chunk and turned into a warning: the outer walk already knows
 * where the next chunk starts, so an over-long record is a damaged chunk, not a
 * damaged file.
 */
class ChunkOverrunError extends Error {}

/**
 * Sequential little-endian reader over one chunk's payload.
 *
 * Every read advances `p`, which is the whole point: records with embedded
 * STRINGs cannot be addressed by fixed offsets, and mixing the two styles is
 * how palettes and tag lists end up decoding garbage after the first entry.
 *
 * Reads are bounded by `limit` (the chunk end), not by the buffer. A record
 * loop only checks that a record *starts* inside its chunk; bounding every read
 * is what stops a record that starts there from finishing inside the next
 * chunk and silently taking that chunk's bytes as its fields.
 */
class Cursor {
  p: number;

  constructor(
    private readonly bytes: Uint8Array,
    private readonly view: DataView,
    start: number,
    readonly limit: number,
  ) {
    this.p = start;
  }

  /** Bytes left before the chunk end. */
  get remaining(): number {
    return this.limit - this.p;
  }

  private need(n: number, what: string): void {
    if (this.p + n > this.limit) {
      throw new ChunkOverrunError(
        `needed ${n} byte(s) for ${what} at offset ${this.p}, only ${this.limit - this.p} remain`,
      );
    }
  }

  u8(): number {
    this.need(1, "BYTE");
    return this.bytes[this.p++];
  }

  u16(): number {
    this.need(2, "WORD");
    const v = this.view.getUint16(this.p, true);
    this.p += 2;
    return v;
  }

  i16(): number {
    this.need(2, "SHORT");
    const v = this.view.getInt16(this.p, true);
    this.p += 2;
    return v;
  }

  u32(): number {
    this.need(4, "DWORD");
    const v = this.view.getUint32(this.p, true);
    this.p += 4;
    return v;
  }

  skip(n: number): void {
    this.need(n, `${n} reserved byte(s)`);
    this.p += n;
  }

  /** STRING: WORD byte length then UTF-8 bytes, with no trailing NUL. */
  str(): string {
    const length = this.u16();
    this.need(length, "STRING body");
    const value = UTF8.decode(this.bytes.subarray(this.p, this.p + length));
    this.p += length;
    return value;
  }

  /** A view (not a copy) of the next n bytes. */
  take(n: number): Uint8Array {
    this.need(n, `${n} payload byte(s)`);
    const view = this.bytes.subarray(this.p, this.p + n);
    this.p += n;
    return view;
  }
}

/** A cel captured during the walk, before palette/layer-dependent decoding. */
type RawCel = {
  frameIndex: number;
  layerIndex: number;
  x: number;
  y: number;
  opacity: number;
  zIndex: number;
} & (
  | { kind: "image"; width: number; height: number; raw: Uint8Array }
  | { kind: "link"; sourceFrame: number }
);

interface DecodeState {
  headerFlags: number;
  colorDepth: AseColorDepth;
  transparentIndex: number;
  inflate: Inflate;
  layers: AseLayer[];
  rawCels: RawCel[];
  tags: AseTag[];
  /** The palette as of the chunk being read. Mutate only via writablePalette(). */
  palette: AseColor[];
  /**
   * True once `palette` has been handed to a finished frame in `framePalettes`.
   * The next palette chunk then copies before writing, so frames share one
   * array until the palette actually changes instead of cloning it per frame.
   */
  paletteShared: boolean;
  /** framePalettes[f] is the palette in effect at frame f. */
  framePalettes: AseColor[][];
  /** Once a 0x2019 chunk lands, the deprecated 0x0004 / 0x000B / 0x0011 chunks lose. */
  hasNewPalette: boolean;
  /** Most recent layer index seen at each child level, for parent resolution. */
  levelStack: number[];
  /** Cursor into `tags` while user data chunks trail a Tags chunk; -1 when not. */
  tagUserDataCursor: number;
  warnings: string[];
  warnOnce: (key: string, message: string) => void;
}

export function isAsepriteFile(bytes: Uint8Array): boolean {
  if (bytes.length < HEADER_SIZE) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return view.getUint16(4, true) === ASE_MAGIC;
}

export async function parseAseprite(bytes: Uint8Array, opts: ParseOptions): Promise<AseDocument> {
  if (bytes.length < HEADER_SIZE) {
    throw new Error(
      `Not an Aseprite file: expected at least a ${HEADER_SIZE}-byte header, got ${bytes.length} bytes`,
    );
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = view.getUint16(4, true);
  if (magic !== ASE_MAGIC) {
    throw new Error(
      `Not an Aseprite file: header magic is ${hex(magic, 4)}, expected ${hex(ASE_MAGIC, 4)}`,
    );
  }

  const frameCount = view.getUint16(6, true);
  const width = view.getUint16(8, true);
  const height = view.getUint16(10, true);
  const rawDepth = view.getUint16(12, true);
  if (rawDepth !== 32 && rawDepth !== 16 && rawDepth !== 8) {
    throw new Error(
      `Unsupported Aseprite colour depth ${rawDepth}: expected 32 (RGBA), 16 (grayscale) or 8 (indexed)`,
    );
  }
  const colorDepth = rawDepth as AseColorDepth;
  const headerFlags = view.getUint32(14, true);
  // Deprecated, but still the base for every frame duration (see the spec's
  // "File Format Changes" section) — a per-frame duration of 0 falls back here.
  const headerSpeed = view.getUint16(18, true);
  const transparentIndex = bytes[28];
  const declaredColors = view.getUint16(32, true) || 256;
  const pixelWidth = bytes[34];
  const pixelHeight = bytes[35];

  const warnings: string[] = [];
  const warned = new Set<string>();
  const warnOnce = (key: string, message: string) => {
    if (warned.has(key)) return;
    warned.add(key);
    warnings.push(message);
  };

  const st: DecodeState = {
    headerFlags,
    colorDepth,
    transparentIndex,
    inflate: opts.inflate,
    layers: [],
    rawCels: [],
    tags: [],
    palette: [],
    paletteShared: false,
    framePalettes: [],
    hasNewPalette: false,
    levelStack: [],
    tagUserDataCursor: -1,
    warnings,
    warnOnce,
  };

  const frames: AseFrameInfo[] = [];
  let offset = HEADER_SIZE;

  for (let frameIndex = 0; frameIndex < frameCount; frameIndex++) {
    if (offset + FRAME_HEADER_SIZE > bytes.length) {
      throw new Error(
        `Truncated .aseprite file: frame ${frameIndex} header starts past the end of the buffer`,
      );
    }
    const frameStart = offset;
    const bytesInFrame = view.getUint32(frameStart, true);
    const frameMagic = view.getUint16(frameStart + 4, true);
    if (frameMagic !== FRAME_MAGIC) {
      throw new Error(
        `Malformed .aseprite file: frame ${frameIndex} magic is ${hex(frameMagic, 4)}, ` +
          `expected ${hex(FRAME_MAGIC, 4)}`,
      );
    }
    const oldChunkCount = view.getUint16(frameStart + 6, true);
    const frameDuration = view.getUint16(frameStart + 8, true);
    const newChunkCount = view.getUint32(frameStart + 12, true);
    const chunkCount = newChunkCount !== 0 ? newChunkCount : oldChunkCount;

    frames.push({ durationMs: frameDuration > 0 ? frameDuration : headerSpeed });

    let chunkStart = frameStart + FRAME_HEADER_SIZE;
    for (let c = 0; c < chunkCount; c++) {
      if (chunkStart + CHUNK_HEADER_SIZE > bytes.length) {
        throw new Error(
          `Truncated .aseprite file: frame ${frameIndex} chunk ${c} header runs past the end of the buffer`,
        );
      }
      const chunkSize = view.getUint32(chunkStart, true);
      const chunkType = view.getUint16(chunkStart + 4, true);
      if (chunkSize < CHUNK_HEADER_SIZE) {
        throw new Error(
          `Malformed .aseprite file: frame ${frameIndex} chunk ${c} declares size ${chunkSize}, ` +
            `below the ${CHUNK_HEADER_SIZE}-byte minimum (the size includes its own header)`,
        );
      }
      const chunkEnd = chunkStart + chunkSize;
      if (chunkEnd > bytes.length) {
        throw new Error(
          `Truncated .aseprite file: frame ${frameIndex} chunk ${c} (type ${hex(chunkType, 4)}) ` +
            `claims ${chunkSize} bytes but only ${bytes.length - chunkStart} remain`,
        );
      }

      const cursor = new Cursor(bytes, view, chunkStart + CHUNK_HEADER_SIZE, chunkEnd);
      try {
        await readChunk(st, chunkType, cursor, frameIndex);
      } catch (error) {
        if (!(error instanceof ChunkOverrunError)) throw error;
        // Whatever the chunk committed before the bad record stands; the
        // record itself and everything after it in this chunk is dropped.
        warnOnce(
          `chunk-overrun-${frameIndex}-${c}`,
          `Frame ${frameIndex} chunk ${c} (type ${hex(chunkType, 4)}) has a record running past ` +
            `the chunk's declared end (${error.message}); the rest of that chunk was ignored`,
        );
      }

      // The user-data-follows-tags run ends at the first chunk that is neither
      // the Tags chunk itself nor another User Data chunk.
      if (chunkType !== 0x2018 && chunkType !== 0x2020) st.tagUserDataCursor = -1;

      chunkStart = chunkEnd;
    }

    // Freeze this frame's palette. Later frames keep sharing the same array
    // until a palette chunk forces a copy in writablePalette().
    st.framePalettes.push(st.palette);
    st.paletteShared = true;

    offset = chunkStart;
    if (bytesInFrame !== 0 && frameStart + bytesInFrame !== offset) {
      warnOnce(
        "frame-size-mismatch",
        `Frame ${frameIndex} declares ${bytesInFrame} bytes but its chunks span ` +
          `${offset - frameStart}; following the chunk sizes instead`,
      );
    }
  }

  if (colorDepth === 8 && st.palette.length === 0) {
    warnOnce(
      "indexed-no-palette",
      `Indexed sprite declares ${declaredColors} colours but the file contains no palette chunk; ` +
        `all pixels decode as transparent`,
    );
  }

  const cels = buildCels(st);

  return {
    width,
    height,
    frameCount,
    colorDepth,
    transparentIndex,
    palette: st.framePalettes[0] ?? st.palette,
    layers: st.layers,
    tags: st.tags,
    frames,
    cels,
    pixelRatio: {
      width: pixelWidth === 0 || pixelHeight === 0 ? 1 : pixelWidth,
      height: pixelWidth === 0 || pixelHeight === 0 ? 1 : pixelHeight,
    },
    warnings,
  };
}

async function readChunk(
  st: DecodeState,
  chunkType: number,
  cursor: Cursor,
  frameIndex: number,
): Promise<void> {
  switch (chunkType) {
    case 0x2004:
      readLayerChunk(st, cursor);
      return;
    case 0x2005:
      await readCelChunk(st, cursor, frameIndex);
      return;
    // Cel Extra (0x2006) carries sub-pixel bounds for real-time scaling, and
    // Color Profile (0x2007) carries sRGB/ICC data. Neither affects the pixels
    // we hand back, so both are skipped silently — the outer loop still
    // advances by chunkSize, so skipping cannot desync the stream.
    case 0x2006:
    case 0x2007:
      return;
    case 0x2018:
      readTagsChunk(st, cursor);
      return;
    case 0x2019:
      readPaletteChunk(st, cursor);
      return;
    case 0x0004:
      readOldPaletteChunk(st, cursor, false);
      return;
    // The spec headings name the 6-bit chunk "0x0011", but it is FLI_COLOR,
    // whose number is decimal 11: Aseprite's own decoder defines
    // ASE_FILE_CHUNK_FLI_COLOR as 11 (= 0x000B) and scales it from 6 bits. The
    // spec text writes a decimal id in hex-looking notation, so accept both.
    case 0x000b:
    case 0x0011:
      readOldPaletteChunk(st, cursor, true);
      return;
    case 0x2020:
      readUserDataChunk(st, cursor);
      return;
    case 0x2023:
      st.warnOnce(
        "tileset-chunk",
        "Tileset chunks (0x2023) are not supported; tilemap layers will render empty",
      );
      return;
    default:
      st.warnOnce(`chunk-${chunkType}`, `Skipped unhandled chunk type ${hex(chunkType, 4)}`);
      return;
  }
}

function readLayerChunk(st: DecodeState, cur: Cursor): void {
  const index = st.layers.length;

  // A layer chunk is never dropped, even when it overruns: cels address layers
  // by position in file order (NOTE.2), so losing one would silently re-home
  // every later cel onto the wrong layer. Fields that could not be read keep
  // these defaults instead — and since flags come first, a merely over-long
  // name still leaves the layer's real visibility in place.
  let flags = 0;
  let typeId = 0;
  let childLevel = 0;
  let blendId = 0;
  let rawOpacity = 255;
  let name = "";
  try {
    flags = cur.u16();
    typeId = cur.u16();
    childLevel = cur.u16();
    cur.skip(4); // Default layer width/height — the spec marks both "(ignored)".
    blendId = cur.u16();
    rawOpacity = cur.u8();
    cur.skip(3);
    name = cur.str();
    // Conditional tail, in this order: the tilemap's tileset index comes first,
    // the UUID second. Nothing here uses either, so it is length-checked, not
    // read.
    const tail = (typeId === 2 ? 4 : 0) + ((st.headerFlags & 4) !== 0 ? 16 : 0);
    if (tail > cur.remaining) {
      st.warnOnce(
        `layer-tail-${index}`,
        `Layer ${index} ("${name}") chunk is too short for its tileset index / UUID fields; ` +
          "the file may be malformed",
      );
    }
  } catch (error) {
    if (!(error instanceof ChunkOverrunError)) throw error;
    st.warnOnce(
      `layer-overrun-${index}`,
      `Layer ${index} chunk runs past its declared size; its name and any unread fields were defaulted`,
    );
  }

  let type: AseLayerType;
  if (typeId === 0) type = "image";
  else if (typeId === 1) type = "group";
  else if (typeId === 2) type = "tilemap";
  else {
    type = "image";
    st.warnOnce(
      `layer-type-${typeId}`,
      `Unknown layer type ${typeId} on "${name}"; treated as a normal image layer`,
    );
  }

  let blendMode: AseBlendMode = "normal";
  const knownBlendMode = blendModeFromId(blendId);
  if (knownBlendMode !== null) blendMode = knownBlendMode;
  else {
    st.warnOnce(
      `blend-mode-${blendId}`,
      `Unknown blend mode ${blendId} on layer "${name}"; treated as Normal`,
    );
  }

  // NOTE.6: opacity is meaningful for image/tilemap layers only when header
  // flag 1 is set, and for groups only when header flag 2 is. Normalising the
  // unusable case to fully opaque here keeps that check out of every caller.
  const opacityValid = type === "group" ? (st.headerFlags & 2) !== 0 : (st.headerFlags & 1) !== 0;

  const parentIndex = childLevel > 0 ? (st.levelStack[childLevel - 1] ?? null) : null;
  const visible = (flags & 1) !== 0;
  const parent = parentIndex === null ? undefined : st.layers[parentIndex];

  st.layers.push({
    index,
    name,
    type,
    childLevel,
    parentIndex,
    visible,
    effectivelyVisible: visible && (parent === undefined || parent.effectivelyVisible),
    background: (flags & 8) !== 0,
    reference: (flags & 64) !== 0,
    blendMode,
    opacity: opacityValid ? rawOpacity : 255,
  });

  // Drop any stale deeper entries: a level-1 layer following a level-3 one
  // must not leave the level-2/3 slots pointing at unrelated layers.
  st.levelStack.length = childLevel;
  st.levelStack[childLevel] = index;
}

/** "frame 3, layer "Body"" — the layer name when its chunk has been read already. */
function celLocation(st: DecodeState, frameIndex: number, layerIndex: number): string {
  const layer = st.layers[layerIndex];
  return layer
    ? `frame ${frameIndex}, layer "${layer.name}"`
    : `frame ${frameIndex}, layer index ${layerIndex}`;
}

async function readCelChunk(st: DecodeState, cur: Cursor, frameIndex: number): Promise<void> {
  const layerIndex = cur.u16();
  const x = cur.i16(); // SIGNED: cels legitimately sit off-canvas.
  const y = cur.i16();
  const opacity = cur.u8();
  const celType = cur.u16();
  const zIndex = cur.i16(); // SIGNED: NOTE.5 render-order nudge.
  cur.skip(5);

  if (celType === 1) {
    const sourceFrame = cur.u16();
    st.rawCels.push({
      frameIndex,
      layerIndex,
      x,
      y,
      opacity,
      zIndex,
      kind: "link",
      sourceFrame,
    });
    return;
  }

  if (celType === 3) {
    // The fixed tail here is 2+2+2+4+4+4+4+10 = 32 bytes, then a zlib TILE
    // stream. We do not resolve tilesets, so there is nothing useful to make
    // of the tile indices; skipping is honest, and chunkSize gets us out.
    st.warnOnce(
      "tilemap-cel",
      "Compressed tilemap cels (type 3) are not supported; those cels are omitted",
    );
    return;
  }

  if (celType !== 0 && celType !== 2) {
    st.warnOnce(
      `cel-type-${celType}`,
      `Unknown cel type ${celType} at frame ${frameIndex}, layer ${layerIndex}; cel skipped`,
    );
    return;
  }

  const width = cur.u16();
  const height = cur.u16();
  const bytesPerPixel = st.colorDepth / 8;
  const expected = width * height * bytesPerPixel;

  // Both tails start at chunkStart + 6 + 16 + 4, so the remaining bytes in the
  // chunk are exactly the image payload — raw for type 0, zlib for type 2.
  const payload = cur.take(Math.max(0, cur.remaining));

  // A damaged cel costs that cel, not the document — the same bargain as an
  // unknown cel type above. The chunk framing around it is intact (the outer
  // walk validated it), so every other cel is still trustworthy; structural
  // damage to that framing stays a hard error in parseAseprite.
  let raw: Uint8Array;
  if (celType === 0) {
    raw = payload;
  } else {
    try {
      raw = await st.inflate(payload);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      st.warnOnce(
        `cel-inflate-${frameIndex}-${layerIndex}`,
        `Cel at ${celLocation(st, frameIndex, layerIndex)}: zlib inflate failed: ${reason}; ` +
          "the cel was skipped",
      );
      return;
    }
  }

  if (raw.length !== expected) {
    st.warnOnce(
      `cel-size-${frameIndex}-${layerIndex}`,
      `Cel at ${celLocation(st, frameIndex, layerIndex)}: expected ${expected} bytes for ` +
        `${width}x${height} at ${st.colorDepth}bpp, got ${raw.length}; the cel was skipped`,
    );
    return;
  }

  st.rawCels.push({
    frameIndex,
    layerIndex,
    x,
    y,
    opacity,
    zIndex,
    kind: "image",
    width,
    height,
    raw,
  });
}

function readTagsChunk(st: DecodeState, cur: Cursor): void {
  const count = cur.u16();
  cur.skip(8);

  // "After the tags chunk, you can write one user data chunk for each tag" —
  // consumed in tag order by the user data handler. Set before the records so
  // tags that did decode still pair with their user data if a later record
  // overruns the chunk.
  st.tagUserDataCursor = st.tags.length;

  for (let i = 0; i < count && cur.remaining > 0; i++) {
    // 17 fixed bytes (2+2+1+2+6+3+1) and then a STRING — the record stride is
    // variable, so this must stay sequential.
    const from = cur.u16();
    const to = cur.u16();
    const dirId = cur.u8();
    const repeat = cur.u16();
    cur.skip(6);
    const r = cur.u8();
    const g = cur.u8();
    const b = cur.u8();
    cur.skip(1);
    const name = cur.str();

    let direction: AseTagDirection = "forward";
    if (dirId < TAG_DIRECTIONS.length) direction = TAG_DIRECTIONS[dirId];
    else {
      st.warnOnce(
        `tag-direction-${dirId}`,
        `Unknown tag loop direction ${dirId} on "${name}"; treated as Forward`,
      );
    }

    const tag: AseTag = { name, from, to, direction, repeat };
    // The in-chunk RGB is deprecated (v1.2.x only); the real colour arrives in
    // the trailing user data chunks. Keep it as a fallback for old files.
    if (r !== 0 || g !== 0 || b !== 0) tag.color = rgbHex(r, g, b);
    st.tags.push(tag);
  }
}

/**
 * The palette to write into, copied first if a finished frame still holds the
 * current array. Called only once a chunk is known to change the palette, so a
 * 1000-frame file with one palette keeps exactly one palette array.
 */
function writablePalette(st: DecodeState): AseColor[] {
  if (st.paletteShared) {
    // Shallow is enough: entries are replaced with fresh objects, never
    // mutated in place, so the frozen frame's AseColor objects stay intact.
    st.palette = st.palette.slice();
    st.paletteShared = false;
  }
  return st.palette;
}

function readPaletteChunk(st: DecodeState, cur: Cursor): void {
  const declaredSize = cur.u32();
  const first = cur.u32();
  const last = cur.u32();
  cur.skip(8);

  st.hasNewPalette = true;
  const newSize = clampPaletteSize(st, declaredSize);
  const palette = writablePalette(st);
  if (newSize < palette.length) palette.length = newSize;
  while (palette.length < newSize) palette.push({ r: 0, g: 0, b: 0, a: 0 });

  // The entry loop itself is bounded by the chunk end (an entry costs at least
  // six bytes), so only the index — which `first` can put anywhere in DWORD
  // range — needs its own ceiling.
  for (let i = first; i <= last && cur.remaining > 0; i++) {
    const flags = cur.u16();
    const r = cur.u8();
    const g = cur.u8();
    const b = cur.u8();
    const a = cur.u8();
    // The optional entry name is why the stride is NOT a fixed 6 bytes.
    if ((flags & 1) !== 0) cur.str();
    if (i >= MAX_PALETTE_ENTRIES) {
      clampPaletteSize(st, i + 1);
      continue;
    }
    while (palette.length <= i) palette.push({ r: 0, g: 0, b: 0, a: 0 });
    palette[i] = { r, g, b, a };
  }
}

/** Shared ceiling + warning for both palette chunk families. */
function clampPaletteSize(st: DecodeState, size: number): number {
  if (size <= MAX_PALETTE_ENTRIES) return size;
  st.warnOnce(
    "palette-size-clamped",
    `Palette declares ${size} entries, which is past the ${MAX_PALETTE_ENTRIES}-entry ceiling; ` +
      "it was clamped and the excess entries dropped",
  );
  return MAX_PALETTE_ENTRIES;
}

/**
 * Aseprite's scale_6bits_to_8bits: bit replication, `(v << 2) | (v >> 4)`.
 * `round(v * 255 / 63)` looks equivalent and is one off on ten of the 64
 * inputs (11-15 and 48-52), which on a flat pixel-art fill is a visible band.
 * Values past 63 are malformed; the clamp keeps them inside the 0-255 range
 * AseColor promises.
 */
function scale6BitTo8Bit(v: number): number {
  return Math.min(255, (v << 2) | (v >> 4));
}

/**
 * Old FLI palette chunks: 0x0004 stores 0-255 components, 0x000B / 0x0011 store
 * 0-63. All use the packet/skip-cursor model, and all lose to a 0x2019 chunk.
 * Applied eagerly rather than deferred because grayscale and older indexed
 * files carry nothing else — the 0x2019 chunk, when present, comes later in
 * the same frame and simply overwrites this.
 */
function readOldPaletteChunk(st: DecodeState, cur: Cursor, sixBit: boolean): void {
  if (st.hasNewPalette) return;

  const packets = cur.u16();
  const palette = writablePalette(st);
  let index = 0;

  const scale = (v: number) => (sixBit ? scale6BitTo8Bit(v) : v);

  for (let p = 0; p < packets && cur.remaining > 0; p++) {
    index += cur.u8();
    const count = cur.u8() || 256;
    for (let c = 0; c < count && cur.remaining > 0; c++) {
      const r = cur.u8();
      const g = cur.u8();
      const b = cur.u8();
      // Same unbounded-growth guard as the 0x2019 path: `index` walks forward on
      // untrusted skip bytes, and a crafted chunk can otherwise push millions of
      // placeholder entries before it runs out of bytes.
      if (index >= MAX_PALETTE_ENTRIES) {
        clampPaletteSize(st, index + 1);
        index++;
        continue;
      }
      while (palette.length <= index) palette.push({ r: 0, g: 0, b: 0, a: 0 });
      palette[index] = { r: scale(r), g: scale(g), b: scale(b), a: 255 };
      index++;
    }
  }
}

function readUserDataChunk(st: DecodeState, cur: Cursor): void {
  const flags = cur.u32();
  if ((flags & 1) !== 0) cur.str(); // Text — nothing in the document model wants it.

  let color: string | undefined;
  if ((flags & 2) !== 0) {
    const r = cur.u8();
    const g = cur.u8();
    const b = cur.u8();
    const a = cur.u8();
    // Aseprite writes a fully transparent colour for "no colour set".
    if (a !== 0) color = rgbHex(r, g, b);
  }

  if ((flags & 4) !== 0) {
    // The properties block's Size DWORD counts itself, so only Size - 4 bytes
    // remain after reading it. Nothing here needs the properties themselves,
    // and they are the last thing in the chunk, so an impossible size costs
    // only the properties: the colour above is already read and still counts.
    const size = cur.u32();
    const body = Math.max(0, size - 4);
    if (body > cur.remaining) {
      st.warnOnce(
        "user-data-properties-overrun",
        `User data properties block declares ${size} bytes but only ${cur.remaining} remain in ` +
          "its chunk; the properties were skipped",
      );
    } else {
      cur.skip(body);
    }
  }

  if (st.tagUserDataCursor >= 0 && st.tagUserDataCursor < st.tags.length) {
    if (color !== undefined) st.tags[st.tagUserDataCursor].color = color;
    st.tagUserDataCursor++;
  }
}

/** The palette in effect at `frameIndex`: the latest one at or before it. */
function paletteAt(st: DecodeState, frameIndex: number): AseColor[] {
  return st.framePalettes[frameIndex] ?? st.palette;
}

/**
 * Second pass: decode pixels now that every palette and layer is known, then
 * resolve linked cels — a link may point forward to a frame we had not read yet
 * when we hit it.
 */
function buildCels(st: DecodeState): AseCel[] {
  for (const rc of st.rawCels) {
    if (st.layers[rc.layerIndex] === undefined) {
      st.warnOnce(
        "cel-unknown-layer",
        `Cel at frame ${rc.frameIndex} references layer index ${rc.layerIndex}, which has no ` +
          "layer chunk; it cannot be composited",
      );
    }
  }

  const imageByFrameAndLayer = new Map<string, RawCel & { kind: "image" }>();
  // Decoded pixels per source cel, per palette array. Frames share one palette
  // array until it changes, so identity is an exact "same colours" test and a
  // link shown under an unchanged palette reuses the source buffer outright.
  const decoded = new Map<RawCel, Map<AseColor[], Uint8ClampedArray>>();
  const pixelsFor = (rc: RawCel & { kind: "image" }, frameIndex: number) => {
    // Only indexed pixels depend on the palette; RGBA and grayscale decode the
    // same under any frame, so key them all to one slot.
    const palette = st.colorDepth === 8 ? paletteAt(st, frameIndex) : st.palette;
    let byPalette = decoded.get(rc);
    if (!byPalette) {
      byPalette = new Map();
      decoded.set(rc, byPalette);
    }
    let pixels = byPalette.get(palette);
    if (!pixels) {
      pixels = decodePixels(st, rc.raw, rc.width, rc.height, rc.layerIndex, palette);
      byPalette.set(palette, pixels);
    }
    return pixels;
  };

  const resolved: (AseCel | null)[] = st.rawCels.map((rc) => {
    if (rc.kind !== "image") return null;
    imageByFrameAndLayer.set(`${rc.frameIndex}:${rc.layerIndex}`, rc);
    return {
      frameIndex: rc.frameIndex,
      layerIndex: rc.layerIndex,
      x: rc.x,
      y: rc.y,
      width: rc.width,
      height: rc.height,
      opacity: rc.opacity,
      zIndex: rc.zIndex,
      pixels: pixelsFor(rc, rc.frameIndex),
    };
  });

  for (let i = 0; i < st.rawCels.length; i++) {
    const rc = st.rawCels[i];
    if (rc.kind !== "link") continue;
    const source = imageByFrameAndLayer.get(`${rc.sourceFrame}:${rc.layerIndex}`);
    if (!source) {
      st.warnOnce(
        "linked-cel-missing",
        `Linked cel at frame ${rc.frameIndex}, layer ${rc.layerIndex} points at frame ` +
          `${rc.sourceFrame}, which has no cel on that layer; the cel was dropped`,
      );
      continue;
    }
    // The link supplies the pixels and their size; position, opacity and
    // z-index stay this cel's own. The colours come from the palette of the
    // frame the link is SHOWN in, not the source's: a link shares the index
    // image, and Aseprite's renderer looks up palette(frame) for the frame
    // being drawn.
    resolved[i] = {
      frameIndex: rc.frameIndex,
      layerIndex: rc.layerIndex,
      x: rc.x,
      y: rc.y,
      width: source.width,
      height: source.height,
      opacity: rc.opacity,
      zIndex: rc.zIndex,
      pixels: pixelsFor(source, rc.frameIndex),
    };
  }

  return resolved.filter((cel): cel is AseCel => cel !== null);
}

/** Straight (non-premultiplied) RGBA8, whatever the file's colour depth. */
function decodePixels(
  st: DecodeState,
  raw: Uint8Array,
  width: number,
  height: number,
  layerIndex: number,
  palette: AseColor[],
): Uint8ClampedArray {
  const count = width * height;
  const out = new Uint8ClampedArray(count * 4);

  if (st.colorDepth === 32) {
    // R,G,B,A in byte order. Reading these as a little-endian DWORD would
    // unpack them as ABGR — a copy is both correct and faster.
    out.set(raw);
    return out;
  }

  if (st.colorDepth === 16) {
    for (let i = 0; i < count; i++) {
      const value = raw[i * 2];
      out[i * 4] = value;
      out[i * 4 + 1] = value;
      out[i * 4 + 2] = value;
      out[i * 4 + 3] = raw[i * 2 + 1];
    }
    return out;
  }

  // The transparent index only reads as transparent on non-background layers;
  // on a background layer that same index is an ordinary palette colour. A cel
  // with no layer chunk (already warned about in buildCels) is treated as a
  // non-background layer.
  const layer = st.layers[layerIndex];
  const honourTransparentIndex = layer === undefined || !layer.background;

  for (let i = 0; i < count; i++) {
    const index = raw[i];
    if (honourTransparentIndex && index === st.transparentIndex) continue;
    const entry = palette[index];
    if (entry === undefined) {
      st.warnOnce(
        "palette-index-range",
        `Pixel index ${index} is past the end of the ${palette.length}-entry palette; ` +
          `those pixels decode as transparent`,
      );
      continue;
    }
    out[i * 4] = entry.r;
    out[i * 4 + 1] = entry.g;
    out[i * 4 + 2] = entry.b;
    out[i * 4 + 3] = entry.a;
  }
  return out;
}
