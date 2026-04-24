import {
  type AutoCropConfig,
  type ChromaKeyConfig,
  computeStats,
  EMPTY_CROP,
  type FrameCrop,
  type Frames,
  isCropEmpty,
  nextFrameId,
  type Frame,
  type Progress,
} from "./types";
import type { ChromaWorkerRequest, ChromaWorkerResponse } from "./chroma.worker";

// Yield to the event loop without the setTimeout-4ms floor, so the browser
// can paint + process user input between per-frame CPU bursts.
function yieldToMain(): Promise<void> {
  return new Promise<void>((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => resolve();
    channel.port2.postMessage(null);
  });
}

// Clone every frame's bitmap. Used by "passthrough" transforms so that
// the step still produces fresh bitmaps owned by this step's cache entry
// — otherwise disposing one cache entry would take out another step's
// bitmaps too.
async function cloneFrames(frames: Frames): Promise<Frames> {
  const out = await Promise.all(
    frames.frames.map(async (f) => ({
      ...f,
      id: nextFrameId(),
      bitmap: await createImageBitmap(f.bitmap),
    })),
  );
  return { frames: out, stats: frames.stats };
}

// -----------------------------------------------------------------
// Chroma-key worker pool
// -----------------------------------------------------------------
// A small pool of workers so we can process several frames in parallel
// while still keeping the main thread free. Each request carries an id
// so responses can be routed back to the right caller.

const POOL_SIZE = (() => {
  if (typeof navigator === "undefined") return 2;
  return Math.min(4, Math.max(2, (navigator.hardwareConcurrency || 4) - 1));
})();

interface PoolWorker {
  worker: Worker;
  busy: boolean;
}

interface QueuedTask {
  req: ChromaWorkerRequest;
  resolve: (b: ImageBitmap) => void;
  reject: (e: Error) => void;
}

let _pool: PoolWorker[] | null = null;
let _chromaReqId = 0;
const _chromaPending = new Map<
  number,
  { resolve: (b: ImageBitmap) => void; reject: (e: Error) => void; workerIdx: number }
>();
const _chromaQueue: QueuedTask[] = [];

function ensurePool(): PoolWorker[] {
  if (_pool) return _pool;
  _pool = [];
  for (let i = 0; i < POOL_SIZE; i++) {
    const worker = new Worker(new URL("./chroma.worker.ts", import.meta.url), {
      type: "module",
    });
    const idx = i;
    worker.onmessage = (e: MessageEvent<ChromaWorkerResponse>) => {
      const entry = _chromaPending.get(e.data.id);
      if (entry) {
        _chromaPending.delete(e.data.id);
        if (e.data.ok) entry.resolve(e.data.bitmap);
        else entry.reject(new Error(e.data.error));
      }
      _pool![idx].busy = false;
      // Kick the next queued task onto this worker.
      const next = _chromaQueue.shift();
      if (next) dispatchTo(idx, next);
    };
    _pool.push({ worker, busy: false });
  }
  return _pool;
}

function dispatchTo(idx: number, task: QueuedTask): void {
  const pool = _pool!;
  pool[idx].busy = true;
  _chromaPending.set(task.req.id, {
    resolve: task.resolve,
    reject: task.reject,
    workerIdx: idx,
  });
  pool[idx].worker.postMessage(task.req, [task.req.bitmap]);
}

function runChromaInWorker(bitmap: ImageBitmap, config: ChromaKeyConfig): Promise<ImageBitmap> {
  const pool = ensurePool();
  const id = ++_chromaReqId;
  const req: ChromaWorkerRequest = {
    id,
    bitmap,
    config: {
      mode: config.mode === "chroma-solid" ? "chroma-solid" : "chroma-transparent",
      similarity: config.similarity,
      softness: config.softness,
      spill: config.spill,
      choke: config.choke,
      solidColor: config.solidColor,
      autoDetermineFillColor: config.autoDetermineFillColor,
    },
  };
  return new Promise<ImageBitmap>((resolve, reject) => {
    const task: QueuedTask = { req, resolve, reject };
    const idleIdx = pool.findIndex((w) => !w.busy);
    if (idleIdx >= 0) dispatchTo(idleIdx, task);
    else _chromaQueue.push(task);
  });
}

async function bitmapToCanvas(
  bitmap: ImageBitmap,
): Promise<{ canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D }> {
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("2D context unavailable");
  ctx.drawImage(bitmap, 0, 0);
  return { canvas, ctx };
}

async function canvasToBitmap(canvas: HTMLCanvasElement): Promise<ImageBitmap> {
  return await createImageBitmap(canvas);
}

// -----------------------------------------------------------------
// Chroma Key — per-frame background removal
// -----------------------------------------------------------------

export async function* chromaKey(
  frames: Frames,
  cfg: ChromaKeyConfig,
): AsyncGenerator<Progress, Frames> {
  if (cfg.mode === "none" || cfg.mode === "transparent-cutout") {
    const cloned = await cloneFrames(frames);
    yield { step: "chroma-key", current: frames.frames.length, total: frames.frames.length };
    return cloned;
  }

  const total = frames.frames.length;
  const out: Frame[] = new Array(total);

  // Kick every frame off to the worker pool simultaneously. The pool caps
  // concurrency; anything over that queues. `createImageBitmap` is itself
  // async on a background thread, so cloning overlaps with worker work.
  let completed = 0;
  const tasks = frames.frames.map(async (src, i) => {
    const clone = await createImageBitmap(src.bitmap);
    const processed = await runChromaInWorker(clone, cfg);
    out[i] = {
      ...src,
      id: nextFrameId(),
      bitmap: processed,
      width: processed.width,
      height: processed.height,
    };
    completed += 1;
  });

  // Race progress polling against the aggregate promise so if any task
  // rejects we surface the error instead of spinning forever.
  const allDone = Promise.all(tasks);
  yield { step: "chroma-key", current: 0, total };
  while (completed < total) {
    await Promise.race([
      new Promise<void>((r) => setTimeout(r, 60)),
      allDone.then(() => {}).catch(() => {}),
    ]);
    yield { step: "chroma-key", current: completed, total };
  }
  await allDone;

  return { frames: out, stats: computeStats(out) };
}

// -----------------------------------------------------------------
// Auto-crop — unify bounding box across all frames
// -----------------------------------------------------------------

export async function autoCrop(frames: Frames, cfg: AutoCropConfig): Promise<Frames> {
  if (!cfg.enabled || frames.frames.length === 0) return await cloneFrames(frames);

  // Per-frame scan for content bounds (non-transparent pixels).
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  let anyContent = false;
  for (let fi = 0; fi < frames.frames.length; fi++) {
    const f = frames.frames[fi];
    const { canvas, ctx } = await bitmapToCanvas(f.bitmap);
    const W = canvas.width,
      H = canvas.height;
    const d = ctx.getImageData(0, 0, W, H).data;

    // Opacity fast-path: if the corners are all fully opaque the frame has
    // no transparent background to trim, so cropping is already a no-op —
    // mark the full frame as content and skip the per-pixel scan.
    const a0 = d[3];
    const aTR = d[(W - 1) * 4 + 3];
    const aBL = d[(H - 1) * W * 4 + 3];
    const aBR = d[(H * W - 1) * 4 + 3];
    if (a0 === 255 && aTR === 255 && aBL === 255 && aBR === 255) {
      minX = Math.min(minX, 0);
      minY = Math.min(minY, 0);
      maxX = Math.max(maxX, W - 1);
      maxY = Math.max(maxY, H - 1);
      anyContent = true;
      if (fi % 4 === 3) await yieldToMain();
      continue;
    }

    // Scan rows top→bottom and bottom→top to narrow Y first, then the
    // remaining vertical slice for X. This is still O(W·H) in the worst
    // case but runs much faster when content is small on a big canvas.
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (d[(y * W + x) * 4 + 3] > 0) {
          if (x < minX) minX = x;
          if (y < minY) minY = y;
          if (x > maxX) maxX = x;
          if (y > maxY) maxY = y;
          anyContent = true;
        }
      }
    }
    if (fi % 4 === 3) await yieldToMain();
  }
  if (!anyContent) return await cloneFrames(frames);

  const padding = cfg.padding;
  const fw = frames.stats.width;
  const fh = frames.stats.height;
  let cx = Math.max(0, minX - padding);
  let cy = Math.max(0, minY - padding);
  let cw = Math.min(fw - cx, maxX - minX + 1 + padding * 2);
  let ch = Math.min(fh - cy, maxY - minY + 1 + padding * 2);

  if (cfg.aspectRatio !== "free") {
    const [rw, rh] = cfg.aspectRatio.split(":").map(Number);
    const target = rw / rh;
    const cur = cw / ch;
    let fw2 = cw,
      fh2 = ch;
    if (cur > target) fh2 = cw / target;
    else fw2 = ch * target;
    const dx = (fw2 - cw) / 2;
    const dy = (fh2 - ch) / 2;
    cx -= dx;
    cy -= dy;
    cw = fw2;
    ch = fh2;
  }

  return await cropFrames(frames, cx, cy, cw, ch);
}

// -----------------------------------------------------------------
// Manual crop — normalized insets per side
// -----------------------------------------------------------------

export async function manualCrop(frames: Frames, crop: FrameCrop): Promise<Frames> {
  if (isCropEmpty(crop) || frames.frames.length === 0) return await cloneFrames(frames);
  const fw = frames.stats.width;
  const fh = frames.stats.height;
  const cx = fw * crop.left;
  const cy = fh * crop.top;
  const cw = Math.max(1, fw - cx - fw * crop.right);
  const ch = Math.max(1, fh - cy - fh * crop.bottom);
  return await cropFrames(frames, cx, cy, cw, ch);
}

async function cropFrames(
  frames: Frames,
  cx: number,
  cy: number,
  cw: number,
  ch: number,
): Promise<Frames> {
  const outW = Math.max(1, Math.round(cw));
  const outH = Math.max(1, Math.round(ch));
  const out: Frame[] = [];
  for (const f of frames.frames) {
    const canvas = document.createElement("canvas");
    canvas.width = outW;
    canvas.height = outH;
    const ctx = canvas.getContext("2d");
    if (!ctx) continue;
    ctx.drawImage(f.bitmap, -Math.round(cx), -Math.round(cy));
    const bitmap = await canvasToBitmap(canvas);
    f.bitmap.close?.();
    out.push({ ...f, id: nextFrameId(), bitmap, width: outW, height: outH });
  }
  return { frames: out, stats: computeStats(out) };
}

// -----------------------------------------------------------------
// Frame selection — cheap slice
// -----------------------------------------------------------------

export function selectFrames(frames: Frames, indices: number[]): Frames {
  if (indices.length === 0) return frames;
  const set = new Set(indices);
  const out = frames.frames.filter((_, i) => set.has(i));
  return { frames: out, stats: computeStats(out) };
}

// -----------------------------------------------------------------
// Small adapter: apply a sequence of crops as a single cumulative op
// -----------------------------------------------------------------

export function composeCrops(base: FrameCrop, delta: FrameCrop): FrameCrop {
  const innerW = 1 - base.left - base.right;
  const innerH = 1 - base.top - base.bottom;
  return {
    top: base.top + delta.top * innerH,
    bottom: base.bottom + delta.bottom * innerH,
    left: base.left + delta.left * innerW,
    right: base.right + delta.right * innerW,
  };
}

export { EMPTY_CROP };
