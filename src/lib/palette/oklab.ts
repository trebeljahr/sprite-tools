// sRGB <-> OKLCH conversions for palette work.
//
// OKLCH is the Oklab perceptual color space in polar form (L = perceptual
// lightness 0..1, C = chroma, h = hue in degrees). We use it instead of HSL
// because HSL's "lightness" is (max+min)/2 of *gamma-encoded* RGB, which is not
// perceptual: rotating hue from yellow to blue at a fixed HSL-L makes the blue
// look far darker, and HSL saturation is not comparable across hues, so scaling
// it muddies the result. Oklab is built so equal numeric steps in L are equal
// perceived steps and hue rotation at constant L/C holds perceived brightness —
// exactly what preserving a hand-authored sprite shading ramp needs.

import type { RGB } from "../pixel-art/pixelate";

export interface OKLCH {
  /** Perceptual lightness, 0..1. */
  l: number;
  /** Chroma, >= 0. Roughly 0..0.4 for sRGB. */
  c: number;
  /** Hue in degrees, [0, 360). Meaningless (reported as 0) when c ~ 0. */
  h: number;
}

/** Below this chroma the hue angle is numerically meaningless, so we report 0. */
const ACHROMATIC_EPSILON = 1e-6;

function srgbToLinear(v: number): number {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(v: number): number {
  return v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
}

function normalizeHue(h: number): number {
  const n = h % 360;
  return n < 0 ? n + 360 : n;
}

export function rgbToOklch(rgb: RGB): OKLCH {
  const r = srgbToLinear(rgb.r);
  const g = srgbToLinear(rgb.g);
  const b = srgbToLinear(rgb.b);

  const lms0 = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const lms1 = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const lms2 = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;

  const l_ = Math.cbrt(lms0);
  const m_ = Math.cbrt(lms1);
  const s_ = Math.cbrt(lms2);

  const L = 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_;
  const a = 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_;
  const bb = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_;

  const c = Math.hypot(a, bb);
  const h = c < ACHROMATIC_EPSILON ? 0 : normalizeHue((Math.atan2(bb, a) * 180) / Math.PI);
  return { l: L, c, h };
}

/** Linear-sRGB triple for an Oklab L/a/b, before any gamut handling. */
function oklabToLinear(L: number, a: number, b: number): [number, number, number] {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;

  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;

  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

/** Small slack so float noise on an in-gamut color doesn't trigger a search. */
const GAMUT_EPSILON = 1e-6;

function inGamut(lin: [number, number, number]): boolean {
  return lin.every((v) => v >= -GAMUT_EPSILON && v <= 1 + GAMUT_EPSILON);
}

export function oklchToRgb(v: OKLCH): RGB {
  const hRad = (normalizeHue(v.h) * Math.PI) / 180;
  const l = v.l;
  let c = Math.max(0, v.c);

  let lin = oklabToLinear(l, c * Math.cos(hRad), c * Math.sin(hRad));

  // Out of gamut: walk chroma down instead of clamping channels. Clamping a
  // channel changes lightness unpredictably, which can reorder (or collapse)
  // the shades of a remapped ramp at the bright/dark ends; giving up
  // saturation keeps L and h — and therefore the ramp's shape — intact.
  if (!inGamut(lin)) {
    let lo = 0;
    let hi = c;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      const test = oklabToLinear(l, mid * Math.cos(hRad), mid * Math.sin(hRad));
      if (inGamut(test)) lo = mid;
      else hi = mid;
    }
    c = lo;
    lin = oklabToLinear(l, c * Math.cos(hRad), c * Math.sin(hRad));
  }

  const to8 = (x: number) => Math.max(0, Math.min(255, Math.round(linearToSrgb(x) * 255)));
  return { r: to8(lin[0]), g: to8(lin[1]), b: to8(lin[2]) };
}

export function rotateHue(rgb: RGB, deg: number): RGB {
  // A full turn (or any multiple, including negative ones) must be a bit-exact
  // identity: variant sets routinely include the 0-degree entry, and pushing it
  // through the conversion would requantize every pixel for no reason.
  if (deg % 360 === 0) return { r: rgb.r, g: rgb.g, b: rgb.b };
  const { l, c, h } = rgbToOklch(rgb);
  return oklchToRgb({ l, c, h: normalizeHue(h + deg) });
}

/** Signed shortest arc from `a` to `b`, in (-180, 180]. */
export function hueDelta(a: number, b: number): number {
  const d = normalizeHue(b - a);
  return d > 180 ? d - 360 : d;
}

/** Absolute shortest arc between two hues, 0..180. */
export function hueDistance(a: number, b: number): number {
  return Math.abs(hueDelta(a, b));
}
