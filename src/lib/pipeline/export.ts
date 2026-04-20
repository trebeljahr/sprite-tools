import JSZip from "jszip";
import type { Frame, Frames } from "./types";

// -----------------------------------------------------------------
// Stitch: arrange frames in a uniform grid → single PNG blob
// -----------------------------------------------------------------

export interface StitchConfig {
  columns: number;
  padding?: number;
}

export async function stitchSheet(
  frames: Frames,
  cfg: StitchConfig,
): Promise<{ blob: Blob; width: number; height: number; cols: number; rows: number }> {
  if (frames.frames.length === 0) throw new Error("No frames to stitch");
  const cols = Math.max(1, cfg.columns);
  const rows = Math.ceil(frames.frames.length / cols);
  const cellW = frames.stats.width;
  const cellH = frames.stats.height;
  const pad = cfg.padding ?? 0;

  const canvas = document.createElement("canvas");
  canvas.width = cols * cellW + Math.max(0, cols - 1) * pad;
  canvas.height = rows * cellH + Math.max(0, rows - 1) * pad;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D context unavailable");

  frames.frames.forEach((f, i) => {
    const c = i % cols;
    const r = Math.floor(i / cols);
    ctx.drawImage(f.bitmap, c * (cellW + pad), r * (cellH + pad));
  });

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/png"),
  );
  if (!blob) throw new Error("toBlob failed");
  return { blob, width: canvas.width, height: canvas.height, cols, rows };
}

// -----------------------------------------------------------------
// Export frames as individual PNGs in a ZIP
// -----------------------------------------------------------------

export interface ZipExportConfig {
  filenamePattern?: string;
}

function defaultFilename(frame: Frame, index: number): string {
  if (frame.metadata?.filename) return frame.metadata.filename;
  if (frame.metadata?.cellRow !== undefined && frame.metadata?.cellCol !== undefined) {
    return `sprite_r${frame.metadata.cellRow}_c${frame.metadata.cellCol}.png`;
  }
  return `frame_${String(index).padStart(4, "0")}.png`;
}

async function frameToPngBlob(frame: Frame): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = frame.width;
  canvas.height = frame.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D context unavailable");
  ctx.drawImage(frame.bitmap, 0, 0);
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/png"),
  );
  if (!blob) throw new Error("toBlob failed");
  return blob;
}

export async function exportAsZip(
  frames: Frames,
  cfg: ZipExportConfig = {},
): Promise<Blob> {
  const zip = new JSZip();
  for (let i = 0; i < frames.frames.length; i++) {
    const f = frames.frames[i];
    const name = cfg.filenamePattern
      ? cfg.filenamePattern.replace("{i}", String(i).padStart(4, "0"))
      : defaultFilename(f, i);
    const blob = await frameToPngBlob(f);
    zip.file(name, blob);
  }
  return await zip.generateAsync({ type: "blob" });
}

export { frameToPngBlob };
