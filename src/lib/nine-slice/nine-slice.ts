// Nine-slice (9-patch) geometry and scaling on a plain ImageData-like shape.
//
// A nine-slice panel is cut into four fixed corners, four edges that stretch
// along one axis, and a center that stretches along both. This module owns the
// pure math — inset clamping, region layout, the inset guess, and the actual
// nearest-neighbour resample — so the browser UI (canvas) and the Node CLI/MCP
// (pngjs) share one implementation. No DOM dependencies here.
//
// `detectNineSlice` is a starting guess, not an answer: it reads adjacent-line
// difference profiles and assumes the flattest run on each axis is the
// stretchable middle. That holds up on panels with an obviously flat or
// repeated interior and falls apart on busy or gradient artwork, where the
// manual inset controls are the real interface.

export interface NineSliceInsets {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface NineSliceRegion {
  /**
   * Row-major name: "top-left" | "top-center" | "top-right" | "middle-left" |
   * "center" | "middle-right" | "bottom-left" | "bottom-center" | "bottom-right"
   */
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  stretchX: boolean;
  stretchY: boolean;
}

export interface NineSliceDetectOptions {
  /** Pixels below this alpha are treated as equal to each other regardless of RGB. Default 8. */
  alphaThreshold?: number;
  /**
   * 0..1 normalized adjacent-line difference below which two lines count as
   * "the same". Default 0.02.
   */
  tolerance?: number;
  /** Minimum width/height the stretchable middle must keep. Default 1. */
  minMiddle?: number;
}

export interface NineSliceDetection {
  insets: NineSliceInsets;
  /** 0..1, how much of each axis the flat middle run covered (min of the two axes). */
  confidence: number;
  /** Normalized 0..1 adjacent-column difference, length = width - 1 (empty if width < 2). */
  columnProfile: number[];
  /** Normalized 0..1 adjacent-row difference, length = height - 1 (empty if height < 2). */
  rowProfile: number[];
}

export interface ImageDataLike {
  width: number;
  height: number;
  data: Uint8ClampedArray | Uint8Array;
}

export const DEFAULT_ALPHA_THRESHOLD = 8;
export const DEFAULT_TOLERANCE = 0.02;
export const DEFAULT_MIN_MIDDLE = 1;

const REGION_NAMES = [
  "top-left",
  "top-center",
  "top-right",
  "middle-left",
  "center",
  "middle-right",
  "bottom-left",
  "bottom-center",
  "bottom-right",
] as const;

/** Non-negative integer or 0 for NaN/Infinity/undefined/negative input. */
function safeInt(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

/**
 * Fit an opposing pair into `budget`, shrinking the larger side first and only
 * splitting the remainder once both sides are equal. Never returns negatives.
 */
function fitPair(a: number, b: number, budget: number): [number, number] {
  if (a + b <= budget) return [a, b];
  if (budget <= 0) return [0, 0];

  const aIsLarger = a >= b;
  let hi = aIsLarger ? a : b;
  let lo = aIsLarger ? b : a;
  const excess = hi + lo - budget;
  const gap = hi - lo;

  if (excess <= gap) {
    hi -= excess;
  } else {
    const rest = excess - gap;
    hi = lo;
    const takeHi = Math.ceil(rest / 2);
    hi = Math.max(0, hi - takeHi);
    lo = Math.max(0, lo - (rest - takeHi));
  }

  return aIsLarger ? [hi, lo] : [lo, hi];
}

/**
 * Clamp to non-negative integers that can never overlap: left+right <=
 * width-minMiddle, top+bottom <= height-minMiddle. Shrinks the LARGER of the
 * opposing pair first, and floors at 0. Missing fields default to 0. Never
 * returns NaN.
 */
export function clampInsets(
  insets: Partial<NineSliceInsets>,
  width: number,
  height: number,
  minMiddle: number = DEFAULT_MIN_MIDDLE,
): NineSliceInsets {
  const w = safeInt(width);
  const h = safeInt(height);
  const min = safeInt(minMiddle);
  const [left, right] = fitPair(
    safeInt(insets?.left),
    safeInt(insets?.right),
    Math.max(0, w - min),
  );
  const [top, bottom] = fitPair(
    safeInt(insets?.top),
    safeInt(insets?.bottom),
    Math.max(0, h - min),
  );
  return { left, right, top, bottom };
}

/**
 * Nine rects, row-major, always length 9. The bands are forced to tile the
 * image exactly, so center regions may be zero-sized when the caller passed
 * unclamped insets; callers should clampInsets first.
 */
export function nineSliceRegions(
  insets: NineSliceInsets,
  width: number,
  height: number,
): NineSliceRegion[] {
  const w = safeInt(width);
  const h = safeInt(height);
  const left = Math.min(safeInt(insets?.left), w);
  const right = Math.min(safeInt(insets?.right), w - left);
  const top = Math.min(safeInt(insets?.top), h);
  const bottom = Math.min(safeInt(insets?.bottom), h - top);

  const colWidths = [left, w - left - right, right];
  const rowHeights = [top, h - top - bottom, bottom];
  const colX = [0, colWidths[0], colWidths[0] + colWidths[1]];
  const rowY = [0, rowHeights[0], rowHeights[0] + rowHeights[1]];

  const regions: NineSliceRegion[] = [];
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      regions.push({
        name: REGION_NAMES[row * 3 + col],
        x: colX[col],
        y: rowY[row],
        width: colWidths[col],
        height: rowHeights[row],
        stretchX: col === 1,
        stretchY: row === 1,
      });
    }
  }
  return regions;
}

/**
 * Mean absolute RGBA difference between two pixels, scaled into 0..1. Two
 * pixels that are both below `alphaThreshold` score 0 no matter what their RGB
 * says — transparent PNG areas carry garbage colour.
 */
function pixelDistance(
  data: Uint8ClampedArray | Uint8Array,
  i: number,
  j: number,
  alphaThreshold: number,
): number {
  const ai = data[i + 3];
  const aj = data[j + 3];
  if (ai < alphaThreshold && aj < alphaThreshold) return 0;
  const sum =
    Math.abs(data[i] - data[j]) +
    Math.abs(data[i + 1] - data[j + 1]) +
    Math.abs(data[i + 2] - data[j + 2]) +
    Math.abs(ai - aj);
  return sum / 4 / 255;
}

/** Longest run of indices s..e where profile[i] <= tolerance, or null. */
function longestFlatRun(
  profile: number[],
  tolerance: number,
): { start: number; end: number } | null {
  let best: { start: number; end: number } | null = null;
  let bestLen = 0;
  let runStart = -1;
  for (let i = 0; i <= profile.length; i++) {
    const flat = i < profile.length && profile[i] <= tolerance;
    if (flat) {
      if (runStart < 0) runStart = i;
      continue;
    }
    if (runStart >= 0) {
      const len = i - runStart;
      if (len > bestLen) {
        bestLen = len;
        best = { start: runStart, end: i - 1 };
      }
      runStart = -1;
    }
  }
  return best;
}

/**
 * Guess insets from where content stops varying along each axis. This is a
 * starting guess derived from variance profiles: it lands close on panels with
 * a flat or repeated middle and badly on busy or gradient artwork. Returns
 * clamped insets.
 */
export function detectNineSlice(
  img: ImageDataLike,
  opts: NineSliceDetectOptions = {},
): NineSliceDetection {
  const alphaThreshold = opts.alphaThreshold ?? DEFAULT_ALPHA_THRESHOLD;
  const tolerance = opts.tolerance ?? DEFAULT_TOLERANCE;
  const minMiddle = opts.minMiddle ?? DEFAULT_MIN_MIDDLE;
  const W = img.width;
  const H = img.height;
  const data = img.data;

  const columnProfile: number[] = [];
  for (let x = 0; x + 1 < W; x++) {
    let sum = 0;
    for (let y = 0; y < H; y++) {
      sum += pixelDistance(data, (y * W + x) * 4, (y * W + x + 1) * 4, alphaThreshold);
    }
    columnProfile.push(H > 0 ? sum / H : 0);
  }

  const rowProfile: number[] = [];
  for (let y = 0; y + 1 < H; y++) {
    let sum = 0;
    for (let x = 0; x < W; x++) {
      sum += pixelDistance(data, (y * W + x) * 4, ((y + 1) * W + x) * 4, alphaThreshold);
    }
    rowProfile.push(W > 0 ? sum / W : 0);
  }

  const colRun = longestFlatRun(columnProfile, tolerance);
  const rowRun = longestFlatRun(rowProfile, tolerance);

  // A run over profile indices s..e means columns s..e+1 are mutually similar,
  // so the flat band covers (e - s + 2) columns. An axis under 2px wide has no
  // profile at all and counts as trivially flat.
  const raw: Partial<NineSliceInsets> = {};
  let colCovered = W < 2 ? W : 0;
  let rowCovered = H < 2 ? H : 0;

  if (colRun) {
    raw.left = colRun.start;
    raw.right = W - (colRun.end + 2);
    colCovered = colRun.end - colRun.start + 2;
  }
  if (rowRun) {
    raw.top = rowRun.start;
    raw.bottom = H - (rowRun.end + 2);
    rowCovered = rowRun.end - rowRun.start + 2;
  }

  const confidence = W > 0 && H > 0 ? Math.min(1, Math.min(colCovered / W, rowCovered / H)) : 0;

  return {
    insets: clampInsets(raw, W, H, minMiddle),
    confidence: Math.max(0, confidence),
    columnProfile,
    rowProfile,
  };
}

/**
 * Map a destination coordinate back onto the source for one axis, band by
 * band: the two fixed bands copy 1:1, the middle band is nearest-neighbour
 * resampled. Pixel art must stay crisp, so no filtering anywhere.
 */
function buildAxisMap(
  srcLen: number,
  dstLen: number,
  startInset: number,
  endInset: number,
): Int32Array {
  const map = new Int32Array(dstLen);
  const srcMid = srcLen - startInset - endInset;
  const dstMid = dstLen - startInset - endInset;
  for (let d = 0; d < dstLen; d++) {
    if (d < startInset) {
      map[d] = d;
    } else if (d >= dstLen - endInset) {
      map[d] = srcLen - (dstLen - d);
    } else if (srcMid > 0 && dstMid > 0) {
      map[d] = startInset + Math.floor(((d - startInset) * srcMid) / dstMid);
    } else {
      map[d] = -1;
    }
  }
  return map;
}

/**
 * Render src at targetWidth x targetHeight with the nine regions applied:
 * corners 1:1, edges stretched along one axis, center stretched along both.
 * Nearest-neighbour sampling (pixel art must stay crisp). Throws if the target
 * is smaller than the fixed corner budget (left+right / top+bottom).
 */
export function stretchNineSlice(
  src: ImageDataLike,
  insets: NineSliceInsets,
  targetWidth: number,
  targetHeight: number,
): ImageData {
  const W = safeInt(src.width);
  const H = safeInt(src.height);
  const dstW = safeInt(targetWidth);
  const dstH = safeInt(targetHeight);
  const fitted = clampInsets(insets, W, H, 0);

  if (dstW < fitted.left + fitted.right) {
    throw new Error(
      `stretchNineSlice: targetWidth ${dstW} is smaller than the fixed corner budget ${
        fitted.left + fitted.right
      } (left ${fitted.left} + right ${fitted.right})`,
    );
  }
  if (dstH < fitted.top + fitted.bottom) {
    throw new Error(
      `stretchNineSlice: targetHeight ${dstH} is smaller than the fixed corner budget ${
        fitted.top + fitted.bottom
      } (top ${fitted.top} + bottom ${fitted.bottom})`,
    );
  }

  const out = new ImageData(Math.max(1, dstW), Math.max(1, dstH));
  if (dstW === 0 || dstH === 0 || W === 0 || H === 0) return out;

  const xMap = buildAxisMap(W, dstW, fitted.left, fitted.right);
  const yMap = buildAxisMap(H, dstH, fitted.top, fitted.bottom);
  const srcData = src.data;
  const dstData = out.data;

  for (let y = 0; y < dstH; y++) {
    const sy = yMap[y];
    if (sy < 0) continue;
    for (let x = 0; x < dstW; x++) {
      const sx = xMap[x];
      if (sx < 0) continue;
      const s = (sy * W + sx) * 4;
      const d = (y * dstW + x) * 4;
      dstData[d] = srcData[s];
      dstData[d + 1] = srcData[s + 1];
      dstData[d + 2] = srcData[s + 2];
      dstData[d + 3] = srcData[s + 3];
    }
  }
  return out;
}
