// Pure sprite-sheet grid detection from an ImageData.
//
// Extracted from import.ts so the algorithm can be shared between the
// browser UI (which loads via createImageBitmap) and the Node CLI (which
// loads via pngjs). No DOM dependencies here.

export interface SheetDetection {
  cols: number;
  rows: number;
  confidence: number;
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

  const rowPeriod = detectPeriod(rowActivity);
  const colPeriod = detectPeriod(colActivity);

  if (rowPeriod.lag > 0 && colPeriod.lag > 0) {
    const rows = Math.max(1, Math.round(H / rowPeriod.lag));
    const cols = Math.max(1, Math.round(W / colPeriod.lag));
    if (rows <= 32 && cols <= 32) {
      const conf = Math.min(rowPeriod.score, colPeriod.score);
      return { cols, rows, confidence: 0.5 + conf * 0.4 };
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
    return { cols: colGroups, rows: rowGroups, confidence: 0.6 };
  }

  const candidates = [16, 24, 32, 48, 64, 96, 128, 192, 256];
  for (const size of candidates) {
    if (W % size === 0 && H % size === 0) {
      return { cols: W / size, rows: H / size, confidence: 0.4 };
    }
  }

  return { cols: 1, rows: 1, confidence: 0 };
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
