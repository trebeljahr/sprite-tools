// Aseprite's 19 layer blend modes, transcribed from src/doc/blend_funcs.cpp
// (plus the MUL_UN8/DIV_UN8 helpers it borrows from pixman-combine32.h).
//
// The formulas are ported operation-for-operation rather than "written to be
// equivalent" because the whole point is that a composited frame matches what
// the artist saw in the Aseprite editor. Aseprite works in rounded 8-bit
// integer arithmetic with a specific rounding rule per operation; a float
// pipeline that rounds once at the end lands one LSB off on a large fraction
// of pixels, and on flat pixel-art fills a single LSB is a visible band.
//
// Canvas `globalCompositeOperation` is NOT a substitute for any of this. The
// canvas modes are the W3C compositing spec on premultiplied float colour;
// Aseprite's are Adobe-flavoured integer formulas on straight colour with its
// own quirks (overlay swaps its operands, hard-light branches on `s < 128`
// rather than 0.5, saturation uses a simplified SetSat that is not the W3C
// one). Reaching for the browser's blend modes is exactly why nearly every
// other JS .aseprite reader renders multiply and overlay layers wrong.
//
// One deliberate divergence, noted where it happens: the "New Blend Method"
// wrapper is applied unconditionally, matching Aseprite 1.3+'s default.

import type { AseBlendMode } from "./types";

// ---------------------------------------------------------------------------
// pixman integer helpers (third_party/pixman/pixman/pixman-combine32.h)
//
//   #define MUL_UN8(a, b, t) ((t) = (a)*(uint16_t)(b) + ONE_HALF, \
//                             ((((t) >> G_SHIFT) + (t)) >> G_SHIFT))
//   #define DIV_UN8(a, b)    (((uint16_t)(a) * MASK + ((b)/2)) / (b))
// ---------------------------------------------------------------------------

/**
 * Rounded 8-bit multiply, `a * b / 255`. `t` is a signed int in the C macro and
 * rgbaBlenderMerge feeds it negative deltas, so the shifts must be arithmetic —
 * JS `>>` on an int32 reproduces that exactly. Do not "simplify" to `/ 255`.
 */
function mulUn8(a: number, b: number): number {
  const t = a * b + 0x80;
  return ((t >> 8) + t) >> 8;
}

/** Truncating 8-bit divide, `a * 255 / b`. Callers guarantee `b > a >= 1`. */
function divUn8(a: number, b: number): number {
  return ((a * 0xff + ((b / 2) | 0)) / b) | 0;
}

// laf/base/base.h: #define ABS(x) (((x) >= 0) ? (x) : (-(x)))
function abs(x: number): number {
  return x >= 0 ? x : -x;
}

// ---------------------------------------------------------------------------
// doc/color.h — color_t is little-endian ABGR in a uint32 (R at bit 0), which
// is byte-for-byte the RGBA order of a Uint8ClampedArray. Working in packed
// color_t here keeps the `backdrop & rgba_a_mask` style guards below literal.
// ---------------------------------------------------------------------------

const RGB_MASK = 0x00ffffff;
const A_MASK = 0xff000000 | 0;

const getR = (c: number) => c & 0xff;
const getG = (c: number) => (c >>> 8) & 0xff;
const getB = (c: number) => (c >>> 16) & 0xff;
const getA = (c: number) => (c >>> 24) & 0xff;

/** C++ `rgba()` takes uint8_t parameters, hence truncation rather than clamping. */
function rgba(r: number, g: number, b: number, a: number): number {
  return ((r & 0xff) | ((g & 0xff) << 8) | ((b & 0xff) << 16) | ((a & 0xff) << 24)) >>> 0;
}

// ---------------------------------------------------------------------------
// Per-channel functions. Operands are raw 0..255 channel values, never
// alpha-weighted — the alpha compositing happens afterwards, in rgbaBlenderNormal.
// ---------------------------------------------------------------------------

const blendMultiply = (b: number, s: number) => mulUn8(b, s);
const blendScreen = (b: number, s: number) => b + s - mulUn8(b, s);

// The `s < 128` / `s << 1` integer branch is asymmetric around the midpoint
// (s=127 multiplies by 254, s=128 screens by 1); an `s/255 <= 0.5` float
// formulation does not reproduce it.
const blendHardLight = (b: number, s: number) =>
  s < 128 ? blendMultiply(b, s << 1) : blendScreen(b, (s << 1) - 255);

// #define blend_overlay(b, s, t) (blend_hard_light(s, b, t)) — the operands are
// SWAPPED, so the branch tests the backdrop, not the source.
const blendOverlay = (b: number, s: number) => blendHardLight(s, b);

const blendDarken = (b: number, s: number) => Math.min(b, s);
const blendLighten = (b: number, s: number) => Math.max(b, s);
const blendDifference = (b: number, s: number) => abs(b - s);

function blendExclusion(b: number, s: number): number {
  const t = mulUn8(b, s);
  return b + s - 2 * t;
}

// The `b >= s` early returns are what keep every divUn8 call safe.
function blendDivide(b: number, s: number): number {
  if (b === 0) return 0;
  if (b >= s) return 255;
  return divUn8(b, s);
}

function blendColorDodge(b: number, s: number): number {
  if (b === 0) return 0;
  const inv = 255 - s;
  if (b >= inv) return 255;
  return divUn8(b, inv);
}

function blendColorBurn(b: number, s: number): number {
  if (b === 255) return 255;
  const inv = 255 - b;
  if (inv >= s) return 0;
  return 255 - divUn8(inv, s);
}

/**
 * The only per-channel function Aseprite computes in floating point. Its
 * `(uint32_t)(r * 255 + 0.5)` is a truncating cast of an already-offset value,
 * i.e. round-half-up — unlike the HSL modes below, which truncate outright.
 */
function blendSoftLight(rawB: number, rawS: number): number {
  const b = rawB / 255.0;
  const s = rawS / 255.0;
  let r: number;
  let d: number;

  if (b <= 0.25) d = ((16 * b - 12) * b + 4) * b;
  else d = Math.sqrt(b);

  if (s <= 0.5) r = b - (1.0 - 2.0 * s) * b * (1.0 - b);
  else r = b + (2.0 * s - 1.0) * (d - b);

  return Math.trunc(r * 255 + 0.5);
}

// ---------------------------------------------------------------------------
// Alpha compositing. Colours are STRAIGHT (non-premultiplied) throughout.
// ---------------------------------------------------------------------------

/**
 * rgba_blender_normal. The divide-by-result-alpha survives Aseprite's algebra
 * as the single `* Sa / Ra` term, and that divide is a plain C integer divide —
 * truncating, with none of MUL_UN8's `+0x80` rounding. Mis-porting this one
 * detail is the classic source of off-by-one antialiasing edges.
 */
function rgbaBlenderNormal(backdrop: number, src: number, opacity: number): number {
  if (!(backdrop & A_MASK)) {
    // Fully transparent backdrop: source RGB is kept bit-exact and only the
    // alpha is scaled. Running the general path here instead would drift.
    const a = mulUn8(getA(src), opacity);
    return ((src & RGB_MASK) | ((a & 0xff) << 24)) >>> 0;
  }
  if (!(src & A_MASK)) {
    return backdrop >>> 0;
  }

  const br = getR(backdrop);
  const bg = getG(backdrop);
  const bb = getB(backdrop);
  const ba = getA(backdrop);

  const sr = getR(src);
  const sg = getG(src);
  const sb = getB(src);
  const sa = mulUn8(getA(src), opacity);

  // Ra = Sa + Ba*(1-Sa). Ra can never be 0 on this path: the guards above put
  // Ba > 0, and Ra >= Ba.
  const ra = sa + ba - mulUn8(ba, sa);

  // Rc = Bc + (Sc-Bc)*Sa/Ra, truncating toward zero exactly like C.
  const rr = br + ((((sr - br) * sa) / ra) | 0);
  const rg = bg + ((((sg - bg) * sa) / ra) | 0);
  const rb = bb + ((((sb - bb) * sa) / ra) | 0);

  return rgba(rr, rg, rb, ra);
}

/**
 * rgba_blender_merge — a straight lerp on all four channels. Not reachable as a
 * layer blend mode, but the New Blend Method wrapper is built out of it, and it
 * is the one place mulUn8 is handed negative first arguments.
 */
function rgbaBlenderMerge(backdrop: number, src: number, opacity: number): number {
  const br = getR(backdrop);
  const bg = getG(backdrop);
  const bb = getB(backdrop);
  const ba = getA(backdrop);

  const sr = getR(src);
  const sg = getG(src);
  const sb = getB(src);
  const sa = getA(src);

  let rr: number;
  let rg: number;
  let rb: number;

  if (ba === 0) {
    rr = sr;
    rg = sg;
    rb = sb;
  } else if (sa === 0) {
    rr = br;
    rg = bg;
    rb = bb;
  } else {
    rr = br + mulUn8(sr - br, opacity);
    rg = bg + mulUn8(sg - bg, opacity);
    rb = bb + mulUn8(sb - bb, opacity);
  }

  const ra = ba + mulUn8(sa - ba, opacity);
  if (ra === 0) {
    rr = 0;
    rg = 0;
    rb = 0;
  }

  return rgba(rr, rg, rb, ra);
}

/**
 * Every separable blender in blend_funcs.cpp has this exact shape: blend the
 * three colour channels on raw values, keep the source alpha untouched, then
 * hand the synthetic pixel to plain source-over. There is no extra
 * "scale the blend by backdrop alpha" term at this level.
 */
function separable(
  f: (b: number, s: number) => number,
  backdrop: number,
  src: number,
  opacity: number,
): number {
  const r = f(getR(backdrop), getR(src));
  const g = f(getG(backdrop), getG(src));
  const b = f(getB(backdrop), getB(src));
  const blended = (rgba(r, g, b, 0) | (src & A_MASK)) >>> 0;
  return rgbaBlenderNormal(backdrop, blended, opacity);
}

function rgbaBlenderAddition(backdrop: number, src: number, opacity: number): number {
  const r = getR(backdrop) + getR(src);
  const g = getG(backdrop) + getG(src);
  const b = getB(backdrop) + getB(src);
  const blended =
    (rgba(Math.min(r, 255), Math.min(g, 255), Math.min(b, 255), 0) | (src & A_MASK)) >>> 0;
  return rgbaBlenderNormal(backdrop, blended, opacity);
}

function rgbaBlenderSubtract(backdrop: number, src: number, opacity: number): number {
  const r = getR(backdrop) - getR(src);
  const g = getG(backdrop) - getG(src);
  const b = getB(backdrop) - getB(src);
  const blended = (rgba(Math.max(r, 0), Math.max(g, 0), Math.max(b, 0), 0) | (src & A_MASK)) >>> 0;
  return rgbaBlenderNormal(backdrop, blended, opacity);
}

// ---------------------------------------------------------------------------
// Non-separable (HSL) modes. These act on the RGB triple as a unit, in
// normalised doubles, which is what the C++ does — forcing them into integer
// math would change results.
// ---------------------------------------------------------------------------

// Reused across calls: blendInto runs once per pixel per layer, so allocating a
// triple here would be the dominant cost of compositing an HSL-mode layer.
const triple = [0, 0, 0];

function lum(r: number, g: number, b: number): number {
  return 0.3 * r + 0.59 * g + 0.11 * b;
}

function sat(r: number, g: number, b: number): number {
  return Math.max(r, Math.max(g, b)) - Math.min(r, Math.min(g, b));
}

/**
 * clip_color, divides included. Aseprite guards neither `l - n` nor `x - l`, so
 * degenerate triples can yield NaN in the C++ doubles too; reproducing that
 * literally is the faithful choice, and the final `& 0xff` turns any NaN into 0
 * the same way the C++ cast does in practice.
 */
function clipColor(c: number[]): void {
  const l = lum(c[0], c[1], c[2]);
  const n = Math.min(c[0], Math.min(c[1], c[2]));
  const x = Math.max(c[0], Math.max(c[1], c[2]));

  if (n < 0) {
    c[0] = l + ((c[0] - l) * l) / (l - n);
    c[1] = l + ((c[1] - l) * l) / (l - n);
    c[2] = l + ((c[2] - l) * l) / (l - n);
  }

  if (x > 1) {
    c[0] = l + ((c[0] - l) * (1 - l)) / (x - l);
    c[1] = l + ((c[1] - l) * (1 - l)) / (x - l);
    c[2] = l + ((c[2] - l) * (1 - l)) / (x - l);
  }
}

function setLum(c: number[], l: number): void {
  const d = l - lum(c[0], c[1], c[2]);
  c[0] += d;
  c[1] += d;
  c[2] += d;
  clipColor(c);
}

/**
 * Aseprite's own simplified SetSat: it rescales all three channels rather than
 * sorting them into min/mid/max and zeroing the minimum the way the W3C
 * compositing spec does. The two disagree on real inputs — this is the one
 * Aseprite ships.
 */
function setSat(c: number[], s: number): void {
  const minv = Math.min(Math.min(c[0], c[1]), c[2]);
  const maxv = Math.max(Math.max(c[0], c[1]), c[2]);
  const range = maxv - minv;

  if (range > 0.0) {
    c[0] = ((c[0] - minv) * s) / range;
    c[1] = ((c[1] - minv) * s) / range;
    c[2] = ((c[2] - minv) * s) / range;
  } else {
    c[0] = 0.0;
    c[1] = 0.0;
    c[2] = 0.0;
  }
}

function loadTriple(c: number): void {
  triple[0] = getR(c) / 255.0;
  triple[1] = getG(c) / 255.0;
  triple[2] = getB(c) / 255.0;
}

/** `int(255.0 * r)` in the C++ — a truncating cast, unlike soft light's `+0.5`. */
function packTriple(src: number): number {
  return (
    (rgba(
      Math.trunc(255.0 * triple[0]),
      Math.trunc(255.0 * triple[1]),
      Math.trunc(255.0 * triple[2]),
      0,
    ) |
      (src & A_MASK)) >>>
    0
  );
}

function rgbaBlenderHslHue(backdrop: number, src: number, opacity: number): number {
  loadTriple(backdrop);
  const s = sat(triple[0], triple[1], triple[2]);
  const l = lum(triple[0], triple[1], triple[2]);

  loadTriple(src);
  setSat(triple, s);
  setLum(triple, l);

  return rgbaBlenderNormal(backdrop, packTriple(src), opacity);
}

function rgbaBlenderHslSaturation(backdrop: number, src: number, opacity: number): number {
  loadTriple(src);
  const s = sat(triple[0], triple[1], triple[2]);

  loadTriple(backdrop);
  const l = lum(triple[0], triple[1], triple[2]);
  setSat(triple, s);
  setLum(triple, l);

  return rgbaBlenderNormal(backdrop, packTriple(src), opacity);
}

function rgbaBlenderHslColor(backdrop: number, src: number, opacity: number): number {
  loadTriple(backdrop);
  const l = lum(triple[0], triple[1], triple[2]);

  loadTriple(src);
  setLum(triple, l);

  return rgbaBlenderNormal(backdrop, packTriple(src), opacity);
}

function rgbaBlenderHslLuminosity(backdrop: number, src: number, opacity: number): number {
  loadTriple(src);
  const l = lum(triple[0], triple[1], triple[2]);

  loadTriple(backdrop);
  setLum(triple, l);

  return rgbaBlenderNormal(backdrop, packTriple(src), opacity);
}

// ---------------------------------------------------------------------------
// Mode dispatch
// ---------------------------------------------------------------------------

/** Layer Chunk (0x2004) blend WORD order — doc::BlendMode matches it one-for-one. */
const MODE_BY_ID: readonly AseBlendMode[] = [
  "normal",
  "multiply",
  "screen",
  "overlay",
  "darken",
  "lighten",
  "color-dodge",
  "color-burn",
  "hard-light",
  "soft-light",
  "difference",
  "exclusion",
  "hue",
  "saturation",
  "color",
  "luminosity",
  "addition",
  "subtract",
  "divide",
];

export function blendModeFromId(id: number): AseBlendMode | null {
  return MODE_BY_ID[id] ?? null;
}

function baseBlend(backdrop: number, src: number, mode: AseBlendMode, opacity: number): number {
  switch (mode) {
    case "normal":
      return rgbaBlenderNormal(backdrop, src, opacity);
    case "multiply":
      return separable(blendMultiply, backdrop, src, opacity);
    case "screen":
      return separable(blendScreen, backdrop, src, opacity);
    case "overlay":
      return separable(blendOverlay, backdrop, src, opacity);
    case "darken":
      return separable(blendDarken, backdrop, src, opacity);
    case "lighten":
      return separable(blendLighten, backdrop, src, opacity);
    case "color-dodge":
      return separable(blendColorDodge, backdrop, src, opacity);
    case "color-burn":
      return separable(blendColorBurn, backdrop, src, opacity);
    case "hard-light":
      return separable(blendHardLight, backdrop, src, opacity);
    case "soft-light":
      return separable(blendSoftLight, backdrop, src, opacity);
    case "difference":
      return separable(blendDifference, backdrop, src, opacity);
    case "exclusion":
      return separable(blendExclusion, backdrop, src, opacity);
    case "hue":
      return rgbaBlenderHslHue(backdrop, src, opacity);
    case "saturation":
      return rgbaBlenderHslSaturation(backdrop, src, opacity);
    case "color":
      return rgbaBlenderHslColor(backdrop, src, opacity);
    case "luminosity":
      return rgbaBlenderHslLuminosity(backdrop, src, opacity);
    case "addition":
      return rgbaBlenderAddition(backdrop, src, opacity);
    case "subtract":
      return rgbaBlenderSubtract(backdrop, src, opacity);
    case "divide":
      return separable(blendDivide, backdrop, src, opacity);
  }
}

/**
 * RGBA_BLENDER_N — Aseprite's "New Blend Method", the default since 1.3
 * (`Render::m_newBlendMethod` is initialised to true) and applied to every mode
 * except Normal, which has no `_n` variant. It fades the blend result back
 * towards plain source-over as either alpha drops, which is why a layer set to
 * Multiply at 40% opacity looks different from Aseprite's old behaviour.
 *
 * The .ase format carries no flag for it, so this is unconditional: matching
 * the current editor default is the only choice that makes an export look like
 * the canvas the file was saved from. It collapses to the plain blend whenever
 * backdrop alpha and effective source alpha are both 255, so the common
 * fully-opaque case is untouched.
 */
function blendPixel(backdrop: number, src: number, mode: AseBlendMode, opacity: number): number {
  if (mode === "normal") return rgbaBlenderNormal(backdrop, src, opacity);
  if (!(backdrop & A_MASK)) return rgbaBlenderNormal(backdrop, src, opacity);

  const normal = rgbaBlenderNormal(backdrop, src, opacity);
  const blend = baseBlend(backdrop, src, mode, opacity);
  const ba = getA(backdrop);
  const normalToBlendMerge = rgbaBlenderMerge(normal, blend, ba);
  const srcTotalAlpha = mulUn8(getA(src), opacity);
  const compositeAlpha = mulUn8(ba, srcTotalAlpha);
  return rgbaBlenderMerge(normalToBlendMerge, blend, compositeAlpha);
}

/**
 * Composite one straight-RGBA source pixel over the backdrop at `dst[di..di+3]`,
 * in place.
 *
 * `opacity` is the combined cel x layer opacity in 0..255, already multiplied by
 * the caller with mulUn8 at each step (render.cpp does the same, and the
 * intermediate rounding is observable — do not collapse it into one divide).
 */
export function blendInto(
  dst: Uint8ClampedArray,
  di: number,
  sr: number,
  sg: number,
  sb: number,
  sa: number,
  mode: AseBlendMode,
  opacity: number,
): void {
  // Aseprite skips source pixels equal to the mask colour before the blender
  // runs. For RGBA that colour is 0x00000000; extending the skip to any
  // zero-alpha source is safe because a transparent source can only ever write
  // RGB under a zero result alpha, which no later blend can read back.
  if (sa === 0) return;

  const backdrop = rgba(dst[di], dst[di + 1], dst[di + 2], dst[di + 3]);
  const src = rgba(sr, sg, sb, sa);
  const out = blendPixel(backdrop, src, mode, opacity);

  dst[di] = out & 0xff;
  dst[di + 1] = (out >>> 8) & 0xff;
  dst[di + 2] = (out >>> 16) & 0xff;
  dst[di + 3] = (out >>> 24) & 0xff;
}
