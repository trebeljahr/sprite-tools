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

import {
  detectGridFromImageData,
  type SheetDetection as SheetDetectionType,
} from "./detect";

export type SheetDetection = SheetDetectionType;

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
  return detectGridFromImageData(ctx.getImageData(0, 0, W, H));
}
