// Composable sprite pipeline: shared types.
//
// Authoritative pixels live in ImageBitmap (no re-decode between transforms).
// Blob URLs are lazily produced via ensurePreviewUrl for React <img> rendering.

export type FrameId = string;

export interface FrameMetadata {
  cellRow?: number;
  cellCol?: number;
  filename?: string;
  timestamp?: number;
}

export interface Frame {
  id: FrameId;
  bitmap: ImageBitmap;
  width: number;
  height: number;
  sourceIndex: number;
  metadata?: FrameMetadata;
  previewUrl?: string;
}

export interface FramesStats {
  width: number;
  height: number;
  count: number;
  uniform: boolean;
}

export interface Frames {
  frames: Frame[];
  stats: FramesStats;
}

export interface FrameCrop {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export const EMPTY_CROP: FrameCrop = { top: 0, right: 0, bottom: 0, left: 0 };

export function isCropEmpty(c: FrameCrop): boolean {
  return c.top === 0 && c.right === 0 && c.bottom === 0 && c.left === 0;
}

// ---- Transform configs ----

export type BackgroundMode =
  | "none"
  | "chroma-transparent"
  | "chroma-solid"
  | "transparent-cutout";

export interface ChromaKeyConfig {
  mode: BackgroundMode;
  similarity: number;
  softness: number;
  spill: number;
  choke: number;
  solidColor?: string;
  autoDetermineFillColor?: boolean;
}

export interface AutoCropConfig {
  enabled: boolean;
  padding: number;
  aspectRatio: "free" | "1:1" | "16:9" | "9:16" | "4:3" | "3:4";
}

export interface SheetSliceConfig {
  cols: number;
  rows: number;
}

export interface VideoImportConfig {
  fps: number;
}

// ---- Pipeline step model ----

export type StepKind =
  | "import-video"
  | "import-sheet"
  | "import-files"
  | "chroma-key"
  | "auto-crop"
  | "manual-crop"
  | "select";

export interface StepBase<K extends StepKind, C> {
  id: string;
  kind: K;
  config: C;
  label?: string;
}

export type PipelineStep =
  | StepBase<"import-video", VideoImportConfig & { sourceName?: string }>
  | StepBase<"import-sheet", SheetSliceConfig & { sourceName?: string }>
  | StepBase<"import-files", { sourceName?: string; count: number }>
  | StepBase<"chroma-key", ChromaKeyConfig>
  | StepBase<"auto-crop", AutoCropConfig>
  | StepBase<"manual-crop", { crop: FrameCrop }>
  | StepBase<"select", { indices: number[] }>;

// ---- Progress events ----

export interface Progress {
  step: string;
  current: number;
  total: number;
}

// ---- Lazy preview URL plumbing ----

const previewUrlCache = new WeakMap<Frame, string>();
const bitmapToUrl = new WeakMap<ImageBitmap, string>();

export async function ensurePreviewUrl(frame: Frame): Promise<string> {
  const cached = previewUrlCache.get(frame) ?? bitmapToUrl.get(frame.bitmap);
  if (cached) {
    if (!frame.previewUrl) frame.previewUrl = cached;
    return cached;
  }
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
  const url = URL.createObjectURL(blob);
  previewUrlCache.set(frame, url);
  bitmapToUrl.set(frame.bitmap, url);
  frame.previewUrl = url;
  return url;
}

export function revokePreviewUrl(frame: Frame): void {
  const url = previewUrlCache.get(frame);
  if (url) {
    URL.revokeObjectURL(url);
    previewUrlCache.delete(frame);
    frame.previewUrl = undefined;
  }
}

export function disposeFrames(frames: Frames): void {
  for (const f of frames.frames) {
    revokePreviewUrl(f);
    f.bitmap.close?.();
  }
}

export function computeStats(frames: Frame[]): FramesStats {
  if (frames.length === 0) return { width: 0, height: 0, count: 0, uniform: true };
  const w0 = frames[0].width;
  const h0 = frames[0].height;
  let uniform = true;
  for (const f of frames) {
    if (f.width !== w0 || f.height !== h0) {
      uniform = false;
      break;
    }
  }
  return { width: w0, height: h0, count: frames.length, uniform };
}

let frameIdCounter = 0;
export function nextFrameId(): FrameId {
  frameIdCounter += 1;
  return `f${frameIdCounter.toString(36)}`;
}
