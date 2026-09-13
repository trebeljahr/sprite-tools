// Pixel-art upscaling filters: nearest-neighbour, Scale2x, Scale3x, Eagle and xBR.
//
// Pure and DOM-free — no canvas, no document. Input is the structural
// `{width, height, data}` shape (same convention as pipeline/detect.ts and
// pipeline/chroma-core.ts) so the browser, the CLI and the MCP server can all
// feed it; output is a real `ImageData` (Node gets one from cli/lib/imagedata-shim).
//
// Every filter here is *palette-safe*: it only ever copies an existing source
// pixel into the output. No colour is invented, no channel is blended, so a
// 16-colour sprite comes out with exactly the same 16 colours.
//
// Licensing position (this is an MIT package, so provenance matters):
//   - Scale2x / Scale3x (AdvMAME2x / AdvMAME3x) are implemented from the
//     published rule table at https://www.scale2x.it/algorithm. The algorithm
//     itself is prior art — EPX, Eric Johnston, LucasArts 1992 — and is not
//     patented. The GPL reference implementation was NOT consulted or copied;
//     only the plain-English rule table was.
//   - Eagle is implemented from its published rule set (the four corner rules
//     as documented under "Pixel-art scaling algorithms").
//   - xBR-lv1-noblend is a port of Hyllian's shader, which is MIT-licensed; the
//     upstream notice is reproduced verbatim in the xBR section below.
//   - HQx (hq2x / hq3x) is deliberately absent. It is LGPL-2.1, and its 4096-entry
//     interpolation table is inseparable from that source — there is no way to
//     ship it in an MIT package without taking the LGPL with it.

/** Structural ImageData, so Node (pngjs) and the browser can both call in. */
export interface ImageDataLike {
  width: number;
  height: number;
  data: Uint8ClampedArray | Uint8Array;
}

export type UpscaleAlgorithm = "nearest" | "scale2x" | "scale3x" | "eagle" | "xbr";

export interface UpscaleOptions {
  algorithm: UpscaleAlgorithm;
  /** Integer factor >= 1. */
  scale: number;
}

export const DEFAULT_UPSCALE_OPTIONS: UpscaleOptions = { algorithm: "scale2x", scale: 2 };

export interface UpscaleAlgorithmInfo {
  id: UpscaleAlgorithm;
  label: string;
  /** The factor one pass of the filter multiplies by. 1 for plain nearest. */
  nativeFactor: number;
  /** One sentence, used verbatim in CLI help, the MCP schema and the web UI. */
  description: string;
}

export const UPSCALE_ALGORITHMS: UpscaleAlgorithmInfo[] = [
  {
    id: "nearest",
    label: "Nearest",
    nativeFactor: 1,
    description: "Plain block scaling that keeps every hard pixel edge exactly as it is.",
  },
  {
    id: "scale2x",
    label: "Scale2x",
    nativeFactor: 2,
    description: "Smooths diagonal staircases at 2x without inventing any new colours.",
  },
  {
    id: "scale3x",
    label: "Scale3x",
    nativeFactor: 3,
    description: "The 3x sibling of Scale2x, with the same palette-safe edge smoothing.",
  },
  {
    id: "eagle",
    label: "Eagle",
    nativeFactor: 2,
    description: "Rounds corners more aggressively at 2x, at the cost of losing lone pixels.",
  },
  {
    id: "xbr",
    label: "xBR",
    nativeFactor: 2,
    description: "Hyllian's xBR level 1 with stronger edge detection at 2x, still palette-safe.",
  },
];

/** Looks up algorithm metadata by id, falling back to "nearest" for anything unknown. */
export function upscaleAlgorithmById(id: string): UpscaleAlgorithmInfo {
  return UPSCALE_ALGORITHMS.find((a) => a.id === id) ?? UPSCALE_ALGORITHMS[0];
}

/**
 * Applies the algorithm's native factor as many times as it divides `scale` evenly,
 * then covers any remainder with nearest-neighbour. So scale2x @4 = two scale2x passes;
 * scale2x @6 = one scale2x pass then nearest x3; scale3x @9 = two scale3x passes.
 * scale <= 1 returns a copy. Non-integer / negative scale is floored and clamped to >= 1.
 */
export function upscale(src: ImageDataLike, opts: Partial<UpscaleOptions> = {}): ImageData {
  const options = { ...DEFAULT_UPSCALE_OPTIONS, ...opts };
  const raw = Math.floor(options.scale);
  const scale = Number.isFinite(raw) && raw > 1 ? raw : 1;
  if (scale === 1) return cloneImageData(src);

  const info = upscaleAlgorithmById(options.algorithm);
  const step = STEP_BY_ID[info.id];

  let current: ImageDataLike = src;
  let remaining = scale;
  // Peel off native passes while they divide evenly; the leftover is nearest.
  if (info.nativeFactor > 1 && step) {
    while (remaining % info.nativeFactor === 0) {
      current = step(current);
      remaining /= info.nativeFactor;
    }
  }
  if (remaining > 1) current = upscaleNearestBy(current, remaining);

  // Only reachable if nothing ran at all, which the `scale === 1` guard rules out.
  return current === src ? cloneImageData(src) : (current as ImageData);
}

/** The factors this algorithm reaches with no nearest-neighbour remainder, ascending. */
export function nativeScalesFor(algorithm: UpscaleAlgorithm): number[] {
  const info = upscaleAlgorithmById(algorithm);
  // Nearest has no "native" step, so every integer factor is exact for it.
  if (info.nativeFactor <= 1) return [1, 2, 3, 4, 5, 6, 7, 8];
  const limit = info.nativeFactor === 3 ? 9 : 8;
  const out: number[] = [];
  for (let f = 1; f <= limit; f *= info.nativeFactor) out.push(f);
  return out;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function cloneImageData(src: ImageDataLike): ImageData {
  const out = new ImageData(src.width, src.height);
  out.data.set(src.data);
  return out;
}

/**
 * Normalises the structural input's byte array to a single concrete type.
 *
 * `Uint8ClampedArray | Uint8Array` is convenient at the API boundary and poison
 * in a hot loop: every element access against the union goes polymorphic. A
 * Uint8Array (what pngjs hands the CLI) is re-viewed over the same buffer, so
 * this is a view, never a copy, and the loops below stay monomorphic.
 */
function asClamped(d: Uint8ClampedArray | Uint8Array): Uint8ClampedArray {
  return d instanceof Uint8ClampedArray
    ? d
    : new Uint8ClampedArray(d.buffer, d.byteOffset, d.length);
}

/**
 * Canonical comparison key per pixel, for the exact-equality filters.
 *
 * Raw RGBA is the wrong thing to compare: PNG encoders leave arbitrary garbage
 * in the colour channels underneath fully-transparent pixels, so two "empty"
 * pixels routinely differ bit-for-bit. Every alpha===0 pixel therefore collapses
 * to a single key of 0, which no visible pixel can produce: the only RGBA that
 * packs to 0 is (0,0,0,0), and that is already transparent. Injective otherwise.
 *
 * Int32Array rather than Float64Array purely for cache behaviour — the inner
 * loops jump around this table once per neighbour, and halving it halves the misses.
 */
function pixelKeys(src: ImageDataLike): Int32Array {
  const n = src.width * src.height;
  const d = asClamped(src.data);
  const keys = new Int32Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const a = d[j + 3];
    keys[i] = a === 0 ? 0 : (d[j] << 24) | (d[j + 1] << 16) | (d[j + 2] << 8) | a;
  }
  return keys;
}

/**
 * Border handling for every filter here is clamp/replicate, and it is done with
 * lookup tables so the inner loops stay branch-free.
 *
 * Both tables are padded by 2 on each side (xBR reaches two pixels out), so the
 * entry for coordinate `c` lives at index `c + 2` — hence the `ci` closures below
 * offsetting by 2. `rowTable` folds in the `* width` so an index is one add.
 */
function colTable(width: number): Int32Array {
  const t = new Int32Array(width + 4);
  for (let i = 0; i < t.length; i++) t[i] = Math.min(width - 1, Math.max(0, i - 2));
  return t;
}

function rowTable(height: number, width: number): Int32Array {
  const t = new Int32Array(height + 4);
  for (let i = 0; i < t.length; i++) t[i] = Math.min(height - 1, Math.max(0, i - 2)) * width;
  return t;
}

/** Copies all four channels together — never per-channel — so no colour is invented. */
function copyPixel(sd: Uint8ClampedArray, si: number, od: Uint8ClampedArray, oi: number): void {
  od[oi] = sd[si];
  od[oi + 1] = sd[si + 1];
  od[oi + 2] = sd[si + 2];
  od[oi + 3] = sd[si + 3];
}

// ---------------------------------------------------------------------------
// Nearest neighbour
// ---------------------------------------------------------------------------

/** Nearest-neighbour block scale by an integer factor. Borders are irrelevant here. */
export function upscaleNearestBy(src: ImageDataLike, factor: number): ImageData {
  const f = Math.max(1, Math.floor(factor));
  if (f === 1) return cloneImageData(src);
  const W = src.width;
  const H = src.height;
  const out = new ImageData(W * f, H * f);
  const OW = out.width;
  const sd = asClamped(src.data);
  const od = out.data;

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const si = (y * W + x) * 4;
      const r = sd[si];
      const g = sd[si + 1];
      const b = sd[si + 2];
      const a = sd[si + 3];
      for (let dy = 0; dy < f; dy++) {
        let oi = ((y * f + dy) * OW + x * f) * 4;
        for (let dx = 0; dx < f; dx++, oi += 4) {
          od[oi] = r;
          od[oi + 1] = g;
          od[oi + 2] = b;
          od[oi + 3] = a;
        }
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Scale2x (AdvMAME2x / EPX)
// ---------------------------------------------------------------------------

/**
 * Scale2x, from the published rule table at https://www.scale2x.it/algorithm.
 *
 *     A B C        E0 E1
 *     D E F   ->   E2 E3
 *     G H I
 *
 * If B != H and D != F, each of the four output pixels takes the neighbour
 * shared by its two adjacent sides; otherwise all four are just E. Because
 * every output is a straight copy of E, B, D, F or H, no new colour appears.
 *
 * Borders replicate (the neighbourhood is clamped to the image), which is what
 * keeps a sprite's outermost row from being treated as an edge against nothing.
 */
export function scale2x(src: ImageDataLike): ImageData {
  const W = src.width;
  const H = src.height;
  const sd = asClamped(src.data);
  const out = new ImageData(W * 2, H * 2);
  const OW = out.width;
  const od = out.data;
  const k = pixelKeys(src);
  const cols = colTable(W);
  const rows = rowTable(H, W);
  const ci = (px: number, py: number) => rows[py + 2] + cols[px + 2];

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const pE = y * W + x;
      const pB = ci(x, y - 1);
      const pD = ci(x - 1, y);
      const pF = ci(x + 1, y);
      const pH = ci(x, y + 1);

      let s0 = pE;
      let s1 = pE;
      let s2 = pE;
      let s3 = pE;
      if (k[pB] !== k[pH] && k[pD] !== k[pF]) {
        s0 = k[pD] === k[pB] ? pD : pE;
        s1 = k[pB] === k[pF] ? pF : pE;
        s2 = k[pD] === k[pH] ? pD : pE;
        s3 = k[pH] === k[pF] ? pF : pE;
      }

      const row0 = (y * 2 * OW + x * 2) * 4;
      const row1 = ((y * 2 + 1) * OW + x * 2) * 4;
      copyPixel(sd, s0 * 4, od, row0);
      copyPixel(sd, s1 * 4, od, row0 + 4);
      copyPixel(sd, s2 * 4, od, row1);
      copyPixel(sd, s3 * 4, od, row1 + 4);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Scale3x (AdvMAME3x)
// ---------------------------------------------------------------------------

/**
 * Scale3x, from the published rule table at https://www.scale2x.it/algorithm.
 *
 *     A B C        E0 E1 E2
 *     D E F   ->   E3 E4 E5
 *     G H I        E6 E7 E8
 *
 * Same guard as Scale2x (B != H && D != F); the corners follow the Scale2x rules
 * and the edge pixels additionally consult the diagonals to avoid rounding off
 * corners that are genuinely part of a line. E4 is always E.
 *
 * Same alpha-aware equality keys and same clamped borders as Scale2x.
 */
export function scale3x(src: ImageDataLike): ImageData {
  const W = src.width;
  const H = src.height;
  const sd = asClamped(src.data);
  const out = new ImageData(W * 3, H * 3);
  const OW = out.width;
  const od = out.data;
  const k = pixelKeys(src);
  const cols = colTable(W);
  const rows = rowTable(H, W);
  const ci = (px: number, py: number) => rows[py + 2] + cols[px + 2];

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const pE = y * W + x;
      const pA = ci(x - 1, y - 1);
      const pB = ci(x, y - 1);
      const pC = ci(x + 1, y - 1);
      const pD = ci(x - 1, y);
      const pF = ci(x + 1, y);
      const pG = ci(x - 1, y + 1);
      const pH = ci(x, y + 1);
      const pI = ci(x + 1, y + 1);

      const s = SCALE3X_SCRATCH;
      s[0] = pE;
      s[1] = pE;
      s[2] = pE;
      s[3] = pE;
      s[4] = pE;
      s[5] = pE;
      s[6] = pE;
      s[7] = pE;
      s[8] = pE;

      if (k[pB] !== k[pH] && k[pD] !== k[pF]) {
        const A = k[pA];
        const B = k[pB];
        const C = k[pC];
        const D = k[pD];
        const E = k[pE];
        const F = k[pF];
        const G = k[pG];
        const Hk = k[pH];
        const I = k[pI];

        s[0] = D === B ? pD : pE;
        s[1] = (D === B && E !== C) || (B === F && E !== A) ? pB : pE;
        s[2] = B === F ? pF : pE;
        s[3] = (D === B && E !== G) || (D === Hk && E !== A) ? pD : pE;
        s[4] = pE;
        s[5] = (B === F && E !== I) || (Hk === F && E !== C) ? pF : pE;
        s[6] = D === Hk ? pD : pE;
        s[7] = (D === Hk && E !== I) || (Hk === F && E !== G) ? pH : pE;
        s[8] = Hk === F ? pF : pE;
      }

      for (let dy = 0; dy < 3; dy++) {
        let oi = ((y * 3 + dy) * OW + x * 3) * 4;
        for (let dx = 0; dx < 3; dx++, oi += 4) {
          copyPixel(sd, s[dy * 3 + dx] * 4, od, oi);
        }
      }
    }
  }
  return out;
}

// Reused across every pixel so the hot loop allocates nothing.
const SCALE3X_SCRATCH = new Int32Array(9);

// ---------------------------------------------------------------------------
// Eagle
// ---------------------------------------------------------------------------

/**
 * Eagle, from its published rule set.
 *
 *     S T U        1 2
 *     V C W   ->   3 4
 *     X Y Z
 *
 * All four outputs start as the centre C; a corner is replaced only when the
 * whole L of three pixels around it agrees (V==S==T for the top-left, and so on).
 *
 * Documented flaw, left in on purpose: an isolated single pixel surrounded by one
 * uniform colour has all four L-tests pass, so the pixel vanishes entirely. That
 * is what Eagle does — "fixing" it would make this something other than Eagle.
 *
 * Alpha and borders are handled exactly as in Scale2x: canonical keys (so all
 * fully-transparent pixels compare equal) and clamped edges.
 */
export function eagle2x(src: ImageDataLike): ImageData {
  const W = src.width;
  const H = src.height;
  const sd = asClamped(src.data);
  const out = new ImageData(W * 2, H * 2);
  const OW = out.width;
  const od = out.data;
  const k = pixelKeys(src);
  const cols = colTable(W);
  const rows = rowTable(H, W);
  const ci = (px: number, py: number) => rows[py + 2] + cols[px + 2];

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const pC = y * W + x;
      const pS = ci(x - 1, y - 1);
      const pT = ci(x, y - 1);
      const pU = ci(x + 1, y - 1);
      const pV = ci(x - 1, y);
      const pW = ci(x + 1, y);
      const pX = ci(x - 1, y + 1);
      const pY = ci(x, y + 1);
      const pZ = ci(x + 1, y + 1);

      let s0 = pC;
      let s1 = pC;
      let s2 = pC;
      let s3 = pC;
      if (k[pV] === k[pS] && k[pS] === k[pT]) s0 = pS;
      if (k[pT] === k[pU] && k[pU] === k[pW]) s1 = pU;
      if (k[pV] === k[pX] && k[pX] === k[pY]) s2 = pX;
      if (k[pW] === k[pZ] && k[pZ] === k[pY]) s3 = pZ;

      const row0 = (y * 2 * OW + x * 2) * 4;
      const row1 = ((y * 2 + 1) * OW + x * 2) * 4;
      copyPixel(sd, s0 * 4, od, row0);
      copyPixel(sd, s1 * 4, od, row0 + 4);
      copyPixel(sd, s2 * 4, od, row1);
      copyPixel(sd, s3 * 4, od, row1 + 4);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// xBR level 1, "noblend"
// ---------------------------------------------------------------------------

/*
   Hyllian's xBR-lv1-noblend Shader
   Copyright (C) 2011-2014 Hyllian - sergiogdb@gmail.com

   Permission is hereby granted, free of charge, to any person obtaining a copy
   of this software and associated documentation files (the "Software"), to deal
   in the Software without restriction, including without limitation the rights
   to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
   copies of the Software, and to permit persons to whom the Software is
   furnished to do so, subject to the following conditions:

   The above copyright notice and this permission notice shall be included in
   all copies or substantial portions of the Software.

   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
   IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
   FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
   AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
   LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
   OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
   THE SOFTWARE.
*/

const XBR_Y_WEIGHT = 48.0;
const XBR_EQ_THRESHOLD = 15.0;

/**
 * xBR level 1, noblend variant, ported from libretro/common-shaders
 * `xbr/shaders/xbr-lv1-noblend.cg` (notice above). The shader's neighbourhood:
 *
 *        | B| C|
 *     | D| E| F|F4|
 *     | G| H| I|I4|
 *        |H5|I5|
 *
 * Two things had to be decided to turn a freescale fragment shader into an exact
 * integer 2x; both are documented at their use site below:
 *
 *  1. Quadrant mirroring. The shader multiplies every sample offset by
 *     `dir = sign(pos)`, the sign of the fragment's position inside the source
 *     texel, so F/H/I always point into the quadrant being shaded. At exactly 2x
 *     each source pixel becomes a 2x2 block and each sub-pixel *is* one quadrant,
 *     so we mirror the neighbourhood per sub-pixel with qx/qy = -1 or +1.
 *
 *  2. The `fx` term — see the comment on `nc` below.
 *
 * Like the other filters here, "noblend" means the result is always a straight
 * copy of E, F or H: palette-safe, no interpolation.
 */
export function xbr2x(src: ImageDataLike): ImageData {
  const W = src.width;
  const H = src.height;
  const sd = asClamped(src.data);
  const out = new ImageData(W * 2, H * 2);
  const OW = out.width;
  const od = out.data;
  const n = W * H;

  // Alpha deviation from the shader (required for sprites, which are mostly
  // transparent): the shader's RGBtoYUV luma is computed on PREMULTIPLIED rgb,
  // so the garbage colour channels under alpha===0 pixels cannot leak into the
  // distance, and `df` gains an explicit alpha term — otherwise a fully
  // transparent pixel and an opaque black pixel would be indistinguishable.
  // A full opaque<->transparent flip costs XBR_Y_WEIGHT (48), far above
  // XBR_EQ_THRESHOLD (15), so transparent never compares `eq` to anything opaque.
  // Scalars are interleaved into one Float32Array — luma at 2i, the weighted
  // alpha term at 2i+1 — so a `df` between two pixels touches two cache lines
  // instead of four. Float32 is ample: the values live in 0..48 and the only
  // exact comparison is against zero, which survives narrowing.
  const scal = new Float32Array(n * 2);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const a = sd[j + 3] / 255;
    scal[i * 2] =
      XBR_Y_WEIGHT *
      (0.299 * (sd[j] / 255) * a + 0.587 * (sd[j + 1] / 255) * a + 0.114 * (sd[j + 2] / 255) * a);
    scal[i * 2 + 1] = XBR_Y_WEIGHT * a;
  }

  // df(A,B) = abs(A-B) in the shader; here, luma distance plus the alpha term.
  const df = (p: number, q: number) => {
    const pi = p * 2;
    const qi = q * 2;
    return Math.abs(scal[pi] - scal[qi]) + Math.abs(scal[pi + 1] - scal[qi + 1]);
  };
  // eq(A,B) = df(A,B) < XBR_EQ_THRESHOLD
  const eq = (p: number, q: number) => df(p, q) < XBR_EQ_THRESHOLD;
  // weighted_distance(a,b,c,d,e,f,g,h) = df(a,b)+df(a,c)+df(d,e)+df(d,f)+4*df(g,h)
  const wd = (
    a: number,
    b: number,
    c: number,
    d: number,
    e: number,
    f: number,
    g: number,
    h: number,
  ) => df(a, b) + df(a, c) + df(d, e) + df(d, f) + 4.0 * df(g, h);

  // Borders replicate, matching the clamped texture sampling the shader relies on.
  const cols = colTable(W);
  const rows = rowTable(H, W);
  const ci = (px: number, py: number) => rows[py + 2] + cols[px + 2];

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const pE = y * W + x;
      const eOut = pE * 4;
      for (let sy = 0; sy < 2; sy++) {
        // dir = sign(pos): which quadrant of the source pixel this output covers.
        const qy = sy === 0 ? -1 : 1;
        for (let sx = 0; sx < 2; sx++) {
          const qx = sx === 0 ? -1 : 1;
          const oi = ((y * 2 + sy) * OW + x * 2 + sx) * 4;

          // P(dx, dy) = source at (x + dx*qx, y + dy*qy), clamped.
          const pF = ci(x + qx, y);
          const pH = ci(x, y + qy);

          // Leading `(e!=f) && (e!=h)` of interp_restriction_lv1, hoisted out as an
          // early exit: when it fails the whole chain is false and `res` is E, and
          // in a typical sprite most pixels sit inside a flat region where it does
          // fail. The shader's `!=` compares the YUV scalars, not the RGB triples;
          // `df !== 0` is exactly that comparison with the alpha term folded in.
          const dEF = df(pE, pF);
          const dEH = df(pE, pH);
          if (dEF === 0 || dEH === 0) {
            copyPixel(sd, eOut, od, oi);
            continue;
          }

          const pB = ci(x, y - qy);
          const pC = ci(x + qx, y - qy);
          const pD = ci(x - qx, y);
          const pG = ci(x - qx, y + qy);
          const pI = ci(x + qx, y + qy);
          const pF4 = ci(x + 2 * qx, y);
          const pI4 = ci(x + 2 * qx, y + qy);
          const pH5 = ci(x, y + 2 * qy);
          const pI5 = ci(x + qx, y + 2 * qy);

          // Rest of interp_restriction_lv1, with CORNER_C active, verbatim:
          //   ( !eq(f,b) && !eq(f,c) || !eq(h,d) && !eq(h,g)
          //     || eq(e,i) && (!eq(f,f4) && !eq(f,i4) || !eq(h,h5) && !eq(h,i5))
          //     || eq(e,g) || eq(e,c) )
          const interpRestriction =
            (!eq(pF, pB) && !eq(pF, pC)) ||
            (!eq(pH, pD) && !eq(pH, pG)) ||
            (eq(pE, pI) && ((!eq(pF, pF4) && !eq(pF, pI4)) || (!eq(pH, pH5) && !eq(pH, pI5)))) ||
            eq(pE, pG) ||
            eq(pE, pC);

          // Shader order is `weighted_distance(...) < weighted_distance(...) &&
          // interp_restriction_lv1`; evaluating the restriction first is the same
          // boolean and skips ten distance terms whenever it is false.
          const edr =
            interpRestriction &&
            wd(pE, pC, pG, pI, pH5, pF4, pH, pF) < wd(pH, pD, pI5, pF, pI4, pB, pE, pI);

          // nc = (edr && fx), where fx = ( dot(dir,pos) > 0.5 ).
          // At exactly 2x the sub-pixel centre sits at |pos.x| = |pos.y| = 0.25, so
          // dot(dir,pos) == 0.5 EXACTLY and the strict `> 0.5` would be false for
          // every pixel, turning the filter into a no-op. That is an artefact of
          // sampling a freescale shader at precisely 2x: the sub-pixel COVERS the
          // whole quadrant, half of which lies past the fx line. The correct
          // discrete reduction is therefore fx = true, i.e. nc = edr.
          const nc = edr;
          // px = (df(e,f) <= df(e,h));  res = nc ? (px ? F : H) : E;
          const px = dEF <= dEH;
          copyPixel(sd, (nc ? (px ? pF : pH) : pE) * 4, od, oi);
        }
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------

const STEP_BY_ID: Record<UpscaleAlgorithm, ((src: ImageDataLike) => ImageData) | null> = {
  nearest: null,
  scale2x,
  scale3x,
  eagle: eagle2x,
  xbr: xbr2x,
};
