import {
  computeStats,
  Frames,
  nextFrameId,
  SheetSliceConfig,
  type Frame,
  type Progress,
  type VideoImportConfig,
} from "./types";

async function blobToBitmap(blob: Blob): Promise<ImageBitmap> {
  return await createImageBitmap(blob);
}

async function fileToBitmap(file: File): Promise<ImageBitmap> {
  return await createImageBitmap(file);
}

async function urlToBitmap(url: string): Promise<ImageBitmap> {
  const res = await fetch(url);
  const blob = await res.blob();
  return await createImageBitmap(blob);
}

// -----------------------------------------------------------------
// Video → Frames (sample N fps)
// -----------------------------------------------------------------

export async function* importFromVideo(
  source: File | string,
  cfg: VideoImportConfig,
): AsyncGenerator<Progress, Frames> {
  const url = typeof source === "string" ? source : URL.createObjectURL(source);
  const video = document.createElement("video");
  video.src = url;
  video.muted = true;
  video.playsInline = true;
  await new Promise<void>((resolve, reject) => {
    video.onloadedmetadata = () => resolve();
    video.onerror = () => reject(new Error("Video load failed"));
  });

  const duration = video.duration;
  const total = Math.max(1, Math.floor(duration * cfg.fps));
  const interval = 1 / cfg.fps;

  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D context unavailable");

  const out: Frame[] = [];
  for (let i = 0; i < total; i++) {
    video.currentTime = i * interval;
    await new Promise<void>((resolve) => (video.onseeked = () => resolve()));
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/png"),
    );
    if (blob) {
      const bitmap = await blobToBitmap(blob);
      out.push({
        id: nextFrameId(),
        bitmap,
        width: bitmap.width,
        height: bitmap.height,
        sourceIndex: i,
        metadata: { timestamp: i * interval },
      });
    }
    yield { step: "import-video", current: i + 1, total };
  }

  if (typeof source !== "string") URL.revokeObjectURL(url);
  return { frames: out, stats: computeStats(out) };
}

// -----------------------------------------------------------------
// Sprite sheet → Frames (slice by grid)
// -----------------------------------------------------------------

export async function importFromSpriteSheet(
  source: File | HTMLImageElement | string,
  cfg: SheetSliceConfig,
): Promise<Frames> {
  let bitmap: ImageBitmap;
  if (source instanceof File) bitmap = await fileToBitmap(source);
  else if (typeof source === "string") bitmap = await urlToBitmap(source);
  else bitmap = await createImageBitmap(source);

  const cellW = Math.floor(bitmap.width / cfg.cols);
  const cellH = Math.floor(bitmap.height / cfg.rows);
  if (cellW <= 0 || cellH <= 0) {
    bitmap.close?.();
    throw new Error("Invalid grid: cell size is zero");
  }

  // Sample the sheet's background from its four corners so we can skip
  // cells that are entirely that background / transparent.
  const sheetCanvas = document.createElement("canvas");
  sheetCanvas.width = bitmap.width;
  sheetCanvas.height = bitmap.height;
  const sheetCtx = sheetCanvas.getContext("2d", { willReadFrequently: true });
  if (!sheetCtx) {
    bitmap.close?.();
    throw new Error("2D context unavailable");
  }
  sheetCtx.drawImage(bitmap, 0, 0);
  const bg = sampleCornerBg(sheetCtx, bitmap.width, bitmap.height);

  const out: Frame[] = [];
  let idx = 0;
  for (let r = 0; r < cfg.rows; r++) {
    for (let c = 0; c < cfg.cols; c++) {
      const cell = await createImageBitmap(
        bitmap,
        c * cellW,
        r * cellH,
        cellW,
        cellH,
      );
      if (isCellEmpty(cell, bg)) {
        cell.close?.();
        continue;
      }
      out.push({
        id: nextFrameId(),
        bitmap: cell,
        width: cellW,
        height: cellH,
        sourceIndex: idx,
        metadata: { cellRow: r, cellCol: c },
      });
      idx += 1;
    }
  }
  bitmap.close?.();
  return { frames: out, stats: computeStats(out) };
}

interface BgSample {
  r: number;
  g: number;
  b: number;
  a: number;
  transparent: boolean;
}

function sampleCornerBg(ctx: CanvasRenderingContext2D, W: number, H: number): BgSample {
  const d = ctx.getImageData(0, 0, W, H).data;
  const corners = [
    [0, 0],
    [W - 1, 0],
    [0, H - 1],
    [W - 1, H - 1],
  ];
  let r = 0, g = 0, b = 0, a = 0;
  for (const [x, y] of corners) {
    const i = (y * W + x) * 4;
    r += d[i];
    g += d[i + 1];
    b += d[i + 2];
    a += d[i + 3];
  }
  r /= 4; g /= 4; b /= 4; a /= 4;
  return { r, g, b, a, transparent: a < 128 };
}

function isCellEmpty(cell: ImageBitmap, bg: BgSample): boolean {
  const W = cell.width;
  const H = cell.height;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return false;
  ctx.drawImage(cell, 0, 0);
  const d = ctx.getImageData(0, 0, W, H).data;

  // Sample ~4k pixels max for speed
  const step = Math.max(1, Math.floor(Math.sqrt((W * H) / 4000)));
  const THRESHOLD = 30;
  let sampled = 0;
  let bgLike = 0;
  for (let y = 0; y < H; y += step) {
    for (let x = 0; x < W; x += step) {
      const i = (y * W + x) * 4;
      sampled += 1;
      if (bg.transparent) {
        if (d[i + 3] < 32) bgLike += 1;
      } else {
        const dist = Math.hypot(d[i] - bg.r, d[i + 1] - bg.g, d[i + 2] - bg.b);
        if (dist < THRESHOLD) bgLike += 1;
      }
    }
  }
  return sampled > 0 && bgLike / sampled > 0.98;
}

// -----------------------------------------------------------------
// Individual images → Frames
// -----------------------------------------------------------------

export async function importFromFiles(files: File[]): Promise<Frames> {
  const sorted = [...files].sort((a, b) => a.name.localeCompare(b.name));
  const out: Frame[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const f = sorted[i];
    if (!f.type.startsWith("image/")) continue;
    const bitmap = await fileToBitmap(f);
    out.push({
      id: nextFrameId(),
      bitmap,
      width: bitmap.width,
      height: bitmap.height,
      sourceIndex: i,
      metadata: { filename: f.name },
    });
  }
  return { frames: out, stats: computeStats(out) };
}

// -----------------------------------------------------------------
// Auto-detect sprite sheet grid
// -----------------------------------------------------------------

export interface SheetDetection {
  cols: number;
  rows: number;
  confidence: number;
}

export async function detectSheetGrid(
  source: File | HTMLImageElement | string,
): Promise<SheetDetection> {
  let bitmap: ImageBitmap;
  if (source instanceof File) bitmap = await fileToBitmap(source);
  else if (typeof source === "string") bitmap = await urlToBitmap(source);
  else bitmap = await createImageBitmap(source);

  const W = bitmap.width;
  const H = bitmap.height;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    bitmap.close?.();
    return { cols: 1, rows: 1, confidence: 0 };
  }
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close?.();
  const data = ctx.getImageData(0, 0, W, H).data;

  // Sample 4 corners for background reference
  const corners = [
    [0, 0],
    [W - 1, 0],
    [0, H - 1],
    [W - 1, H - 1],
  ];
  let br = 0,
    bg = 0,
    bb = 0,
    ba = 0;
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

  // Build per-row / per-column activity signals: fraction of non-bg pixels.
  // These are continuous (not binary), so autocorrelation can pick up the
  // periodic structure even when sprites have internal transparent areas
  // that would confuse simple gap-counting.
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

  // Primary detector: autocorrelation. A sheet of K cells has a repeating
  // pattern with period = dim/K — that's the smallest lag where the signal
  // strongly correlates with itself.
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
  // sheets with little internal transparency, where autocorrelation is weak.
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

  // Fallback: equal-cell heuristic — try common cell sizes
  const candidates = [16, 24, 32, 48, 64, 96, 128, 192, 256];
  for (const size of candidates) {
    if (W % size === 0 && H % size === 0) {
      return { cols: W / size, rows: H / size, confidence: 0.4 };
    }
  }

  return { cols: 1, rows: 1, confidence: 0 };
}

/**
 * Find the fundamental period of a 1-D signal via autocorrelation.
 *
 * A sprite sheet of K equal cells produces a signal that repeats every
 * `dim / K` samples, so ACF peaks at that lag, 2× that lag, 3× that lag…
 * We return the *smallest* lag whose correlation is a strong local maximum.
 * Sub-peaks caused by repeating features inside one cell (e.g. two wings and
 * a body) are usually weaker than the cell-level peak because they don't
 * align across the full signal.
 */
function detectPeriod(
  signal: Float32Array,
): { lag: number; score: number } {
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

  // Walk ACF and collect local maxima with their scores.
  const peaks: Array<{ lag: number; score: number }> = [];
  for (let i = 1; i < acf.length - 1; i++) {
    if (acf[i] > acf[i - 1] && acf[i] >= acf[i + 1] && acf[i] > 0.2) {
      peaks.push({ lag: i + minLag, score: acf[i] });
    }
  }
  if (peaks.length === 0) return { lag: 0, score: 0 };

  // Find the strongest peak — that's the most likely cell period (or an
  // integer multiple of it).
  let best = peaks[0];
  for (const p of peaks) if (p.score > best.score) best = p;

  // Check smaller divisors of the best lag: if lag/2 or lag/3 etc. also has
  // strong correlation (>= 0.8 × best), it's probably the true fundamental.
  for (let div = 2; div <= 8; div++) {
    const candidate = Math.round(best.lag / div);
    if (candidate < minLag) break;
    const idx = candidate - minLag;
    if (idx < 0 || idx >= acf.length) continue;
    // Use a small neighborhood to tolerate off-by-one peak locations.
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
