// Pure sprite-sheet grid detection from an ImageData.
//
// Extracted from import.ts so the algorithm can be shared between the
// browser UI (which loads via createImageBitmap) and the Node CLI (which
// loads via pngjs). No DOM dependencies here.

import type { GridMargin, GridSpacing } from "./grid";

export interface SheetDetection {
  cols: number;
  rows: number;
  confidence: number;
  /** Inferred outer border. All zeros when the sheet is flush or unreadable. */
  margin: GridMargin;
  /** Inferred gutter between cells. Zeros likewise. */
  spacing: GridSpacing;
}

export function detectGridFromImageData(imgData: {
  width: number;
  height: number;
  data: Uint8ClampedArray | Uint8Array;
}): SheetDetection {
  const W = imgData.width;
  const H = imgData.height;
  const data = imgData.data;

  // Sample 4 corners for a background reference.
  const corners = [
    [0, 0],
    [W - 1, 0],
    [0, H - 1],
    [W - 1, H - 1],
  ];
  let br = 0;
  let bg = 0;
  let bb = 0;
  let ba = 0;
  for (const [x, y] of corners) {
    const i = (y * W + x) * 4;
    br += data[i];
    bg += data[i + 1];
    bb += data[i + 2];
    ba += data[i + 3];
  }
  br /= 4;
  bg /= 4;
  bb /= 4;
  ba /= 4;
  const BG_TRANSPARENT = ba < 128;
  const THRESHOLD = 20;

  const isBg = (idx: number) => {
    const a = data[idx + 3];
    if (BG_TRANSPARENT) return a < 32;
    return (
      Math.abs(data[idx] - br) < THRESHOLD &&
      Math.abs(data[idx + 1] - bg) < THRESHOLD &&
      Math.abs(data[idx + 2] - bb) < THRESHOLD
    );
  };

  const rowActivity = new Float32Array(H);
  const colActivity = new Float32Array(W);
  for (let y = 0; y < H; y++) {
    let count = 0;
    for (let x = 0; x < W; x++) {
      if (!isBg((y * W + x) * 4)) count++;
    }
    rowActivity[y] = count / W;
  }
  for (let x = 0; x < W; x++) {
    let count = 0;
    for (let y = 0; y < H; y++) {
      if (!isBg((y * W + x) * 4)) count++;
    }
    colActivity[x] = count / H;
  }

  // A tileset with no outer margin (the usual Kenney layout: solid tiles, 1-2px
  // transparent gutters) puts all four corners on tiles, so the corner reference
  // is a tile colour and no scanline ever reads as empty. When that happens and
  // alpha alone does show empty scanlines, those are the gutters — re-read the
  // profiles by transparency. A sheet the corner reference already reads has an
  // empty scanline somewhere (a margin or a gap), so it never takes this branch.
  if (!BG_TRANSPARENT && !hasEmptyScanline(rowActivity) && !hasEmptyScanline(colActivity)) {
    const alphaRows = new Float32Array(H);
    const alphaCols = new Float32Array(W);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (data[(y * W + x) * 4 + 3] >= 32) {
          alphaRows[y]++;
          alphaCols[x]++;
        }
      }
    }
    for (let y = 0; y < H; y++) alphaRows[y] /= W;
    for (let x = 0; x < W; x++) alphaCols[x] /= H;
    if (hasEmptyScanline(alphaRows) || hasEmptyScanline(alphaCols)) {
      rowActivity.set(alphaRows);
      colActivity.set(alphaCols);
    }
  }

  // Padding inference is a refinement pass over the same profiles, run after
  // cols/rows are decided so it cannot shift them.
  const finish = (cols: number, rows: number, confidence: number): SheetDetection => {
    const x = inferAxisPadding(colActivity, cols);
    const y = inferAxisPadding(rowActivity, rows);
    return {
      cols,
      rows,
      confidence,
      margin: { left: x.lead, right: x.trail, top: y.lead, bottom: y.trail },
      spacing: { x: x.spacing, y: y.spacing },
    };
  };

  const rowPeriod = detectPeriod(rowActivity);
  const colPeriod = detectPeriod(colActivity);

  if (rowPeriod.lag > 0 && colPeriod.lag > 0) {
    const rows = Math.max(1, Math.round(H / rowPeriod.lag));
    const cols = Math.max(1, Math.round(W / colPeriod.lag));
    if (rows <= 32 && cols <= 32) {
      const conf = Math.min(rowPeriod.score, colPeriod.score);
      return finish(cols, rows, 0.5 + conf * 0.4);
    }
  }

  // Fallback: gap-based detection on binary bg flags. Works for tightly-packed
  // sheets with little internal transparency where autocorrelation is weak.
  const rowIsBg: boolean[] = new Array(H);
  for (let y = 0; y < H; y++) rowIsBg[y] = rowActivity[y] < 0.01;
  const colIsBg: boolean[] = new Array(W);
  for (let x = 0; x < W; x++) colIsBg[x] = colActivity[x] < 0.01;

  const countCells = (arr: boolean[]): number => {
    let start = 0;
    while (start < arr.length && arr[start]) start++;
    let end = arr.length - 1;
    while (end >= start && arr[end]) end--;
    if (start > end) return 0;
    const gaps: number[] = [];
    let gapLen = 0;
    let inGap = false;
    for (let i = start; i <= end; i++) {
      if (arr[i]) {
        if (!inGap) {
          inGap = true;
          gapLen = 1;
        } else gapLen++;
      } else {
        if (inGap) {
          gaps.push(gapLen);
          inGap = false;
        }
      }
    }
    if (gaps.length === 0) return 1;
    const maxGap = Math.max(...gaps);
    const gutterThreshold = Math.max(1, Math.floor(maxGap * 0.5));
    return gaps.filter((g) => g >= gutterThreshold).length + 1;
  };

  const rowGroups = countCells(rowIsBg);
  const colGroups = countCells(colIsBg);

  if (rowGroups >= 1 && colGroups >= 1 && rowGroups <= 32 && colGroups <= 32) {
    return finish(colGroups, rowGroups, 0.6);
  }

  const candidates = [16, 24, 32, 48, 64, 96, 128, 192, 256];
  for (const size of candidates) {
    if (W % size === 0 && H % size === 0) {
      return finish(W / size, H / size, 0.4);
    }
  }

  return finish(1, 1, 0);
}

/** Same "< 0.01 is empty" convention the gap-based fallback uses. */
function hasEmptyScanline(profile: Float32Array): boolean {
  for (let i = 0; i < profile.length; i++) if (profile[i] < 0.01) return true;
  return false;
}

function detectPeriod(signal: Float32Array): { lag: number; score: number } {
  const n = signal.length;
  if (n < 32) return { lag: 0, score: 0 };

  let mean = 0;
  for (let i = 0; i < n; i++) mean += signal[i];
  mean /= n;
  let variance = 0;
  for (let i = 0; i < n; i++) {
    const d = signal[i] - mean;
    variance += d * d;
  }
  variance /= n;
  if (variance < 1e-8) return { lag: 0, score: 0 };

  const minLag = 8;
  const maxLag = Math.floor(n / 2);
  if (maxLag < minLag) return { lag: 0, score: 0 };

  const acf = new Float32Array(maxLag - minLag + 1);
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0;
    const end = n - lag;
    for (let i = 0; i < end; i++) {
      sum += (signal[i] - mean) * (signal[i + lag] - mean);
    }
    acf[lag - minLag] = sum / (end * variance);
  }

  const peaks: Array<{ lag: number; score: number }> = [];
  for (let i = 1; i < acf.length - 1; i++) {
    if (acf[i] > acf[i - 1] && acf[i] >= acf[i + 1] && acf[i] > 0.2) {
      peaks.push({ lag: i + minLag, score: acf[i] });
    }
  }
  if (peaks.length === 0) return { lag: 0, score: 0 };

  let best = peaks[0];
  for (const p of peaks) if (p.score > best.score) best = p;

  for (let div = 2; div <= 8; div++) {
    const candidate = Math.round(best.lag / div);
    if (candidate < minLag) break;
    const idx = candidate - minLag;
    if (idx < 0 || idx >= acf.length) continue;
    let localBest = -Infinity;
    for (let d = -1; d <= 1; d++) {
      const j = idx + d;
      if (j >= 0 && j < acf.length) localBest = Math.max(localBest, acf[j]);
    }
    if (localBest >= best.score * 0.8) {
      best = { lag: candidate, score: localBest };
    }
  }

  return best;
}

interface AxisPadding {
  lead: number;
  trail: number;
  spacing: number;
}

const NO_PADDING: AxisPadding = { lead: 0, trail: 0, spacing: 0 };

/**
 * Recover margin + gutter for one axis from the activity profile the grid
 * detection already computed. A gutter is a run of consistently-empty scanlines,
 * which is exactly the signal period detection throws away.
 *
 * Ambiguity worth being honest about: if sprites never touch their cell edges you
 * cannot tell a 2px gutter from 2px of whitespace. When the two readings are
 * indistinguishable we report flush (see below); when they are not, the measured
 * decomposition slices tighter than the true grid rather than bleeding a strip of
 * the neighbour in — the failure mode we are here to remove.
 */
function inferAxisPadding(profile: Float32Array, count: number): AxisPadding {
  const n = profile.length;
  // One cell on this axis means no gutter to corroborate a border: the empty
  // runs either side are indistinguishable from whitespace around a lone sprite
  // or a strip. Reading them as margin would crop every single-sprite PNG to its
  // bounding box.
  if (count < 2 || n <= 0) return NO_PADDING;

  // Same "< 0.01 is empty" convention as the gap-based fallback above.
  const blocks: Array<{ start: number; end: number }> = [];
  let start = -1;
  for (let i = 0; i < n; i++) {
    const empty = profile[i] < 0.01;
    if (!empty && start < 0) start = i;
    if (empty && start >= 0) {
      blocks.push({ start, end: i - 1 });
      start = -1;
    }
  }
  if (start >= 0) blocks.push({ start, end: n - 1 });
  // Anything but one content block per cell is not a confident decomposition.
  if (blocks.length !== count) return NO_PADDING;

  // A real gutter is exact: equal blocks, equal gaps. Whitespace between varied
  // sprites is not.
  const cell = blocks[0].end - blocks[0].start + 1;
  if (cell <= 0) return NO_PADDING;
  let gap = 0;
  for (let i = 0; i < blocks.length; i++) {
    if (blocks[i].end - blocks[i].start + 1 !== cell) return NO_PADDING;
    if (i === 0) continue;
    const g = blocks[i].start - blocks[i - 1].end - 1;
    if (i === 1) gap = g;
    else if (g !== gap) return NO_PADDING;
  }

  const lead = blocks[0].start;
  const trail = n - 1 - blocks[blocks.length - 1].end;
  // The decomposition has to close exactly.
  if (lead + count * cell + (count - 1) * gap + trail !== n) return NO_PADDING;

  // FLUSH WINS. If the blocks repeat with exactly the flush cell period, the
  // sheet is indistinguishable from a flush one whose sprites simply do not
  // touch their cell edges (a 32px cell holding a radius-12 circle leaves a
  // 4px lead and 7px interior runs), so report no padding. Only a period that
  // disagrees with the flush cell — sprites drifting across flush boundaries,
  // or a width the count does not divide — is evidence of a real gutter.
  if (n % count === 0 && cell + gap === n / count) return NO_PADDING;

  // Sanity: a gutter or border wider than a cell means we mis-read the profile,
  // and a wrong gutter is worse than none.
  if (gap > cell || lead > cell || trail > cell) return NO_PADDING;

  return { lead, trail, spacing: gap };
}
