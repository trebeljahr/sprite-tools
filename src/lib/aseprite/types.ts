// Aseprite (.ase / .aseprite) document model.
//
// Structural types only — no DOM, no Node builtins, so the browser bundle and
// the CLI/MCP CommonJS builds can share one parser. Same split as
// pipeline/detect.ts and pipeline/chroma-core.ts.
//
// Decoded per the official format spec (aseprite/aseprite docs/ase-file-specs.md).
// Pixel buffers here are always straight (non-premultiplied) RGBA8, regardless
// of the file's own colour depth — callers never see indexed or grayscale bytes.

export type AseColorDepth = 32 | 16 | 8;

/** Layer Chunk (0x2004) blend mode, ids 0..18. */
export type AseBlendMode =
  | "normal"
  | "multiply"
  | "screen"
  | "overlay"
  | "darken"
  | "lighten"
  | "color-dodge"
  | "color-burn"
  | "hard-light"
  | "soft-light"
  | "difference"
  | "exclusion"
  | "hue"
  | "saturation"
  | "color"
  | "luminosity"
  | "addition"
  | "subtract"
  | "divide";

/**
 * Tags Chunk (0x2018) loop direction. Note `pingpong-reverse` (id 3) exists in
 * the spec and is missed by most third-party readers.
 */
export type AseTagDirection = "forward" | "reverse" | "pingpong" | "pingpong-reverse";

export type AseLayerType = "image" | "group" | "tilemap";

export interface AseColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface AseLayer {
  /** Layer index per spec NOTE.2 — position in file order, groups included. */
  index: number;
  name: string;
  type: AseLayerType;
  /** Nesting depth per spec NOTE.1. 0 is top level. */
  childLevel: number;
  /** Index of the enclosing group layer, or null at top level. */
  parentIndex: number | null;
  /** This layer's own visible flag (Layer Chunk flags bit 1). */
  visible: boolean;
  /** visible AND every ancestor group visible — what compositing must honour. */
  effectivelyVisible: boolean;
  /** Layer Chunk flags bit 8. Background layers ignore the transparent index. */
  background: boolean;
  /**
   * Layer Chunk flags bit 64. A reference layer holds an imported sketch or
   * photo the artist draws over; Aseprite shows it only in the editor and never
   * renders it into a saved or exported image, so compositing always skips it.
   * It is independent of `visible` — a reference layer is not "hidden", it is
   * just never part of the output — and its cels stay in `AseDocument.cels`.
   */
  reference: boolean;
  blendMode: AseBlendMode;
  /**
   * 0..255. Per spec NOTE.6 the layer opacity field is only meaningful when
   * header flag 1 is set (and, for groups, flag 2); the parser normalises the
   * unusable case to 255 rather than making callers re-check the header.
   */
  opacity: number;
}

export interface AseCel {
  frameIndex: number;
  layerIndex: number;
  /**
   * Cel origin on the canvas. SIGNED — cels legitimately sit partly or wholly
   * outside the canvas and must be clipped when composited.
   */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Per-cel opacity 0..255, multiplied with the layer's own opacity. */
  opacity: number;
  /** Render-order nudge per spec NOTE.5. May be negative. */
  zIndex: number;
  /**
   * Straight RGBA8, width * height * 4, resolved from the file's colour depth.
   * For indexed files the palette used is the one in effect at `frameIndex`.
   */
  pixels: Uint8ClampedArray;
}

export interface AseTag {
  name: string;
  /** Inclusive frame indices. */
  from: number;
  to: number;
  direction: AseTagDirection;
  /** 0 means "unspecified" (loop forever in the UI, play once on export). */
  repeat: number;
  /** "#rrggbb" when the file carries a tag colour, else undefined. */
  color?: string;
}

export interface AseFrameInfo {
  /** Per-frame duration in ms, already resolved against the deprecated header speed field. */
  durationMs: number;
}

/** One fully composited frame: canvas-sized, straight RGBA8. */
export interface AseCompositedFrame {
  width: number;
  height: number;
  durationMs: number;
  pixels: Uint8ClampedArray;
}

export interface AseDocument {
  /** Canvas size. Individual cels may be smaller, larger, or offset. */
  width: number;
  height: number;
  frameCount: number;
  colorDepth: AseColorDepth;
  /**
   * Header byte 28: the palette index that reads as transparent on
   * non-background layers. Only meaningful for indexed (8bpp) files.
   */
  transparentIndex: number;
  /**
   * The palette in effect at frame 0 — the sprite palette as Aseprite shows it
   * when the file opens. Palette chunks may appear in later frames too (palette
   * cycling); those changes are already baked into each indexed cel's decoded
   * `pixels`, resolved against the palette at that cel's own frame, so this one
   * array is not the palette of every frame.
   */
  palette: AseColor[];
  layers: AseLayer[];
  tags: AseTag[];
  frames: AseFrameInfo[];
  /** Every cel in the file, already resolved (linked cels point at real pixels). */
  cels: AseCel[];
  pixelRatio: { width: number; height: number };
  /**
   * Non-fatal decoding notes: skipped chunk types, unsupported features,
   * clamped values. Surfaced to users so a partial decode is never silent.
   */
  warnings: string[];
}

/**
 * zlib (RFC1950) inflate, injected so the core stays free of both `node:zlib`
 * and `DecompressionStream`. Node passes the sync zlib version, the browser
 * passes the async DecompressionStream version — hence the union return.
 */
export type Inflate = (data: Uint8Array) => Uint8Array | Promise<Uint8Array>;

export interface ParseOptions {
  inflate: Inflate;
}

/** Look up a cel by (frame, layer). Returns undefined when the cel is absent. */
export function findCel(
  doc: AseDocument,
  frameIndex: number,
  layerIndex: number,
): AseCel | undefined {
  return doc.cels.find((c) => c.frameIndex === frameIndex && c.layerIndex === layerIndex);
}
