// .aseprite reader tests.
//
// Two fixture corpora, deliberately kept apart:
//
//   fixtures/aseprite/excalibur/  — real files written by Aseprite itself
//     (BSD-2, vendored). They are ground truth for framing, but they all come
//     out of one "draw a beetle, hit save" workflow, so whole branches of the
//     format never appear in them.
//   fixtures/aseprite/generated/  — synthetic files from scripts/gen-ase-fixtures.mjs
//     that exercise exactly those branches (raw cels, linked cels, ping-pong
//     reverse, z-index, background layers, named palette entries, groups,
//     non-Normal blend modes, sub-255 layer opacity, old-style palette packets).
//     Its README.md is the test contract; every number asserted below is quoted
//     from there.
//
// Everything here asserts decoded pixels and metadata. "It parsed without
// throwing" is not a passing bar for a binary format — a reader that silently
// mis-offsets one field still parses.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  type AseBlendMode,
  type AseColorDepth,
  type AseCompositedFrame,
  type AseDocument,
  type AseTagDirection,
  blendInto,
  blendModeFromId,
  compositeFrame,
  compositeFrames,
  decodeAseprite,
  findCel,
  isAsepriteFile,
  parseAseprite,
} from "@/lib/aseprite";
import { inflateNode } from "@/lib/aseprite/inflate-node";

const PARSE_OPTS = { inflate: inflateNode };

// vitest test modules are ESM, so __dirname is not available; resolve fixtures
// off import.meta.url instead of the process cwd, which vitest does not pin.
function fixtureBytes(relative: string): Uint8Array {
  const url = new URL(`./fixtures/aseprite/${relative}`, import.meta.url);
  return new Uint8Array(readFileSync(fileURLToPath(url)));
}

function parse(relative: string): Promise<AseDocument> {
  return parseAseprite(fixtureBytes(relative), PARSE_OPTS);
}

type Rgba = [number, number, number, number];

function pixel(frame: AseCompositedFrame, x: number, y: number): Rgba {
  const i = (y * frame.width + x) * 4;
  return [frame.pixels[i], frame.pixels[i + 1], frame.pixels[i + 2], frame.pixels[i + 3]];
}

/** Pixel out of a cel's own buffer, in cel-local coordinates. */
function celPixel(pixels: Uint8ClampedArray, width: number, x: number, y: number): Rgba {
  const i = (y * width + x) * 4;
  return [pixels[i], pixels[i + 1], pixels[i + 2], pixels[i + 3]];
}

function countOpaque(frame: AseCompositedFrame): number {
  let n = 0;
  for (let i = 3; i < frame.pixels.length; i += 4) if (frame.pixels[i] > 0) n++;
  return n;
}

interface ChunkRef {
  /** Offset of the chunk's size DWORD; the type WORD sits four bytes later. */
  start: number;
  size: number;
  type: number;
}

/**
 * Independent mini chunk-walker, sharing no code with the parser. Used to patch
 * fields in place so branches no fixture reaches — an unknown chunk type, a
 * tilemap cel, a dangling cel link — can still be tested against real bytes.
 */
function frameChunks(bytes: Uint8Array, frameIndex: number): ChunkRef[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let frameStart = 128;
  for (let f = 0; ; f++) {
    const count = view.getUint32(frameStart + 12, true) || view.getUint16(frameStart + 6, true);
    let p = frameStart + 16;
    const chunks: ChunkRef[] = [];
    for (let i = 0; i < count; i++) {
      const size = view.getUint32(p, true);
      chunks.push({ start: p, size, type: view.getUint16(p + 4, true) });
      p += size;
    }
    if (f === frameIndex) return chunks;
    frameStart = p;
  }
}

function findChunk(bytes: Uint8Array, frameIndex: number, type: number): ChunkRef {
  const chunk = frameChunks(bytes, frameIndex).find((c) => c.type === type);
  if (!chunk) throw new Error(`fixture has no ${type.toString(16)} chunk in frame ${frameIndex}`);
  return chunk;
}

/** A mutable copy plus a DataView over it, for byte-level fixture surgery. */
function patchable(relative: string): { bytes: Uint8Array; view: DataView } {
  const bytes = new Uint8Array(fixtureBytes(relative));
  return { bytes, view: new DataView(bytes.buffer) };
}

function blendOnce(
  backdrop: Rgba,
  src: Rgba,
  mode: AseBlendMode,
  opacity = 255,
): [number, number, number, number] {
  const dst = new Uint8ClampedArray(backdrop);
  blendInto(dst, 0, src[0], src[1], src[2], src[3], mode, opacity);
  return [dst[0], dst[1], dst[2], dst[3]];
}

// ---------------------------------------------------------------------------
// Real Aseprite output
// ---------------------------------------------------------------------------

interface TagExpectation {
  name: string;
  from: number;
  to: number;
  direction: AseTagDirection;
}

/** The two tags every three-frame beetle file carries. */
const BEETLE_TAGS: TagExpectation[] = [
  { name: "Loop", from: 0, to: 2, direction: "pingpong" },
  { name: "Animation 2", from: 1, to: 2, direction: "reverse" },
];

interface ExcaliburCase {
  file: string;
  colorDepth: AseColorDepth;
  frameCount: number;
  layers: { name: string; opacity: number; visible: boolean }[];
  paletteLength: number;
  durationMs: number;
  tags: TagExpectation[];
  celCount: number;
  /** Opaque pixels in the DEFAULT composite of frame 0. */
  frame0Opaque: number;
}

const SINGLE_LAYER = [{ name: "Layer 1", opacity: 255, visible: true }];
// Header flag 1 is set in all of these, so NOTE.6 makes the layer opacity
// field meaningful and 141 must survive rather than being normalised to 255.
const TWO_LAYERS = [
  { name: "Layer 1", opacity: 141, visible: true },
  { name: "Layer 2", opacity: 255, visible: true },
];

const EXCALIBUR: ExcaliburCase[] = [
  {
    file: "beetle-rgba-multi-animation.aseprite",
    colorDepth: 32,
    frameCount: 3,
    layers: SINGLE_LAYER,
    paletteLength: 32,
    durationMs: 500,
    tags: BEETLE_TAGS,
    celCount: 3,
    frame0Opaque: 2793,
  },
  {
    file: "beetle-indexed-multi-animation.aseprite",
    colorDepth: 8,
    frameCount: 3,
    layers: SINGLE_LAYER,
    paletteLength: 32,
    durationMs: 500,
    tags: BEETLE_TAGS,
    celCount: 3,
    frame0Opaque: 2793,
  },
  {
    file: "beetle-grayscale-multi-animation.aseprite",
    colorDepth: 16,
    frameCount: 3,
    layers: SINGLE_LAYER,
    // Grayscale files carry only a deprecated 0x0004 chunk, which Aseprite
    // writes full-length.
    paletteLength: 256,
    durationMs: 500,
    tags: BEETLE_TAGS,
    celCount: 3,
    frame0Opaque: 2793,
  },
  {
    file: "beetle-rgba-multi-layer.aseprite",
    colorDepth: 32,
    frameCount: 3,
    layers: TWO_LAYERS,
    paletteLength: 32,
    durationMs: 500,
    tags: BEETLE_TAGS,
    celCount: 6,
    frame0Opaque: 2798,
  },
  {
    file: "beetle-indexed-multi-layer.aseprite",
    colorDepth: 8,
    frameCount: 3,
    layers: TWO_LAYERS,
    paletteLength: 32,
    durationMs: 500,
    tags: BEETLE_TAGS,
    celCount: 6,
    frame0Opaque: 2798,
  },
  {
    file: "beetle-grayscale-multi-layer.aseprite",
    colorDepth: 16,
    frameCount: 3,
    layers: TWO_LAYERS,
    paletteLength: 256,
    durationMs: 500,
    tags: BEETLE_TAGS,
    celCount: 6,
    frame0Opaque: 2798,
  },
  {
    file: "beetle-hidden-layer.aseprite",
    colorDepth: 32,
    frameCount: 3,
    layers: [
      { name: "Layer 1", opacity: 255, visible: true },
      { name: "Layer 2", opacity: 255, visible: false },
    ],
    paletteLength: 32,
    durationMs: 500,
    tags: BEETLE_TAGS,
    celCount: 6,
    // The hidden layer's 825 pixels are absent, so this matches the
    // single-layer files exactly.
    frame0Opaque: 2793,
  },
  {
    file: "beetle-indexed-no-alpha.aseprite",
    colorDepth: 8,
    frameCount: 1,
    layers: SINGLE_LAYER,
    paletteLength: 32,
    durationMs: 100,
    tags: [{ name: "Loop", from: 0, to: 0, direction: "forward" }],
    celCount: 1,
    frame0Opaque: 2793,
  },
];

describe("parseAseprite / real Aseprite files", () => {
  for (const expected of EXCALIBUR) {
    it(`decodes ${expected.file}`, async () => {
      const doc = await parse(`excalibur/${expected.file}`);

      expect(doc.width).toBe(64);
      expect(doc.height).toBe(64);
      expect(doc.frameCount).toBe(expected.frameCount);
      expect(doc.colorDepth).toBe(expected.colorDepth);
      expect(doc.pixelRatio).toEqual({ width: 1, height: 1 });
      expect(doc.palette).toHaveLength(expected.paletteLength);
      expect(doc.warnings).toEqual([]);

      expect(doc.layers.map((l) => l.name)).toEqual(expected.layers.map((l) => l.name));
      expect(doc.layers.map((l) => l.opacity)).toEqual(expected.layers.map((l) => l.opacity));
      expect(doc.layers.map((l) => l.visible)).toEqual(expected.layers.map((l) => l.visible));
      expect(doc.layers.map((l) => l.index)).toEqual(expected.layers.map((_, i) => i));
      for (const layer of doc.layers) {
        expect(layer.type).toBe("image");
        expect(layer.blendMode).toBe("normal");
        expect(layer.childLevel).toBe(0);
        expect(layer.parentIndex).toBeNull();
        expect(layer.background).toBe(false);
        expect(layer.reference).toBe(false);
      }

      expect(
        doc.tags.map((t) => ({ name: t.name, from: t.from, to: t.to, direction: t.direction })),
      ).toEqual(expected.tags);

      expect(doc.frames).toHaveLength(expected.frameCount);
      expect(doc.frames.every((f) => f.durationMs === expected.durationMs)).toBe(true);
      expect(doc.cels).toHaveLength(expected.celCount);

      const frames = compositeFrames(doc);
      expect(frames).toHaveLength(expected.frameCount);
      for (const frame of frames) {
        expect(frame.width).toBe(64);
        expect(frame.height).toBe(64);
        expect(frame.pixels).toHaveLength(64 * 64 * 4);
        expect(frame.durationMs).toBe(expected.durationMs);
      }
      expect(countOpaque(frames[0])).toBe(expected.frame0Opaque);
    });
  }

  it("keeps a Buffer's non-zero byteOffset in view", async () => {
    // readFileSync hands back a Buffer sliced out of Node's shared pool, so
    // byteOffset is routinely non-zero. A DataView built on `.buffer` without
    // passing byteOffset reads someone else's bytes.
    const url = new URL(
      "./fixtures/aseprite/excalibur/beetle-rgba-multi-layer.aseprite",
      import.meta.url,
    );
    const buffer = readFileSync(fileURLToPath(url));
    expect(isAsepriteFile(buffer)).toBe(true);
    const doc = await parseAseprite(buffer, PARSE_OPTS);
    expect(doc.width).toBe(64);
    expect(doc.layers.map((l) => l.name)).toEqual(["Layer 1", "Layer 2"]);
  });

  it("survives an unrecognised chunk type without desyncing the stream", async () => {
    const { bytes, view } = patchable("excalibur/beetle-rgba-multi-layer.aseprite");
    const profile = findChunk(bytes, 0, 0x2007); // Color Profile
    view.setUint16(profile.start + 4, 0x9999, true);
    const doc = await parseAseprite(bytes, PARSE_OPTS);

    expect(doc.warnings).toEqual(["Skipped unhandled chunk type 0x9999"]);
    // Everything after the mangled chunk still lands: only chunkSize walks the
    // stream, so a chunk we do not understand costs nothing but a warning.
    expect(doc.cels).toHaveLength(6);
    expect(doc.layers.map((l) => l.name)).toEqual(["Layer 1", "Layer 2"]);
    const reference = await parse("excalibur/beetle-rgba-multi-layer.aseprite");
    expect(compositeFrame(doc, 0).pixels).toEqual(compositeFrame(reference, 0).pixels);
  });

  it("normalises layer opacity to 255 when header flag 1 is clear (NOTE.6)", async () => {
    // No real fixture has flag 1 clear, so clear it on one that does: the 141
    // in the file must then be ignored, and every pixel become fully opaque.
    const bytes = fixtureBytes("excalibur/beetle-rgba-multi-layer.aseprite");
    const patched = new Uint8Array(bytes);
    new DataView(patched.buffer).setUint32(14, 0, true);

    const doc = await parseAseprite(patched, PARSE_OPTS);
    expect(doc.layers.map((l) => l.opacity)).toEqual([255, 255]);

    const alphas = new Set<number>();
    const frame = compositeFrame(doc, 0);
    for (let i = 3; i < frame.pixels.length; i += 4) alphas.add(frame.pixels[i]);
    expect([...alphas].sort((a, b) => a - b)).toEqual([0, 255]);
  });
});

describe("colour depth cross-checks", () => {
  // The beetle is the same artwork saved three ways. Anything that differs
  // between the three decodes is a colour-depth bug, not an art difference.
  for (const variant of ["multi-animation", "multi-layer"]) {
    it(`decodes rgba/indexed/grayscale ${variant} to the same alpha mask`, async () => {
      const rgbaFrames = compositeFrames(await parse(`excalibur/beetle-rgba-${variant}.aseprite`));
      const indexedFrames = compositeFrames(
        await parse(`excalibur/beetle-indexed-${variant}.aseprite`),
      );
      const grayFrames = compositeFrames(
        await parse(`excalibur/beetle-grayscale-${variant}.aseprite`),
      );

      expect(indexedFrames).toHaveLength(rgbaFrames.length);
      expect(grayFrames).toHaveLength(rgbaFrames.length);

      // Counted rather than asserted per pixel: ~50k individual expect() calls
      // take half a minute in vitest, and one tally is exactly as strong.
      let opaque = 0;
      let alphaMismatch = 0;
      let indexedRgbMismatch = 0;
      let grayNotNeutral = 0;
      for (let f = 0; f < rgbaFrames.length; f++) {
        const a = rgbaFrames[f].pixels;
        const b = indexedFrames[f].pixels;
        const g = grayFrames[f].pixels;
        for (let i = 0; i < a.length; i += 4) {
          if (b[i + 3] !== a[i + 3] || g[i + 3] !== a[i + 3]) alphaMismatch++;
          if (a[i + 3] === 0) continue;
          opaque++;
          // The sprite's own palette is 32 colours, so the indexed save is
          // lossless here: RGB must match exactly, not merely approximately.
          if (b[i] !== a[i] || b[i + 1] !== a[i + 1] || b[i + 2] !== a[i + 2]) {
            indexedRgbMismatch++;
          }
          // Grayscale unpacks (value, alpha); a byte-swap would break this.
          if (g[i] !== g[i + 1] || g[i + 1] !== g[i + 2]) grayNotNeutral++;
        }
      }
      expect(alphaMismatch).toBe(0);
      expect(indexedRgbMismatch).toBe(0);
      expect(grayNotNeutral).toBe(0);
      expect(opaque).toBeGreaterThan(8000);
    });
  }
});

describe("hidden layers", () => {
  it("omits a hidden layer by default and draws it with includeHiddenLayers", async () => {
    const doc = await parse("excalibur/beetle-hidden-layer.aseprite");
    expect(doc.layers[1].visible).toBe(false);
    expect(doc.layers[1].effectivelyVisible).toBe(false);
    // The cel is still in the file — hiding a layer does not delete its pixels.
    expect(findCel(doc, 0, 1)).toBeDefined();

    const hiddenOut = compositeFrame(doc, 0);
    const hiddenIn = compositeFrame(doc, 0, { includeHiddenLayers: true });

    // (22,16) sits inside "Layer 2"'s red patch and over "Layer 1"'s beetle.
    expect(pixel(hiddenOut, 22, 16)).toEqual([22, 22, 211, 255]);
    expect(pixel(hiddenIn, 22, 16)).toEqual([255, 0, 0, 255]);

    expect(countOpaque(hiddenOut)).toBe(2793);
    expect(countOpaque(hiddenIn)).toBe(2850);
  });

  it("extracts the hidden layer alone via layerIndices", async () => {
    const doc = await parse("excalibur/beetle-hidden-layer.aseprite");
    // effectivelyVisible folds in the layer's own flag, so a hidden layer needs
    // includeHiddenLayers even when it is the only one selected.
    expect(countOpaque(compositeFrame(doc, 0, { layerIndices: [1] }))).toBe(0);
    const only = compositeFrame(doc, 0, { layerIndices: [1], includeHiddenLayers: true });
    expect(countOpaque(only)).toBe(825);
    expect(pixel(only, 22, 16)).toEqual([255, 0, 0, 255]);
  });
});

// ---------------------------------------------------------------------------
// Generated fixtures — asserted against fixtures/aseprite/generated/README.md
// ---------------------------------------------------------------------------

describe("A. rgba-durations.aseprite — per-frame durations and an empty frame", () => {
  it("reads each frame's own duration, not the deprecated header speed", async () => {
    const doc = await parse("generated/rgba-durations.aseprite");
    // The header speed is 1000; a reader that falls back to it reports
    // [1000, 1000, 1000, 1000].
    expect(doc.frames.map((f) => f.durationMs)).toEqual([100, 250, 40, 33]);
    expect(compositeFrames(doc).map((f) => f.durationMs)).toEqual([100, 250, 40, 33]);
  });

  it("parses a frame that carries zero chunks", async () => {
    const doc = await parse("generated/rgba-durations.aseprite");
    expect(doc.frameCount).toBe(4);
    expect(doc.cels).toHaveLength(3);
    expect(findCel(doc, 3, 0)).toBeUndefined();

    const frames = compositeFrames(doc);
    expect(frames[3].pixels.every((v) => v === 0)).toBe(true);
    expect(frames[3].durationMs).toBe(33);
  });

  it("composites each frame's own quadrants", async () => {
    const frames = compositeFrames(await parse("generated/rgba-durations.aseprite"));
    expect(pixel(frames[0], 1, 1)).toEqual([255, 0, 0, 255]);
    expect(pixel(frames[0], 5, 1)).toEqual([0, 255, 0, 255]);
    expect(pixel(frames[0], 1, 5)).toEqual([0, 0, 255, 255]);
    expect(pixel(frames[0], 5, 5)).toEqual([255, 255, 0, 255]);
    // Frame 2's TL is blue: proof the three frames are not aliased buffers.
    expect(pixel(frames[2], 1, 1)).toEqual([0, 0, 255, 255]);
  });
});

describe("B. rgba-linked-and-raw.aseprite — all three cel types and edge clipping", () => {
  it("reports the same off-canvas geometry for compressed, raw and linked cels", async () => {
    const doc = await parse("generated/rgba-linked-and-raw.aseprite");
    expect(doc.cels).toHaveLength(3);
    for (const cel of doc.cels) {
      expect([cel.x, cel.y, cel.width, cel.height]).toEqual([-2, 1, 12, 4]);
      expect(cel.pixels).toHaveLength(12 * 4 * 4);
    }
  });

  it("decodes an uncompressed (type 0) cel", async () => {
    const doc = await parse("generated/rgba-linked-and-raw.aseprite");
    const raw = findCel(doc, 1, 0);
    expect(raw).toBeDefined();
    // Cel-local (2,0) is c=2, r=0 -> 2*20, 0*60, 200.
    expect(celPixel(raw!.pixels, 12, 2, 0)).toEqual([40, 0, 200, 255]);
    expect(celPixel(raw!.pixels, 12, 6, 0)).toEqual([0, 0, 0, 0]);
  });

  it("resolves a linked (type 1) cel to its source frame's pixels", async () => {
    const doc = await parse("generated/rgba-linked-and-raw.aseprite");
    const source = findCel(doc, 0, 0);
    const linked = findCel(doc, 2, 0);
    expect(linked!.pixels).toEqual(source!.pixels);
  });

  it("clips the overhanging cel instead of wrapping it", async () => {
    const frames = compositeFrames(await parse("generated/rgba-linked-and-raw.aseprite"));
    const frame = frames[0];

    // Cel columns c=0,1 fall off the left edge and c=10,11 off the right.
    expect(pixel(frame, 0, 1)).toEqual([40, 0, 0, 255]);
    expect(pixel(frame, 7, 4)).toEqual([180, 180, 0, 255]);
    expect(pixel(frame, 4, 2)).toEqual([0, 0, 0, 0]); // the transparent column
    expect(pixel(frame, 0, 0)).toEqual([0, 0, 0, 0]); // above the cel
    expect(pixel(frame, 3, 5)).toEqual([0, 0, 0, 0]); // below the cel

    // The clipped columns carry red 0, 20, 200 and 220. Seeing any of those
    // means the compositor wrapped a row rather than clipping it.
    const reds = new Set<number>();
    for (let i = 0; i < frame.pixels.length; i += 4) {
      if (frame.pixels[i + 3] > 0) reds.add(frame.pixels[i]);
    }
    expect([...reds].sort((a, b) => a - b)).toEqual([40, 60, 80, 100, 140, 160, 180]);

    // Frame 2 is the linked cel and must composite identically to frame 0.
    expect(frames[2].pixels).toEqual(frame.pixels);
    // Frame 1 is the raw cel: same geometry, blue 200.
    expect(pixel(frames[1], 0, 1)).toEqual([40, 0, 200, 255]);
    expect(pixel(frames[1], 7, 4)).toEqual([180, 180, 200, 255]);
  });
});

describe("C. indexed-transparent.aseprite — transparent index and background layers", () => {
  it("reads a variable-stride palette past a named entry", async () => {
    const doc = await parse("generated/indexed-transparent.aseprite");
    expect(doc.transparentIndex).toBe(3);
    // Entry 1 carries a name, so entries 2 and 3 only land correctly if the
    // reader advanced past that STRING instead of assuming a 6-byte stride.
    expect(doc.palette).toEqual([
      { r: 0, g: 0, b: 0, a: 255 },
      { r: 255, g: 0, b: 0, a: 255 },
      { r: 0, g: 255, b: 0, a: 255 },
      { r: 0, g: 0, b: 255, a: 255 },
    ]);
  });

  it("applies the transparent index per layer, not per file", async () => {
    const doc = await parse("generated/indexed-transparent.aseprite");
    expect(doc.layers.map((l) => [l.name, l.background])).toEqual([
      ["Background", true],
      ["Sprite", false],
    ]);

    // The same stored byte (index 3) on the two layers.
    const background = findCel(doc, 0, 0);
    const sprite = findCel(doc, 0, 1);
    expect(celPixel(background!.pixels, 8, 1, 1)).toEqual([0, 0, 255, 255]);
    expect(celPixel(sprite!.pixels, 8, 1, 1)).toEqual([0, 0, 0, 0]);
  });

  it("composites both layers", async () => {
    const frame = compositeFrame(await parse("generated/indexed-transparent.aseprite"), 0);
    expect(pixel(frame, 1, 1)).toEqual([0, 0, 255, 255]);
    expect(pixel(frame, 5, 1)).toEqual([0, 0, 0, 255]);
    expect(pixel(frame, 1, 5)).toEqual([255, 0, 0, 255]);
    expect(pixel(frame, 5, 5)).toEqual([0, 255, 0, 255]);
  });
});

describe("D. grayscale-oldpalette.aseprite — deprecated palette packets", () => {
  it("honours the per-packet skip byte", async () => {
    const doc = await parse("generated/grayscale-oldpalette.aseprite");
    expect(doc.colorDepth).toBe(16);
    // Packet 1 skips one entry, so its colours land at 4 and 5. Ignoring the
    // skip puts them at 3 and 4.
    expect(doc.palette[0]).toEqual({ r: 0, g: 0, b: 0, a: 255 });
    expect(doc.palette[1]).toEqual({ r: 64, g: 64, b: 64, a: 255 });
    expect(doc.palette[2]).toEqual({ r: 128, g: 128, b: 128, a: 255 });
    expect(doc.palette[4]).toEqual({ r: 200, g: 10, b: 20, a: 255 });
    expect(doc.palette[5]).toEqual({ r: 30, g: 200, b: 40, a: 255 });
    // Index 3 is written by no packet; the README says not to assert on it.
  });

  it("unpacks grayscale as (value, alpha)", async () => {
    const frame = compositeFrame(await parse("generated/grayscale-oldpalette.aseprite"), 0);
    // A byte-swap gives (255,255,255,0) at (7,0) instead.
    expect(pixel(frame, 0, 0)).toEqual([0, 0, 0, 255]);
    expect(pixel(frame, 4, 0)).toEqual([128, 128, 128, 255]);
    expect(pixel(frame, 7, 0)).toEqual([224, 224, 224, 255]);
    expect(pixel(frame, 0, 6)).toEqual([0, 0, 0, 128]);
    expect(pixel(frame, 4, 6)).toEqual([128, 128, 128, 128]);
    expect(pixel(frame, 7, 7)).toEqual([224, 224, 224, 128]);
  });
});

describe("E. layers-blend.aseprite — blend modes, z-index, groups", () => {
  it("reads the layer tree, blend modes and sub-255 opacity", async () => {
    const doc = await parse("generated/layers-blend.aseprite");
    expect(doc.layers.map((l) => l.name)).toEqual(["Base", "Mult", "Hidden", "Group", "Add"]);
    // NOTE.2: the group consumes a layer index, so its child is index 4.
    expect(doc.layers[3].type).toBe("group");
    expect(doc.layers[4].childLevel).toBe(1);
    expect(doc.layers[4].parentIndex).toBe(3);
    expect(doc.layers[0].parentIndex).toBeNull();

    expect(doc.layers[1].blendMode).toBe("multiply");
    expect(doc.layers[1].opacity).toBe(128);
    expect(doc.layers[4].blendMode).toBe("addition");
    expect(doc.layers[2].visible).toBe(false);
    expect(doc.layers[2].effectivelyVisible).toBe(false);

    expect(doc.cels.map((c) => [c.layerIndex, c.zIndex])).toEqual([
      [0, 0],
      [1, -1],
      [2, 0],
      [4, 2],
    ]);
  });

  it("orders cels by layerIndex + zIndex and blends the survivors", async () => {
    const frame = compositeFrame(await parse("generated/layers-blend.aseprite"), 0);

    expect(pixel(frame, 1, 1)).toEqual([100, 150, 200, 255]); // base only
    // Drawing the hidden layer would give 255,0,255,255 here.
    expect(pixel(frame, 5, 1)).toEqual([200, 100, 50, 255]);
    // Addition: 50+50, 200+40, 100+30. Dropping the group's child gives
    // 50,200,100,255.
    expect(pixel(frame, 1, 5)).toEqual([100, 240, 130, 255]);
    // zIndex -1 pushes Mult *under* the opaque Base, so the multiply never
    // shows. Ignoring zIndex gives 180,135,113,255.
    expect(pixel(frame, 5, 5)).toEqual([180, 180, 180, 255]);
  });

  it("draws the hidden layer only when asked", async () => {
    const doc = await parse("generated/layers-blend.aseprite");
    expect(pixel(compositeFrame(doc, 0, { includeHiddenLayers: true }), 5, 1)).toEqual([
      255, 0, 255, 255,
    ]);
  });

  it("records no warnings for a group with default blend and opacity", async () => {
    const doc = await parse("generated/layers-blend.aseprite");
    compositeFrame(doc, 0);
    expect(doc.warnings).toEqual([]);
  });
});

describe("F. tags-directions.aseprite — loop directions and tag colours", () => {
  it("reads all four loop directions including ping-pong reverse", async () => {
    const doc = await parse("generated/tags-directions.aseprite");
    expect(doc.frameCount).toBe(12);
    expect(
      doc.tags.map((t) => ({
        name: t.name,
        from: t.from,
        to: t.to,
        direction: t.direction,
        repeat: t.repeat,
      })),
    ).toEqual([
      { name: "forward", from: 0, to: 3, direction: "forward", repeat: 0 },
      { name: "reverse", from: 4, to: 7, direction: "reverse", repeat: 3 },
      { name: "pingpong", from: 8, to: 10, direction: "pingpong", repeat: 0 },
      { name: "pingpong_reverse", from: 11, to: 11, direction: "pingpong-reverse", repeat: 0 },
    ]);
  });

  it("takes tag colours from the trailing user data, not the deprecated field", async () => {
    const doc = await parse("generated/tags-directions.aseprite");
    // The in-chunk RGB bytes are all zero here; trusting them yields #000000
    // four times. Attaching the user data to "the last chunk read" without the
    // tags special case yields undefined four times.
    expect(doc.tags.map((t) => t.color)).toEqual(["#ff0000", "#00ff00", "#0000ff", "#ffff00"]);
  });

  it("keeps every frame distinguishable", async () => {
    const frames = compositeFrames(await parse("generated/tags-directions.aseprite"));
    expect(frames).toHaveLength(12);
    frames.forEach((frame, f) => {
      expect(pixel(frame, 0, 0)).toEqual([10 + f * 20, 0, 0, 255]);
    });
  });
});

describe("G. rgba-reference-layer.aseprite — reference layers never render", () => {
  it("reads Layer Chunk flag 64 onto AseLayer.reference", async () => {
    const doc = await parse("generated/rgba-reference-layer.aseprite");
    expect(doc.layers.map((l) => [l.name, l.reference, l.visible])).toEqual([
      ["Art", false, true],
      ["Reference", true, true],
    ]);
    // The pixels are still in the document; only compositing leaves them out.
    expect(findCel(doc, 0, 1)).toBeDefined();
  });

  it("leaves the reference layer out of the composite, even with includeHiddenLayers", async () => {
    const doc = await parse("generated/rgba-reference-layer.aseprite");
    for (const opts of [{}, { includeHiddenLayers: true }]) {
      const frame = compositeFrame(doc, 0, opts);
      // Compositing the opaque blue reference layer on top gives 0,0,255,255
      // at both points.
      expect(pixel(frame, 1, 1)).toEqual([255, 0, 0, 255]);
      expect(pixel(frame, 5, 1)).toEqual([0, 0, 0, 0]);
      expect(countOpaque(frame)).toBe(32);
    }
    expect(countOpaque(compositeFrame(doc, 0, { layerIndices: [1] }))).toBe(0);
    expect(doc.warnings).toEqual([]);
  });

  it("drops a reference layer from a real Aseprite file", async () => {
    // OR flag 64 into "Layer 2" of a real file: its 5 pixels outside Layer 1's
    // silhouette must vanish, leaving exactly the single-layer count.
    const { bytes, view } = patchable("excalibur/beetle-rgba-multi-layer.aseprite");
    const layer2 = frameChunks(bytes, 0).filter((c) => c.type === 0x2004)[1];
    view.setUint16(layer2.start + 6, view.getUint16(layer2.start + 6, true) | 64, true);

    const doc = await parseAseprite(bytes, PARSE_OPTS);
    expect(doc.layers[1].reference).toBe(true);
    expect(countOpaque(compositeFrame(doc, 0))).toBe(2793);
  });
});

describe("H. indexed-palette-per-frame.aseprite — palettes resolve per frame", () => {
  it("decodes each frame's cels against the palette in effect at that frame", async () => {
    const doc = await parse("generated/indexed-palette-per-frame.aseprite");
    expect(doc.warnings).toEqual([]);
    const frames = compositeFrames(doc);
    // One global palette (the last one written) gives blue in all three.
    expect(pixel(frames[0], 1, 1)).toEqual([255, 0, 0, 255]);
    expect(pixel(frames[1], 1, 1)).toEqual([0, 0, 255, 255]);
    // Entry 2 is never rewritten, so it survives the partial palette update.
    expect(pixel(frames[0], 5, 1)).toEqual([0, 255, 0, 255]);
    expect(pixel(frames[1], 5, 1)).toEqual([0, 255, 0, 255]);
  });

  it("carries the last palette forward into frames that write none", async () => {
    const doc = await parse("generated/indexed-palette-per-frame.aseprite");
    // Frame 2 links to frame 0's pixels but is shown under frame 1's palette,
    // which is what Aseprite renders (render.cpp looks up palette(frame) for
    // the frame being drawn, and a link shares the image, not the colours).
    expect(pixel(compositeFrame(doc, 2), 1, 1)).toEqual([0, 0, 255, 255]);
    // ...without recolouring the frame-0 cel it links to.
    expect(celPixel(findCel(doc, 0, 0)!.pixels, 8, 1, 1)).toEqual([255, 0, 0, 255]);
  });

  it("keeps doc.palette as the frame-0 palette", async () => {
    const doc = await parse("generated/indexed-palette-per-frame.aseprite");
    expect(doc.palette).toEqual([
      { r: 0, g: 0, b: 0, a: 255 },
      { r: 255, g: 0, b: 0, a: 255 },
      { r: 0, g: 255, b: 0, a: 255 },
      { r: 0, g: 0, b: 255, a: 255 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Format branches no fixture reaches, tested by patching real bytes
// ---------------------------------------------------------------------------

describe("unsupported and malformed cels", () => {
  it("skips a compressed tilemap cel (type 3) with a warning instead of decoding garbage", async () => {
    // No vendored fixture writes a type-3 cel, and its fixed tail is 32 bytes
    // rather than the 4 of an image cel — reading it as an image would take the
    // tile bitmasks for pixel data. Retyping a real cel proves the skip.
    const { bytes, view } = patchable("generated/rgba-durations.aseprite");
    const cel = findChunk(bytes, 0, 0x2005);
    view.setUint16(cel.start + 6 + 7, 3, true);

    const doc = await parseAseprite(bytes, PARSE_OPTS);
    expect(doc.warnings).toEqual([
      "Compressed tilemap cels (type 3) are not supported; those cels are omitted",
    ]);
    expect(doc.cels).toHaveLength(2);
    expect(findCel(doc, 0, 0)).toBeUndefined();

    const frames = compositeFrames(doc);
    expect(frames[0].pixels.every((v) => v === 0)).toBe(true);
    // The chunk walk advances by chunkSize, so the following frames are intact.
    expect(pixel(frames[1], 1, 1)).toEqual([255, 255, 0, 255]);
    expect(pixel(frames[2], 1, 1)).toEqual([0, 0, 255, 255]);
  });

  it("skips a cel type the spec does not define", async () => {
    const { bytes, view } = patchable("generated/rgba-durations.aseprite");
    view.setUint16(findChunk(bytes, 0, 0x2005).start + 6 + 7, 7, true);

    const doc = await parseAseprite(bytes, PARSE_OPTS);
    expect(doc.warnings).toEqual(["Unknown cel type 7 at frame 0, layer 0; cel skipped"]);
    expect(doc.cels).toHaveLength(2);
  });

  it("drops a linked cel whose target frame has no cel on that layer", async () => {
    // Frame 2's cel links to frame 0; repoint it at frame 3, which does not
    // exist. A reader that trusts the link blindly dereferences undefined.
    const { bytes, view } = patchable("generated/rgba-linked-and-raw.aseprite");
    view.setUint16(findChunk(bytes, 2, 0x2005).start + 6 + 16, 3, true);

    const doc = await parseAseprite(bytes, PARSE_OPTS);
    expect(doc.warnings).toEqual([
      "Linked cel at frame 2, layer 0 points at frame 3, which has no cel on that layer; " +
        "the cel was dropped",
    ]);
    expect(doc.cels).toHaveLength(2);
    expect(compositeFrame(doc, 2).pixels.every((v) => v === 0)).toBe(true);
    // Frames 0 and 1 are untouched.
    expect(pixel(compositeFrame(doc, 0), 0, 1)).toEqual([40, 0, 0, 255]);
  });

  it("skips one corrupt compressed cel with a warning naming its frame and layer", async () => {
    // Flip two bytes in the middle of frame 1's zlib stream for "Layer 1". One
    // bad cel in a long animation must cost that cel, not the whole document.
    const { bytes } = patchable("excalibur/beetle-rgba-multi-layer.aseprite");
    const view = new DataView(bytes.buffer);
    const cel = frameChunks(bytes, 1).find(
      (c) => c.type === 0x2005 && view.getUint16(c.start + 6, true) === 0,
    );
    expect(cel).toBeDefined();
    // 6 chunk header + 16 common cel fields + 4 width/height, then zlib.
    const zlibStart = cel!.start + 6 + 16 + 4;
    const mid = zlibStart + Math.floor((cel!.start + cel!.size - zlibStart) / 2);
    bytes[mid] ^= 0xff;
    bytes[mid + 1] ^= 0xff;

    const doc = await parseAseprite(bytes, PARSE_OPTS);
    expect(doc.warnings).toHaveLength(1);
    expect(doc.warnings[0]).toMatch(
      /frame 1, layer "Layer 1": zlib inflate failed: .+; the cel was skipped/,
    );
    expect(doc.cels).toHaveLength(5);
    expect(findCel(doc, 1, 0)).toBeUndefined();
    expect(findCel(doc, 1, 1)).toBeDefined();

    const reference = await parse("excalibur/beetle-rgba-multi-layer.aseprite");
    expect(compositeFrame(doc, 0).pixels).toEqual(compositeFrame(reference, 0).pixels);
    expect(compositeFrame(doc, 2).pixels).toEqual(compositeFrame(reference, 2).pixels);
  });

  it("warns when a cel on an RGBA sprite names a layer index with no layer chunk", async () => {
    // The 8bpp path used to be the only one that noticed; an RGBA cel simply
    // vanished at composite time with nothing said.
    const { bytes, view } = patchable("generated/rgba-durations.aseprite");
    view.setUint16(findChunk(bytes, 0, 0x2005).start + 6, 9, true);

    const doc = await parseAseprite(bytes, PARSE_OPTS);
    expect(doc.warnings).toEqual([
      "Cel at frame 0 references layer index 9, which has no layer chunk; it cannot be composited",
    ]);
    expect(compositeFrame(doc, 0).pixels.every((v) => v === 0)).toBe(true);
    expect(pixel(compositeFrame(doc, 1), 1, 1)).toEqual([255, 255, 0, 255]);
  });
});

describe("chunk-bounded record reads", () => {
  it("stops a tags chunk at its own end instead of reading the next chunk as a tag", async () => {
    // Shorten tag 1's name STRING by 4 bytes and claim a third tag. Framing is
    // still valid, but the would-be third record starts 4 bytes before the
    // chunk ends; reading it through takes its fields from the next chunk.
    const { bytes, view } = patchable("excalibur/beetle-rgba-multi-layer.aseprite");
    const tags = findChunk(bytes, 0, 0x2018);
    const payload = tags.start + 6;
    let p = payload + 2 + 8; // tag count WORD + 8 reserved bytes
    p += 17; // tag 0 fixed fields
    p += 2 + view.getUint16(p, true); // tag 0 name
    p += 17; // tag 1 fixed fields
    view.setUint16(p, view.getUint16(p, true) - 4, true);
    view.setUint16(payload, 3, true);

    const doc = await parseAseprite(bytes, PARSE_OPTS);
    expect(doc.tags.map((t) => t.name)).toEqual(["Loop", "Animati"]);
    expect(doc.warnings).toHaveLength(1);
    expect(doc.warnings[0]).toMatch(
      /^Frame 0 chunk \d+ \(type 0x2018\) has a record running past the chunk's declared end/,
    );
    // The chunk after the tags is intact.
    expect(doc.cels).toHaveLength(6);
    expect(doc.layers.map((l) => l.name)).toEqual(["Layer 1", "Layer 2"]);
  });

  it("skips an oversized user data properties block without aborting the parse", async () => {
    // Retype tag 0's user data as "has properties" only. Its Size DWORD then
    // reads the RGBA bytes 255,0,0,255 = 0xff0000ff, far past the chunk.
    const { bytes, view } = patchable("generated/tags-directions.aseprite");
    const userData = findChunk(bytes, 0, 0x2020);
    view.setUint32(userData.start + 6, 4, true);

    const doc = await parseAseprite(bytes, PARSE_OPTS);
    expect(doc.warnings).toEqual([
      "User data properties block declares 4278190335 bytes but only 0 remain in its chunk; " +
        "the properties were skipped",
    ]);
    expect(doc.frameCount).toBe(12);
    // Tag 0's user data carried no colour any more; the other three still
    // line up with their own user data chunks.
    expect(doc.tags.map((t) => t.color)).toEqual([undefined, "#00ff00", "#0000ff", "#ffff00"]);
    expect(pixel(compositeFrame(doc, 11), 0, 0)).toEqual([230, 0, 0, 255]);
  });

  it("keeps a layer whose name overruns its chunk, so later layer indices stay aligned", async () => {
    const { bytes, view } = patchable("excalibur/beetle-rgba-multi-layer.aseprite");
    const layer2 = frameChunks(bytes, 0).filter((c) => c.type === 0x2004)[1];
    // Name length WORD sits after 16 bytes of fixed layer fields.
    view.setUint16(layer2.start + 6 + 16, 60000, true);

    const doc = await parseAseprite(bytes, PARSE_OPTS);
    expect(doc.warnings).toEqual([
      "Layer 1 chunk runs past its declared size; its name and any unread fields were defaulted",
    ]);
    expect(doc.layers.map((l) => l.name)).toEqual(["Layer 1", ""]);
    // Its flags were read before the name, so it is still visible and draws.
    expect(doc.layers[1].visible).toBe(true);
    const reference = await parse("excalibur/beetle-rgba-multi-layer.aseprite");
    expect(compositeFrame(doc, 0).pixels).toEqual(compositeFrame(reference, 0).pixels);
  });
});

describe("old FLI palette chunks", () => {
  it("scales a 0x0011 chunk's 6-bit components up to 8 bits", async () => {
    // 0x0011 stores 0-63 per channel; 0x0004 stores 0-255. No fixture carries
    // the 6-bit variant, so retype the grayscale file's 0x0004 chunk and rewrite
    // its colour bytes into 6-bit range. A reader that skips the scaling reports
    // 32,32,32 for the mid entry instead of 130,130,130.
    const { bytes, view } = patchable("generated/grayscale-oldpalette.aseprite");
    const chunk = findChunk(bytes, 0, 0x0004);
    view.setUint16(chunk.start + 4, 0x0011, true);
    // Payload: WORD packet count, then per packet a skip BYTE, a count BYTE and
    // three bytes per colour. Packet 0 holds 3 colours, packet 1 holds 2.
    const packet0 = chunk.start + 6 + 2 + 2;
    bytes.set([0, 0, 0, 32, 32, 32, 63, 63, 63], packet0);
    bytes.set([63, 0, 0, 0, 63, 0], packet0 + 9 + 2);

    const doc = await parseAseprite(bytes, PARSE_OPTS);
    expect(doc.palette[0]).toEqual({ r: 0, g: 0, b: 0, a: 255 });
    expect(doc.palette[1]).toEqual({ r: 130, g: 130, b: 130, a: 255 });
    expect(doc.palette[2]).toEqual({ r: 255, g: 255, b: 255, a: 255 });
    // The skip byte still applies, so these land at 4 and 5, not 3 and 4.
    expect(doc.palette[4]).toEqual({ r: 255, g: 0, b: 0, a: 255 });
    expect(doc.palette[5]).toEqual({ r: 0, g: 255, b: 0, a: 255 });
  });

  it("scales 6-bit components by bit replication, as Aseprite does", async () => {
    // scale_6bits_to_8bits is (v << 2) | (v >> 4):
    //   15 -> 60 | 0 = 60    (round(15*255/63) = round(60.71) = 61)
    //   48 -> 192 | 3 = 195  (round(48*255/63) = round(194.29) = 194)
    const { bytes, view } = patchable("generated/grayscale-oldpalette.aseprite");
    const chunk = findChunk(bytes, 0, 0x0004);
    view.setUint16(chunk.start + 4, 0x0011, true);
    bytes.set([15, 48, 15, 48, 15, 48, 0, 0, 0], chunk.start + 6 + 2 + 2);

    const doc = await parseAseprite(bytes, PARSE_OPTS);
    expect(doc.palette[0]).toEqual({ r: 60, g: 195, b: 60, a: 255 });
    expect(doc.palette[1]).toEqual({ r: 195, g: 60, b: 195, a: 255 });
  });

  it("reads chunk type 0x000B as the 6-bit palette too", async () => {
    // Aseprite's decoder defines ASE_FILE_CHUNK_FLI_COLOR as decimal 11, not
    // hex 0x11. Without that case a genuine old file falls through to
    // "Skipped unhandled chunk type 0x000b" with an empty palette.
    const { bytes, view } = patchable("generated/grayscale-oldpalette.aseprite");
    const chunk = findChunk(bytes, 0, 0x0004);
    view.setUint16(chunk.start + 4, 0x000b, true);
    bytes.set([0, 0, 0, 32, 32, 32, 63, 63, 63], chunk.start + 6 + 2 + 2);

    const doc = await parseAseprite(bytes, PARSE_OPTS);
    expect(doc.warnings).toEqual([]);
    expect(doc.palette[1]).toEqual({ r: 130, g: 130, b: 130, a: 255 });
    expect(doc.palette[2]).toEqual({ r: 255, g: 255, b: 255, a: 255 });
  });
});

describe("grayscale blending", () => {
  /** A 1x1 two-layer document: grey 60 backdrop, grey 200 on top in `mode`. */
  function twoLayerGrey(mode: AseBlendMode, colorDepth: AseColorDepth): AseDocument {
    const layer = (index: number, blendMode: AseBlendMode) => ({
      index,
      name: `L${index}`,
      type: "image" as const,
      childLevel: 0,
      parentIndex: null,
      visible: true,
      effectivelyVisible: true,
      background: false,
      reference: false,
      blendMode,
      opacity: 255,
    });
    const cel = (layerIndex: number, v: number) => ({
      frameIndex: 0,
      layerIndex,
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      opacity: 255,
      zIndex: 0,
      pixels: new Uint8ClampedArray([v, v, v, 255]),
    });
    return {
      width: 1,
      height: 1,
      frameCount: 1,
      colorDepth,
      transparentIndex: 0,
      palette: [],
      layers: [layer(0, "normal"), layer(1, mode)],
      tags: [],
      frames: [{ durationMs: 100 }],
      cels: [cel(0, 60), cel(1, 200)],
      pixelRatio: { width: 1, height: 1 },
      warnings: [],
    };
  }

  it("maps the four HSL modes to Normal for 16bpp sprites, like get_graya_blender", () => {
    // blend_funcs.cpp get_graya_blender: HSL_HUE/SATURATION/COLOR/LUMINOSITY
    // all return graya_blender_normal, so the grey-200 source simply covers.
    for (const mode of ["hue", "saturation", "color", "luminosity"] as const) {
      expect(pixel(compositeFrame(twoLayerGrey(mode, 16), 0), 0, 0)).toEqual([200, 200, 200, 255]);
    }
    // The RGBA path keeps the real HSL maths: on a grey source sat() is 0, so
    // hue keeps the backdrop's luminosity and the source disappears.
    expect(pixel(compositeFrame(twoLayerGrey("hue", 32), 0), 0, 0)).toEqual([60, 60, 60, 255]);
    // Separable modes are unaffected by colour depth.
    expect(pixel(compositeFrame(twoLayerGrey("darken", 16), 0), 0, 0)).toEqual([60, 60, 60, 255]);
  });
});

describe("group layers", () => {
  it("warns that a group's own blend mode is not applied when flattening", async () => {
    // Compositing flattens groups, so a group carrying a non-default blend mode
    // produces an image that is not what the editor showed. Silence there would
    // be the worst outcome; the warning is the contract.
    const { bytes, view } = patchable("generated/layers-blend.aseprite");
    const group = frameChunks(bytes, 0).filter((c) => c.type === 0x2004)[3];
    view.setUint16(group.start + 6 + 10, 1, true); // blend mode -> multiply

    const doc = await parseAseprite(bytes, PARSE_OPTS);
    expect(doc.layers[3].type).toBe("group");
    expect(doc.layers[3].blendMode).toBe("multiply");

    const frame = compositeFrame(doc, 0);
    expect(doc.warnings).toEqual([
      'Layer group "Group" carries blend mode "multiply" and opacity 255; compositing flattens ' +
        "groups, so the group's own blend mode and opacity were not applied.",
    ]);
    // The child still draws — flattening ignores the group, it does not drop it.
    expect(pixel(frame, 1, 5)).toEqual([100, 240, 130, 255]);
  });
});

// ---------------------------------------------------------------------------
// Blend maths
// ---------------------------------------------------------------------------

describe("blendInto", () => {
  it("maps blend mode ids to names and rejects unknown ids", () => {
    expect(blendModeFromId(0)).toBe("normal");
    expect(blendModeFromId(16)).toBe("addition");
    expect(blendModeFromId(18)).toBe("divide");
    expect(blendModeFromId(19)).toBeNull();
    expect(blendModeFromId(-1)).toBeNull();
  });

  it("reproduces Aseprite's integer per-channel formulas", () => {
    const grey = (v: number): Rgba => [v, v, v, 255];
    // MUL_UN8(128,128)=64, (64,128)=32, (32,128)=16.
    expect(blendOnce([128, 64, 32, 255], grey(128), "multiply")).toEqual([64, 32, 16, 255]);
    // 128 + 128 - MUL_UN8(128,128).
    expect(blendOnce(grey(128), grey(128), "screen")).toEqual([192, 192, 192, 255]);
    // hard light branches on `s < 128`, not on `s/255 <= 0.5`: the pair 127/128
    // is asymmetric and a float formulation cannot produce it.
    expect(blendOnce(grey(100), grey(127), "hard-light")).toEqual([100, 100, 100, 255]);
    expect(blendOnce(grey(100), grey(128), "hard-light")).toEqual([101, 101, 101, 255]);
    // Overlay is hard light with the operands SWAPPED; unswapped gives 78.
    expect(blendOnce(grey(200), grey(50), "overlay")).toEqual([167, 167, 167, 255]);
    expect(blendOnce(grey(200), grey(50), "difference")).toEqual([150, 150, 150, 255]);
    expect(blendOnce(grey(128), grey(128), "exclusion")).toEqual([128, 128, 128, 255]);
    expect(blendOnce(grey(128), grey(200), "soft-light")).toEqual([158, 158, 158, 255]);
    // DIV_UN8(64,128) = (64*255 + 64) / 128.
    expect(blendOnce(grey(64), grey(128), "divide")).toEqual([128, 128, 128, 255]);
    expect(blendOnce(grey(200), grey(100), "addition")).toEqual([255, 255, 255, 255]);
    expect(blendOnce(grey(10), grey(30), "subtract")).toEqual([0, 0, 0, 255]);
  });

  // Expected values below are hand-derived from blend_funcs.cpp, not read back
  // from blend.ts. Every case is opaque over opaque at opacity 255 unless noted,
  // where RGBA_BLENDER_N collapses to the base blender and rgba_blender_normal
  // returns the blended colour unchanged (Sa=255 gives Ra=255, Rc=Sc). They
  // were also cross-checked against blend_funcs.cpp itself, compiled with a
  // four-line harness around get_rgba_blender(mode, true).
  it("reproduces darken, lighten, color dodge and color burn", () => {
    // blend_darken/lighten are std::min/std::max per channel.
    expect(blendOnce([100, 150, 200, 255], [150, 100, 200, 255], "darken")).toEqual([
      100, 100, 200, 255,
    ]);
    expect(blendOnce([100, 150, 200, 255], [150, 100, 200, 255], "lighten")).toEqual([
      150, 150, 200, 255,
    ]);
    // blend_color_dodge(b, s): b==0 -> 0; s'=255-s; b>=s' -> 255; else DIV_UN8(b, s').
    //   R: b=100, s'=155 -> (100*255 + 155/2) / 155 = 25577 / 155 = 165
    //   G: b=0 -> 0
    //   B: b=200 >= 155 -> 255
    expect(blendOnce([100, 0, 200, 255], [100, 100, 100, 255], "color-dodge")).toEqual([
      165, 0, 255, 255,
    ]);
    // blend_color_burn(b, s): b==255 -> 255; b'=255-b; b'>=s -> 0; else 255 - DIV_UN8(b', s).
    //   R: b'=155 < 200 -> 255 - (155*255 + 100) / 200 = 255 - 39625/200 = 255 - 198 = 57
    //   G: b=255 -> 255
    //   B: b'=205 >= 100 -> 0
    expect(blendOnce([100, 255, 50, 255], [200, 200, 100, 255], "color-burn")).toEqual([
      57, 255, 0, 255,
    ]);
  });

  it("applies the New Blend Method to darken over a half-transparent backdrop", () => {
    // Backdrop (200,100,50,128), source (100,150,50,255), opacity 255.
    //   normal = rgba_blender_normal: Sa=255, Ra = 255+128-MUL_UN8(128,255)=255,
    //            Rc = Sc                                   -> (100,150,50,255)
    //   blend  = darken -> min per channel = (100,100,50), then normal -> (100,100,50,255)
    //   merge(normal, blend, Ba=128):
    //            G = 150 + MUL_UN8(-50,128): t=-6272, ((t>>8)+t)>>8 = (-25-6272)>>8 = -25
    //                                                    -> (100,125,50,255)
    //   compositeAlpha = MUL_UN8(128, MUL_UN8(255,255)=255) = 128
    //   merge(that, blend, 128):
    //            G = 125 + MUL_UN8(-25,128): t=-3072, (-12-3072)>>8 = -13
    //                                                    -> (100,112,50,255)
    // The plain darken blender alone would give green 100.
    expect(blendOnce([200, 100, 50, 128], [100, 150, 50, 255], "darken")).toEqual([
      100, 112, 50, 255,
    ]);
  });

  it("reproduces the four non-separable HSL modes", () => {
    // Working in 1/255 units throughout. lum = 0.3r + 0.59g + 0.11b.
    // Backdrop B = (200,100,50): lum(B) = 60 + 59 + 5.5 = 124.5, sat(B) = 150.
    const B: Rgba = [200, 100, 50, 255];

    // hue: set_sat(S, sat(B)) then set_lum(.., lum(B)), S = (50,150,100).
    //   set_sat: min 50, range 100 -> (0,100,50) * 150/100 = (0,150,75)
    //   set_lum: lum = 0 + 88.5 + 8.25 = 96.75, d = 27.75 -> (27.75,177.75,102.75)
    //   no channel < 0 or > 255, so clip_color is a no-op; int() truncates.
    expect(blendOnce(B, [50, 150, 100, 255], "hue")).toEqual([27, 177, 102, 255]);

    // saturation: set_sat(B, sat(S)=100) then set_lum(.., lum(B)).
    //   set_sat: min 50, range 150 -> (150,50,0) * 100/150 = (100,33.33,0)
    //   set_lum: lum = 30 + 19.67 = 49.67, d = 74.83 -> (174.83,108.17,74.83)
    expect(blendOnce(B, [50, 150, 100, 255], "saturation")).toEqual([174, 108, 74, 255]);

    // color: set_lum(S, lum(B)), S = (51,150,100).
    //   lum(S) = 15.3 + 88.5 + 11 = 114.8, d = 9.7 -> (60.7,159.7,109.7)
    expect(blendOnce(B, [51, 150, 100, 255], "color")).toEqual([60, 159, 109, 255]);

    // luminosity: set_lum(B, lum(S) = 114.8), d = -9.7 -> (190.3,90.3,40.3)
    expect(blendOnce(B, [51, 150, 100, 255], "luminosity")).toEqual([190, 90, 40, 255]);

    // luminosity through clip_color's x > 1 branch.
    //   B = (250,10,10): lum = 75 + 5.9 + 1.1 = 82. S = (230,230,230): lum = 230.
    //   set_lum: d = 148 -> (398,158,158); l = 230, x = 398 > 255
    //   clip: c = l + (c - l) * (255 - l) / (x - l)
    //         R: 230 + 168 * 25 / 168 = 255
    //         G,B: 230 - 72 * 25 / 168 = 230 - 10.71 = 219.29 -> 219
    expect(blendOnce([250, 10, 10, 255], [230, 230, 230, 255], "luminosity")).toEqual([
      255, 219, 219, 255,
    ]);
  });

  it("keeps source RGB bit-exact over a transparent backdrop", () => {
    // The short-circuit scales alpha only; running the interpolation instead
    // drifts the colour channels.
    expect(blendOnce([0, 0, 0, 0], [200, 100, 50, 128], "normal")).toEqual([200, 100, 50, 128]);
    // Ra = 128 + 255 - MUL_UN8(255,128) = 255; Rr = 0 + 255*128/255.
    expect(blendOnce([0, 0, 0, 255], [255, 255, 255, 128], "normal")).toEqual([128, 128, 128, 255]);
  });

  it("leaves the backdrop untouched for a zero-alpha source", () => {
    expect(blendOnce([1, 2, 3, 4], [9, 9, 9, 0], "normal")).toEqual([1, 2, 3, 4]);
  });

  it("applies the New Blend Method when the backdrop is partly transparent", () => {
    // Hand-derived from RGBA_BLENDER_N: normal=(0,0,255,255), blend=(0,0,0,255),
    // merge at Ba=128 -> (0,0,127,255), merge again at compositeAlpha=128 -> 63.
    // A reader that only implements the base blender returns 0 for blue here.
    expect(blendOnce([255, 0, 0, 128], [0, 0, 255, 255], "multiply")).toEqual([0, 0, 63, 255]);
    // Both alphas 255 collapses the wrapper back to the plain blend.
    expect(blendOnce([255, 0, 0, 255], [0, 0, 255, 255], "multiply")).toEqual([0, 0, 0, 255]);
  });
});

// ---------------------------------------------------------------------------
// Robustness
// ---------------------------------------------------------------------------

describe("malformed input", () => {
  it("rejects an empty buffer", async () => {
    await expect(parseAseprite(new Uint8Array(0), PARSE_OPTS)).rejects.toThrow(
      /at least a 128-byte header/,
    );
  });

  it("rejects a buffer shorter than the header", async () => {
    await expect(parseAseprite(new Uint8Array(127), PARSE_OPTS)).rejects.toThrow(
      /Not an Aseprite file/,
    );
  });

  it("rejects a bad magic number", async () => {
    const bytes = fixtureBytes("excalibur/beetle-rgba-multi-layer.aseprite");
    const patched = new Uint8Array(bytes);
    new DataView(patched.buffer).setUint16(4, 0x1234, true);
    await expect(parseAseprite(patched, PARSE_OPTS)).rejects.toThrow(
      /header magic is 0x1234, expected 0xa5e0/,
    );
  });

  it("rejects an unsupported colour depth", async () => {
    const patched = new Uint8Array(fixtureBytes("excalibur/beetle-rgba-multi-layer.aseprite"));
    new DataView(patched.buffer).setUint16(12, 24, true);
    await expect(parseAseprite(patched, PARSE_OPTS)).rejects.toThrow(
      /Unsupported Aseprite colour depth 24/,
    );
  });

  it("rejects truncation at every stage of the walk", async () => {
    const bytes = fixtureBytes("excalibur/beetle-rgba-multi-layer.aseprite");
    // 128: header only. 200: mid first-frame chunk list. 1000/2000/3000: inside
    // a cel chunk in frames 0, 1 and 2.
    for (const length of [128, 140, 200, 1000, 2000, 3000, bytes.length - 1]) {
      await expect(parseAseprite(bytes.slice(0, length), PARSE_OPTS)).rejects.toThrow(
        /Truncated \.aseprite file/,
      );
    }
  });

  it("rejects a chunk that declares an impossible size", async () => {
    const bytes = fixtureBytes("excalibur/beetle-rgba-multi-layer.aseprite");
    const patched = new Uint8Array(bytes);
    // Chunk size is self-inclusive, so anything below 6 cannot be walked.
    new DataView(patched.buffer).setUint32(128 + 16, 3, true);
    await expect(parseAseprite(patched, PARSE_OPTS)).rejects.toThrow(/below the 6-byte minimum/);
  });

  it("clamps an absurd palette size instead of allocating for it", async () => {
    // `New palette size` and the first/last entry indices are untrusted DWORDs
    // that the reader grows an array to reach. Left unbounded, one corrupt byte
    // asks for millions of entries and the parse never returns — a hostile
    // upload could wedge the tab before a pixel is decoded.
    const { bytes, view } = patchable("generated/rgba-durations.aseprite");
    const palette = findChunk(bytes, 0, 0x2019);
    view.setUint32(palette.start + 6, 0xffffffff, true);

    const started = Date.now();
    const doc = await parseAseprite(bytes, PARSE_OPTS);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(doc.palette.length).toBe(0x10000);
    expect(doc.warnings).toEqual([
      "Palette declares 4294967295 entries, which is past the 65536-entry ceiling; " +
        "it was clamped and the excess entries dropped",
    ]);
    // The declared size only pads the tail; the four real entries still decode.
    expect(doc.palette[1]).toEqual({ r: 255, g: 0, b: 0, a: 255 });
    expect(pixel(compositeFrame(doc, 0), 1, 1)).toEqual([255, 0, 0, 255]);
  });

  it("clamps an absurd palette entry index the same way", async () => {
    const { bytes, view } = patchable("generated/rgba-durations.aseprite");
    const palette = findChunk(bytes, 0, 0x2019);
    view.setUint32(palette.start + 10, 0x00fffff0, true); // first entry index
    view.setUint32(palette.start + 14, 0x00ffffff, true); // last entry index

    const started = Date.now();
    const doc = await parseAseprite(bytes, PARSE_OPTS);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(doc.warnings.some((w) => w.includes("65536-entry ceiling"))).toBe(true);
  });

  it("rejects an out-of-range frame index", async () => {
    const doc = await parse("excalibur/beetle-rgba-multi-layer.aseprite");
    expect(() => compositeFrame(doc, -1)).toThrow(RangeError);
    expect(() => compositeFrame(doc, 3)).toThrow(RangeError);
    expect(() => compositeFrame(doc, 1.5)).toThrow(RangeError);
  });
});

describe("isAsepriteFile", () => {
  it("accepts real .aseprite bytes", () => {
    expect(isAsepriteFile(fixtureBytes("excalibur/beetle-rgba-multi-layer.aseprite"))).toBe(true);
    expect(isAsepriteFile(fixtureBytes("generated/indexed-transparent.aseprite"))).toBe(true);
  });

  it("rejects a PNG and an empty buffer without throwing", () => {
    const png = new Uint8Array(256);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(isAsepriteFile(png)).toBe(false);
    expect(isAsepriteFile(new Uint8Array(0))).toBe(false);
    expect(isAsepriteFile(new Uint8Array(8))).toBe(false);
  });
});

describe("decodeAseprite", () => {
  it("parses and composites in one call", async () => {
    const { doc, frames } = await decodeAseprite(
      fixtureBytes("generated/rgba-durations.aseprite"),
      PARSE_OPTS,
    );
    expect(doc.frameCount).toBe(4);
    expect(frames).toHaveLength(4);
    expect(frames.map((f) => f.durationMs)).toEqual([100, 250, 40, 33]);
    expect(pixel(frames[0], 1, 1)).toEqual([255, 0, 0, 255]);
  });
});
