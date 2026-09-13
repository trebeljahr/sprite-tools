// Generate the synthetic .aseprite fixtures under tests/fixtures/aseprite/generated/.
//
//   node scripts/gen-ase-fixtures.mjs
//
// Why hand-roll an encoder: the real Aseprite files we can legally vendor
// (tests/fixtures/aseprite/excalibur/) all come out of the same "draw a beetle,
// hit save" workflow, so whole branches of the format are never exercised by
// them — raw cels, ping-pong-reverse tags, non-zero z-index, background layers,
// named palette entries, old-style palette packets with a non-zero skip. These
// files fill exactly those gaps and nothing else, which is why they are small,
// solid-coloured and boring: every pixel is meant to be asserted by hand.
//
// Output must be byte-identical on every run (the fixtures are committed, and a
// regenerate-and-diff check is how we catch accidental encoder drift), so there
// is no Math.random, no Date, and no iteration over unordered collections here.
// That includes zlib: cel data is compressed by the small encoder below rather
// than node:zlib, because deflate output is only stable per zlib build and the
// Node versions this repo supports ship different ones (bundled zlib-ng vs a
// system zlib), which made the regenerate-and-diff check fail by machine.
//
// Field layouts follow aseprite/aseprite docs/ase-file-specs.md. Two details
// that are easy to get wrong and are asserted by the self-check at the bottom:
// a chunk's size DWORD includes itself and the type WORD, and a frame's "bytes
// in this frame" DWORD includes the 16-byte frame header.

import { mkdirSync, writeFileSync } from "node:fs";
import { inflateSync } from "node:zlib";

const OUT_DIR = new URL("../tests/fixtures/aseprite/generated/", import.meta.url);

// --------------------------------------------------------------------------
// deterministic zlib encoder (RFC 1950 wrapper around one RFC 1951 block)
// --------------------------------------------------------------------------
//
// One fixed-Huffman block with greedy LZ77 over the whole (tiny) input. It is
// not competitive with zlib, and does not need to be: the point is that the
// bytes depend only on this file. It still emits real Huffman codes and
// overlapping back-references (solid-colour pixel runs are distance-4 matches
// longer than 4), so the readers' inflaters are exercised on those paths, not
// just on stored blocks.

const LEN_BASE = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131,
  163, 195, 227, 258,
];
const LEN_EXTRA = [
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
];
const DIST_BASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049,
  3073, 4097, 6145, 8193, 12289, 16385, 24577,
];
const DIST_EXTRA = [
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13,
];

/** Largest i with table[i] <= v. */
function codeIndex(table, v) {
  let i = table.length - 1;
  while (table[i] > v) i--;
  return i;
}

function deflate(data) {
  const out = [0x78, 0x01]; // CM 8, 32K window, FLEVEL 0; 0x7801 % 31 === 0
  let bitBuf = 0;
  let bitCount = 0;
  // Header fields and extra bits go LSB-first...
  const bits = (value, count) => {
    for (let i = 0; i < count; i++) {
      bitBuf |= ((value >> i) & 1) << bitCount;
      if (++bitCount === 8) {
        out.push(bitBuf);
        bitBuf = 0;
        bitCount = 0;
      }
    }
  };
  // ...but Huffman codes are packed MSB-first (RFC 1951 section 3.1.1).
  const code = (value, count) => {
    for (let i = count - 1; i >= 0; i--) bits((value >> i) & 1, 1);
  };
  const litLen = (sym) => {
    if (sym <= 143) code(0x30 + sym, 8);
    else if (sym <= 255) code(0x190 + sym - 144, 9);
    else if (sym <= 279) code(sym - 256, 7);
    else code(0xc0 + sym - 280, 8);
  };

  bits(1, 1); // BFINAL
  bits(1, 2); // BTYPE 01 = fixed Huffman

  let i = 0;
  while (i < data.length) {
    let bestLen = 0;
    let bestDist = 0;
    // Nearest candidate first, and only a strictly longer match replaces it, so
    // ties always resolve the same way.
    for (let j = i - 1; j >= Math.max(0, i - 32768); j--) {
      let len = 0;
      while (len < 258 && i + len < data.length && data[j + len] === data[i + len]) len++;
      if (len > bestLen) {
        bestLen = len;
        bestDist = i - j;
        if (len === 258) break;
      }
    }
    if (bestLen >= 3) {
      const li = codeIndex(LEN_BASE, bestLen);
      litLen(257 + li);
      bits(bestLen - LEN_BASE[li], LEN_EXTRA[li]);
      const di = codeIndex(DIST_BASE, bestDist);
      code(di, 5);
      bits(bestDist - DIST_BASE[di], DIST_EXTRA[di]);
      i += bestLen;
    } else {
      litLen(data[i]);
      i++;
    }
  }
  litLen(256); // end of block
  if (bitCount > 0) out.push(bitBuf);

  let a = 1;
  let b = 0;
  for (const byte of data) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  out.push((b >> 8) & 0xff, b & 0xff, (a >> 8) & 0xff, a & 0xff); // Adler-32, big-endian

  const encoded = Buffer.from(out);
  // A hand-rolled encoder that is wrong would still produce stable bytes, so
  // prove every stream round-trips through a real inflater before it is written.
  if (!inflateSync(encoded).equals(Buffer.from(data))) {
    throw new Error("deflate: encoded stream does not round-trip");
  }
  return encoded;
}

// --------------------------------------------------------------------------
// little-endian byte writer
// --------------------------------------------------------------------------

class W {
  constructor() {
    this.parts = [];
    this.len = 0;
  }
  raw(buf) {
    this.parts.push(buf);
    this.len += buf.length;
    return this;
  }
  u8(v) {
    const b = Buffer.alloc(1);
    b.writeUInt8(v, 0);
    return this.raw(b);
  }
  u16(v) {
    const b = Buffer.alloc(2);
    b.writeUInt16LE(v, 0);
    return this.raw(b);
  }
  i16(v) {
    const b = Buffer.alloc(2);
    b.writeInt16LE(v, 0);
    return this.raw(b);
  }
  u32(v) {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(v, 0);
    return this.raw(b);
  }
  zeros(n) {
    return this.raw(Buffer.alloc(n));
  }
  /** STRING: WORD byte-length then UTF-8 bytes, no NUL terminator. */
  str(s) {
    const b = Buffer.from(s, "utf8");
    this.u16(b.length);
    return this.raw(b);
  }
  done() {
    return Buffer.concat(this.parts, this.len);
  }
}

// --------------------------------------------------------------------------
// framing
// --------------------------------------------------------------------------

function chunk(type, build) {
  const w = new W();
  build(w);
  const payload = w.done();
  const head = new W();
  head.u32(payload.length + 6); // self-inclusive: size DWORD + type WORD + payload
  head.u16(type);
  return Buffer.concat([head.done(), payload]);
}

function frame(durationMs, chunks) {
  const body = Buffer.concat(chunks);
  const h = new W();
  h.u32(body.length + 16); // "bytes in this frame" counts the frame header too
  h.u16(0xf1fa);
  // Both counts are written. The old WORD saturates at 0xFFFF by spec; none of
  // these fixtures come close, but encoding the rule keeps the helper honest.
  h.u16(chunks.length > 0xffff ? 0xffff : chunks.length);
  h.u16(durationMs);
  h.zeros(2);
  h.u32(chunks.length);
  return Buffer.concat([h.done(), body]);
}

function header({ frames, width, height, depth, flags, speed, transparentIndex, colorCount }) {
  const w = new W();
  w.u32(0); // file size — patched in build() once the real length is known
  w.u16(0xa5e0);
  w.u16(frames);
  w.u16(width);
  w.u16(height);
  w.u16(depth);
  w.u32(flags);
  w.u16(speed);
  w.u32(0);
  w.u32(0);
  w.u8(transparentIndex);
  w.zeros(3);
  w.u16(colorCount);
  w.u8(1); // pixel width
  w.u8(1); // pixel height
  w.i16(0); // grid x
  w.i16(0); // grid y
  w.u16(16); // grid width
  w.u16(16); // grid height
  w.zeros(84);
  const b = w.done();
  if (b.length !== 128) throw new Error(`header is ${b.length} bytes, must be 128`);
  return b;
}

function build(hdr, frames) {
  const buf = Buffer.concat([header(hdr), ...frames]);
  buf.writeUInt32LE(buf.length, 0);
  return buf;
}

// --------------------------------------------------------------------------
// chunk builders
// --------------------------------------------------------------------------

/** 0x2007, sRGB with no fixed gamma — what real Aseprite writes. */
const colorProfileChunk = () =>
  chunk(0x2007, (w) => {
    w.u16(1); // type: sRGB
    w.u16(0); // flags
    w.u32(0); // fixed gamma
    w.zeros(8);
  });

/**
 * 0x2019. Entries with a `name` set the has-name bit, widening that entry.
 *
 * `size` and `first` default to a full palette starting at index 0. A later
 * frame that changes only some entries writes a partial range (`first` past 0,
 * `size` still the whole palette), which is how Aseprite's encoder emits a
 * per-frame palette change.
 */
const paletteChunk = (entries, { size = entries.length, first = 0 } = {}) =>
  chunk(0x2019, (w) => {
    w.u32(size);
    w.u32(first);
    w.u32(first + entries.length - 1);
    w.zeros(8);
    for (const e of entries) {
      const named = typeof e.name === "string";
      w.u16(named ? 1 : 0);
      w.u8(e.r);
      w.u8(e.g);
      w.u8(e.b);
      w.u8(e.a);
      if (named) w.str(e.name);
    }
  });

/** 0x0004. `packets` is [{ skip, colors: [[r,g,b], ...] }]; a count of 256 encodes as 0. */
const oldPaletteChunk = (packets) =>
  chunk(0x0004, (w) => {
    w.u16(packets.length);
    for (const p of packets) {
      w.u8(p.skip);
      w.u8(p.colors.length === 256 ? 0 : p.colors.length);
      for (const c of p.colors) {
        w.u8(c[0]);
        w.u8(c[1]);
        w.u8(c[2]);
      }
    }
  });

const layerChunk = ({ flags, type = 0, childLevel = 0, blend = 0, opacity = 255, name }) =>
  chunk(0x2004, (w) => {
    w.u16(flags);
    w.u16(type);
    w.u16(childLevel);
    w.u16(0); // default layer width (ignored per spec)
    w.u16(0); // default layer height (ignored per spec)
    w.u16(blend);
    w.u8(opacity);
    w.zeros(3);
    w.str(name);
  });

/** The 16 bytes every cel chunk starts with, whatever its cel type. */
function celCommon(w, { layerIndex, x, y, opacity = 255, celType, zIndex = 0 }) {
  w.u16(layerIndex);
  w.i16(x);
  w.i16(y);
  w.u8(opacity);
  w.u16(celType);
  w.i16(zIndex);
  w.zeros(5);
}

const celCompressed = (c) =>
  chunk(0x2005, (w) => {
    celCommon(w, { ...c, celType: 2 });
    w.u16(c.width);
    w.u16(c.height);
    w.raw(deflate(c.pixels));
  });

const celRaw = (c) =>
  chunk(0x2005, (w) => {
    celCommon(w, { ...c, celType: 0 });
    w.u16(c.width);
    w.u16(c.height);
    w.raw(c.pixels);
  });

// Aseprite writes the source cel's x/y/opacity into a linked cel chunk as well,
// so both readings (inherit everything vs. trust the local fields) agree. These
// fixtures mirror that rather than inventing a disagreement to resolve.
const celLinked = (c) =>
  chunk(0x2005, (w) => {
    celCommon(w, { ...c, celType: 1 });
    w.u16(c.linkFrame);
  });

const tagsChunk = (tags) =>
  chunk(0x2018, (w) => {
    w.u16(tags.length);
    w.zeros(8);
    for (const t of tags) {
      w.u16(t.from);
      w.u16(t.to);
      w.u8(t.direction);
      w.u16(t.repeat);
      w.zeros(6);
      // Deprecated per-tag RGB. Left at 0,0,0 exactly as Aseprite leaves it, so
      // a reader that trusts this field instead of the trailing user data gets
      // black for every tag and the test catches it.
      w.zeros(3);
      w.u8(0); // extra byte
      w.str(t.name);
    }
  });

/** 0x2020 carrying only a colour — the shape Aseprite uses for tag colours. */
const userDataColorChunk = ({ r, g, b, a = 255 }) =>
  chunk(0x2020, (w) => {
    w.u32(2); // flags: has colour
    w.u8(r);
    w.u8(g);
    w.u8(b);
    w.u8(a);
  });

// --------------------------------------------------------------------------
// pixel buffers
// --------------------------------------------------------------------------

function imgRGBA(width, height, fn) {
  const out = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = fn(x, y);
      const i = (y * width + x) * 4;
      out[i] = r;
      out[i + 1] = g;
      out[i + 2] = b;
      out[i + 3] = a;
    }
  }
  return out;
}

function imgGray(width, height, fn) {
  const out = Buffer.alloc(width * height * 2);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [v, a] = fn(x, y);
      const i = (y * width + x) * 2;
      out[i] = v;
      out[i + 1] = a;
    }
  }
  return out;
}

function imgIndexed(width, height, fn) {
  const out = Buffer.alloc(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) out[y * width + x] = fn(x, y);
  }
  return out;
}

/** 0 = top-left, 1 = top-right, 2 = bottom-left, 3 = bottom-right of an 8x8. */
const quadrant = (x, y) => (y < 4 ? 0 : 2) + (x < 4 ? 0 : 1);

/** Palette shared by the fixtures where the palette itself is not under test. */
const BASIC_PALETTE = [
  { r: 0, g: 0, b: 0, a: 255 },
  { r: 255, g: 0, b: 0, a: 255 },
  { r: 0, g: 255, b: 0, a: 255 },
  { r: 0, g: 0, b: 255, a: 255 },
];

// --------------------------------------------------------------------------
// A. rgba-durations
// --------------------------------------------------------------------------

function rgbaDurations() {
  const DURATIONS = [100, 250, 40, 33];
  // Quadrant palettes rotate frame to frame so a test can tell which frame it
  // is looking at from a single pixel.
  const FRAME_QUADS = [
    [
      [255, 0, 0, 255],
      [0, 255, 0, 255],
      [0, 0, 255, 255],
      [255, 255, 0, 255],
    ],
    [
      [255, 255, 0, 255],
      [255, 0, 0, 255],
      [0, 255, 0, 255],
      [0, 0, 255, 255],
    ],
    [
      [0, 0, 255, 255],
      [255, 255, 0, 255],
      [255, 0, 0, 255],
      [0, 255, 0, 255],
    ],
  ];

  const cel = (f) =>
    celCompressed({
      layerIndex: 0,
      x: 0,
      y: 0,
      width: 8,
      height: 8,
      pixels: imgRGBA(8, 8, (x, y) => FRAME_QUADS[f][quadrant(x, y)]),
    });

  return build(
    {
      frames: 4,
      width: 8,
      height: 8,
      depth: 32,
      flags: 1,
      // Deliberately unlike every per-frame duration: a reader that falls back
      // to the deprecated header speed produces 1000ms everywhere and fails.
      speed: 1000,
      transparentIndex: 0,
      colorCount: BASIC_PALETTE.length,
    },
    [
      frame(DURATIONS[0], [
        colorProfileChunk(),
        paletteChunk(BASIC_PALETTE),
        layerChunk({ flags: 3, name: "Layer 1" }),
        cel(0),
      ]),
      frame(DURATIONS[1], [cel(1)]),
      frame(DURATIONS[2], [cel(2)]),
      // No chunks at all — the empty-frame case. Both chunk counts are 0.
      frame(DURATIONS[3], []),
    ],
  );
}

// --------------------------------------------------------------------------
// B. rgba-linked-and-raw
// --------------------------------------------------------------------------

function rgbaLinkedAndRaw() {
  // 12 wide on an 8-wide canvas starting at x=-2: two columns fall off the left
  // edge and two off the right, so a clipper that only guards one side is caught.
  const CEL = { x: -2, y: 1, width: 12, height: 4 };
  const body = (blue) => (c, r) => (c === 6 ? [0, 0, 0, 0] : [c * 20, r * 60, blue, 255]);

  return build(
    {
      frames: 3,
      width: 8,
      height: 8,
      depth: 32,
      flags: 1,
      speed: 100,
      transparentIndex: 0,
      colorCount: BASIC_PALETTE.length,
    },
    [
      frame(100, [
        colorProfileChunk(),
        paletteChunk(BASIC_PALETTE),
        layerChunk({ flags: 3, name: "Layer 1" }),
        celCompressed({
          layerIndex: 0,
          ...CEL,
          pixels: imgRGBA(CEL.width, CEL.height, body(0)),
        }),
      ]),
      frame(100, [
        celRaw({
          layerIndex: 0,
          ...CEL,
          pixels: imgRGBA(CEL.width, CEL.height, body(200)),
        }),
      ]),
      frame(100, [celLinked({ layerIndex: 0, ...CEL, linkFrame: 0 })]),
    ],
  );
}

// --------------------------------------------------------------------------
// C. indexed-transparent
// --------------------------------------------------------------------------

function indexedTransparent() {
  const palette = [
    { r: 0, g: 0, b: 0, a: 255 },
    // The one named entry. It sits in the middle so the entries after it only
    // decode correctly if the reader advanced past the name string.
    { r: 255, g: 0, b: 0, a: 255, name: "hero-red" },
    { r: 0, g: 255, b: 0, a: 255 },
    { r: 0, g: 0, b: 255, a: 255 },
  ];

  return build(
    {
      frames: 1,
      width: 8,
      height: 8,
      depth: 8,
      flags: 1,
      speed: 100,
      transparentIndex: 3,
      colorCount: palette.length,
    },
    [
      frame(100, [
        colorProfileChunk(),
        paletteChunk(palette),
        // flags 8 = background: index 3 stays opaque blue here.
        layerChunk({ flags: 1 | 2 | 8, name: "Background" }),
        layerChunk({ flags: 3, name: "Sprite" }),
        celCompressed({
          layerIndex: 0,
          x: 0,
          y: 0,
          width: 8,
          height: 8,
          pixels: imgIndexed(8, 8, (x) => (x < 4 ? 3 : 0)),
        }),
        celCompressed({
          layerIndex: 1,
          x: 0,
          y: 0,
          width: 8,
          height: 8,
          pixels: imgIndexed(8, 8, (x, y) => (y < 4 ? 3 : x < 4 ? 1 : 2)),
        }),
      ]),
    ],
  );
}

// --------------------------------------------------------------------------
// D. grayscale-oldpalette
// --------------------------------------------------------------------------

function grayscaleOldPalette() {
  return build(
    {
      frames: 1,
      width: 8,
      height: 8,
      depth: 16,
      flags: 1,
      speed: 100,
      transparentIndex: 0,
      // Highest index touched by the packets below, plus one.
      colorCount: 6,
    },
    [
      frame(100, [
        colorProfileChunk(),
        // No 0x2019 anywhere in this file, mirroring what Aseprite emits for
        // grayscale sprites. The second packet's non-zero skip is the part no
        // real fixture exercises: it leaves index 3 unwritten.
        oldPaletteChunk([
          {
            skip: 0,
            colors: [
              [0, 0, 0],
              [64, 64, 64],
              [128, 128, 128],
            ],
          },
          {
            skip: 1,
            colors: [
              [200, 10, 20],
              [30, 200, 40],
            ],
          },
        ]),
        layerChunk({ flags: 3, name: "Layer 1" }),
        celCompressed({
          layerIndex: 0,
          x: 0,
          y: 0,
          width: 8,
          height: 8,
          pixels: imgGray(8, 8, (x, y) => [x * 32, y < 4 ? 255 : 128]),
        }),
      ]),
    ],
  );
}

// --------------------------------------------------------------------------
// E. layers-blend
// --------------------------------------------------------------------------

function layersBlend() {
  const BASE = [
    [100, 150, 200, 255],
    [200, 100, 50, 255],
    [50, 200, 100, 255],
    [180, 180, 180, 255],
  ];
  const solid = (w, h, rgba) => imgRGBA(w, h, () => rgba);

  return build(
    {
      frames: 1,
      width: 8,
      height: 8,
      depth: 32,
      // 1 = layer opacity valid, 2 = blend/opacity valid for groups too.
      flags: 1 | 2,
      speed: 100,
      transparentIndex: 0,
      colorCount: BASIC_PALETTE.length,
    },
    [
      frame(100, [
        colorProfileChunk(),
        paletteChunk(BASIC_PALETTE),
        layerChunk({ flags: 3, name: "Base" }),
        layerChunk({ flags: 3, blend: 1, opacity: 128, name: "Mult" }),
        // flags 2 = editable but NOT visible.
        layerChunk({ flags: 2, name: "Hidden" }),
        layerChunk({ flags: 3, type: 1, name: "Group" }),
        layerChunk({ flags: 3, childLevel: 1, blend: 16, name: "Add" }),
        celCompressed({
          layerIndex: 0,
          x: 0,
          y: 0,
          width: 8,
          height: 8,
          pixels: imgRGBA(8, 8, (x, y) => BASE[quadrant(x, y)]),
        }),
        // z=-1 ties this with the base layer on layerIndex+zIndex and loses the
        // tie-break, so it renders *under* an opaque base and disappears.
        celCompressed({
          layerIndex: 1,
          x: 4,
          y: 4,
          zIndex: -1,
          width: 4,
          height: 4,
          pixels: solid(4, 4, [255, 128, 64, 255]),
        }),
        celCompressed({
          layerIndex: 2,
          x: 4,
          y: 0,
          width: 4,
          height: 4,
          pixels: solid(4, 4, [255, 0, 255, 255]),
        }),
        celCompressed({
          layerIndex: 4,
          x: 0,
          y: 4,
          zIndex: 2,
          width: 4,
          height: 4,
          pixels: solid(4, 4, [50, 40, 30, 255]),
        }),
      ]),
    ],
  );
}

// --------------------------------------------------------------------------
// F. tags-directions
// --------------------------------------------------------------------------

function tagsDirections() {
  const TAGS = [
    { name: "forward", from: 0, to: 3, direction: 0, repeat: 0 },
    { name: "reverse", from: 4, to: 7, direction: 1, repeat: 3 },
    { name: "pingpong", from: 8, to: 10, direction: 2, repeat: 0 },
    { name: "pingpong_reverse", from: 11, to: 11, direction: 3, repeat: 0 },
  ];
  const TAG_COLORS = [
    { r: 255, g: 0, b: 0 },
    { r: 0, g: 255, b: 0 },
    { r: 0, g: 0, b: 255 },
    { r: 255, g: 255, b: 0 },
  ];

  const cel = (f) =>
    celCompressed({
      layerIndex: 0,
      x: 0,
      y: 0,
      width: 8,
      height: 8,
      pixels: imgRGBA(8, 8, () => [10 + f * 20, 0, 0, 255]),
    });

  const frames = [
    frame(100, [
      colorProfileChunk(),
      paletteChunk(BASIC_PALETTE),
      tagsChunk(TAGS),
      // One user data chunk per tag, in tag order — spec's special case 1.
      ...TAG_COLORS.map(userDataColorChunk),
      layerChunk({ flags: 3, name: "Layer 1" }),
      cel(0),
    ]),
  ];
  for (let f = 1; f < 12; f++) frames.push(frame(100, [cel(f)]));

  return build(
    {
      frames: 12,
      width: 8,
      height: 8,
      depth: 32,
      flags: 1,
      speed: 100,
      transparentIndex: 0,
      colorCount: BASIC_PALETTE.length,
    },
    frames,
  );
}

// --------------------------------------------------------------------------
// G. rgba-reference-layer
// --------------------------------------------------------------------------

function rgbaReferenceLayer() {
  return build(
    {
      frames: 1,
      width: 8,
      height: 8,
      depth: 32,
      flags: 1,
      speed: 100,
      transparentIndex: 0,
      colorCount: BASIC_PALETTE.length,
    },
    [
      frame(100, [
        colorProfileChunk(),
        paletteChunk(BASIC_PALETTE),
        layerChunk({ flags: 3, name: "Art" }),
        // flags 64 = reference layer, on top of the art and fully opaque, so a
        // reader that composites it paints the whole canvas blue. Visible (1) is
        // set too, exactly as an artist's imported sketch would be: reference
        // layers are not "hidden", they are excluded from every export.
        layerChunk({ flags: 1 | 2 | 64, name: "Reference" }),
        celCompressed({
          layerIndex: 0,
          x: 0,
          y: 0,
          width: 4,
          height: 8,
          pixels: imgRGBA(4, 8, () => [255, 0, 0, 255]),
        }),
        celCompressed({
          layerIndex: 1,
          x: 0,
          y: 0,
          width: 8,
          height: 8,
          pixels: imgRGBA(8, 8, () => [0, 0, 255, 255]),
        }),
      ]),
    ],
  );
}

// --------------------------------------------------------------------------
// H. indexed-palette-per-frame
// --------------------------------------------------------------------------

function indexedPalettePerFrame() {
  // Every cel stores the SAME indices; only the palette moves. Frame 1 rewrites
  // entry 1 alone (a partial 0x2019 range), frame 2 has no palette chunk and
  // must inherit frame 1's, and its cel is a link back to frame 0 — whose
  // pixels were stored while entry 1 was still red.
  const indices = () => imgIndexed(8, 8, (x) => (x < 4 ? 1 : 2));
  return build(
    {
      frames: 3,
      width: 8,
      height: 8,
      depth: 8,
      flags: 1,
      speed: 100,
      transparentIndex: 0,
      colorCount: BASIC_PALETTE.length,
    },
    [
      frame(100, [
        colorProfileChunk(),
        paletteChunk(BASIC_PALETTE),
        layerChunk({ flags: 3, name: "Layer 1" }),
        celCompressed({ layerIndex: 0, x: 0, y: 0, width: 8, height: 8, pixels: indices() }),
      ]),
      frame(100, [
        paletteChunk([{ r: 0, g: 0, b: 255, a: 255 }], { size: BASIC_PALETTE.length, first: 1 }),
        celCompressed({ layerIndex: 0, x: 0, y: 0, width: 8, height: 8, pixels: indices() }),
      ]),
      frame(100, [celLinked({ layerIndex: 0, x: 0, y: 0, linkFrame: 0 })]),
    ],
  );
}

// --------------------------------------------------------------------------
// self-check: walk what we just wrote and prove the framing closes exactly
// --------------------------------------------------------------------------

function selfCheck(name, buf) {
  const fail = (msg) => {
    throw new Error(`${name}: ${msg}`);
  };
  if (buf.readUInt32LE(0) !== buf.length) fail("header file size != real length");
  if (buf.readUInt16LE(4) !== 0xa5e0) fail("bad magic");

  const frameCount = buf.readUInt16LE(6);
  let off = 128;
  for (let f = 0; f < frameCount; f++) {
    if (off + 16 > buf.length) fail(`frame ${f} header runs past EOF`);
    const frameBytes = buf.readUInt32LE(off);
    if (buf.readUInt16LE(off + 4) !== 0xf1fa) fail(`frame ${f} bad magic`);
    const oldCount = buf.readUInt16LE(off + 6);
    const newCount = buf.readUInt32LE(off + 12);
    if (oldCount !== newCount) fail(`frame ${f} chunk counts disagree`);
    const n = newCount !== 0 ? newCount : oldCount;

    let co = off + 16;
    for (let c = 0; c < n; c++) {
      const size = buf.readUInt32LE(co);
      if (size < 6) fail(`frame ${f} chunk ${c} size ${size} < 6`);
      co += size;
      if (co > off + frameBytes) fail(`frame ${f} chunk ${c} overruns the frame`);
    }
    if (co !== off + frameBytes)
      fail(`frame ${f} chunks end at ${co}, frame ends at ${off + frameBytes}`);
    off += frameBytes;
  }
  if (off !== buf.length) fail(`frames end at ${off}, file is ${buf.length} bytes`);
}

// --------------------------------------------------------------------------

const FIXTURES = [
  ["rgba-durations.aseprite", rgbaDurations],
  ["rgba-linked-and-raw.aseprite", rgbaLinkedAndRaw],
  ["indexed-transparent.aseprite", indexedTransparent],
  ["grayscale-oldpalette.aseprite", grayscaleOldPalette],
  ["layers-blend.aseprite", layersBlend],
  ["tags-directions.aseprite", tagsDirections],
  ["rgba-reference-layer.aseprite", rgbaReferenceLayer],
  ["indexed-palette-per-frame.aseprite", indexedPalettePerFrame],
];

mkdirSync(OUT_DIR, { recursive: true });
for (const [name, make] of FIXTURES) {
  const buf = make();
  selfCheck(name, buf);
  writeFileSync(new URL(name, OUT_DIR), buf);
  console.log(`${name.padEnd(32)} ${String(buf.length).padStart(5)} bytes`);
}
