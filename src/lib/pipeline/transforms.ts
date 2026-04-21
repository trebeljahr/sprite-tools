import { applyChromaKey, hexToRgb } from "@/lib/utils";
import {
  AutoCropConfig,
  ChromaKeyConfig,
  computeStats,
  EMPTY_CROP,
  FrameCrop,
  Frames,
  isCropEmpty,
  nextFrameId,
  type Frame,
  type Progress,
} from "./types";

// Yield to the event loop without the setTimeout-4ms floor, so the browser
// can paint + process user input between per-frame CPU bursts.
function yieldToMain(): Promise<void> {
  return new Promise<void>((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => resolve();
    channel.port2.postMessage(null);
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
    // Passthrough — frames remain as-is. Yield a single progress tick so
    // consumers relying on the generator pump still see completion.
    yield { step: "chroma-key", current: frames.frames.length, total: frames.frames.length };
    return { frames: frames.frames, stats: frames.stats };
  }

  const out: Frame[] = [];
  const total = frames.frames.length;

  for (let i = 0; i < total; i++) {
    const src = frames.frames[i];
    const { canvas, ctx } = await bitmapToCanvas(src.bitmap);

    // Use the existing sampleBackground helper by rendering through an img.
    // Simpler: sample 4 corners directly from the ImageData.
    const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const d = imgData.data;
    const w = canvas.width;
    const h = canvas.height;
    const corners = [
      { r: d[0], g: d[1], b: d[2] },
      { r: d[(w - 1) * 4], g: d[(w - 1) * 4 + 1], b: d[(w - 1) * 4 + 2] },
      {
        r: d[d.length - w * 4],
        g: d[d.length - w * 4 + 1],
        b: d[d.length - w * 4 + 2],
      },
      { r: d[d.length - 4], g: d[d.length - 3], b: d[d.length - 2] },
    ];
    const counts: Record<string, { r: number; g: number; b: number; n: number }> = {};
    for (const c of corners) {
      const k = `${c.r},${c.g},${c.b}`;
      counts[k] = counts[k]
        ? { ...c, n: counts[k].n + 1 }
        : { ...c, n: 1 };
    }
    let target = corners[0];
    let best = 0;
    for (const k of Object.keys(counts)) {
      if (counts[k].n > best) {
        best = counts[k].n;
        target = counts[k];
      }
    }

    if (cfg.mode === "chroma-solid") {
      // Solid fill mode: replace background with sampled/solid color.
      const sampled = sampleBackgroundFromImageData(imgData);
      const tgt = cfg.autoDetermineFillColor
        ? sampled.corners
        : {
            tl: hexToRgb(cfg.solidColor ?? "#ffffff"),
            tr: hexToRgb(cfg.solidColor ?? "#ffffff"),
            bl: hexToRgb(cfg.solidColor ?? "#ffffff"),
            br: hexToRgb(cfg.solidColor ?? "#ffffff"),
          };
      applySolidFill(ctx, w, h, sampled, tgt, cfg);
    } else {
      // Transparent mode: the existing chroma key helper.
      applyChromaKey(ctx, w, h, target, cfg);
    }

    const bitmap = await canvasToBitmap(canvas);
    src.bitmap.close?.();
    out.push({ ...src, id: nextFrameId(), bitmap, width: w, height: h });
    yield { step: "chroma-key", current: i + 1, total };
    // Let the browser paint + handle user input between frames. Matters for
    // big sheets where a single frame can take tens of milliseconds.
    await yieldToMain();
  }

  return { frames: out, stats: computeStats(out) };
}

function sampleBackgroundFromImageData(data: ImageData) {
  const W = data.width,
    H = data.height;
  const d = data.data;
  const pixel = (x: number, y: number) => {
    const i = (y * W + x) * 4;
    return { r: d[i], g: d[i + 1], b: d[i + 2] };
  };
  const corners = {
    tl: pixel(0, 0),
    tr: pixel(W - 1, 0),
    bl: pixel(0, H - 1),
    br: pixel(W - 1, H - 1),
  };
  const r = Math.round((corners.tl.r + corners.tr.r + corners.bl.r + corners.br.r) / 4);
  const g = Math.round((corners.tl.g + corners.tr.g + corners.bl.g + corners.br.g) / 4);
  const b = Math.round((corners.tl.b + corners.tr.b + corners.bl.b + corners.br.b) / 4);
  return { r, g, b, corners };
}

function applySolidFill(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  sampled: ReturnType<typeof sampleBackgroundFromImageData>,
  target: { tl: { r: number; g: number; b: number }; tr: { r: number; g: number; b: number }; bl: { r: number; g: number; b: number }; br: { r: number; g: number; b: number } },
  cfg: ChromaKeyConfig,
) {
  const { similarity, softness } = cfg;
  const srcR = sampled.r,
    srcG = sampled.g,
    srcB = sampled.b;
  const img = ctx.getImageData(0, 0, w, h);
  const data = img.data;

  // Build a feathered mask (255 = keep, 0 = replace)
  const mask = new Uint8Array(w * h);
  for (let j = 0, k = 0; j < data.length; j += 4, k++) {
    const dist = Math.sqrt(
      Math.pow(data[j] - srcR, 2) +
        Math.pow(data[j + 1] - srcG, 2) +
        Math.pow(data[j + 2] - srcB, 2),
    );
    let m = 255;
    if (dist < similarity) m = 0;
    else if (dist < similarity + softness) m = Math.round(((dist - similarity) / softness) * 255);
    mask[k] = m;
  }

  // Bilinear-blend target corners across the frame
  const colorAt = (x: number, y: number) => {
    const u = x / (w - 1 || 1);
    const v = y / (h - 1 || 1);
    const top = {
      r: target.tl.r * (1 - u) + target.tr.r * u,
      g: target.tl.g * (1 - u) + target.tr.g * u,
      b: target.tl.b * (1 - u) + target.tr.b * u,
    };
    const bot = {
      r: target.bl.r * (1 - u) + target.br.r * u,
      g: target.bl.g * (1 - u) + target.br.g * u,
      b: target.bl.b * (1 - u) + target.br.b * u,
    };
    return {
      r: top.r * (1 - v) + bot.r * v,
      g: top.g * (1 - v) + bot.g * v,
      b: top.b * (1 - v) + bot.b * v,
    };
  };

  for (let y = 0, k = 0; y < h; y++) {
    for (let x = 0; x < w; x++, k++) {
      const j = k * 4;
      const m = mask[k] / 255;
      const fill = colorAt(x, y);
      data[j] = data[j] * m + fill.r * (1 - m);
      data[j + 1] = data[j + 1] * m + fill.g * (1 - m);
      data[j + 2] = data[j + 2] * m + fill.b * (1 - m);
      data[j + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

// -----------------------------------------------------------------
// Auto-crop — unify bounding box across all frames
// -----------------------------------------------------------------

export async function autoCrop(
  frames: Frames,
  cfg: AutoCropConfig,
): Promise<Frames> {
  if (!cfg.enabled || frames.frames.length === 0) return frames;

  // Per-frame scan for content bounds (non-transparent pixels).
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  let anyContent = false;
  for (let fi = 0; fi < frames.frames.length; fi++) {
    const f = frames.frames[fi];
    const { canvas, ctx } = await bitmapToCanvas(f.bitmap);
    const W = canvas.width, H = canvas.height;
    const d = ctx.getImageData(0, 0, W, H).data;

    // Opacity fast-path: if the corners are all fully opaque the frame has
    // no transparent background to trim, so cropping is already a no-op —
    // mark the full frame as content and skip the per-pixel scan.
    const a0 = d[3];
    const aTR = d[(W - 1) * 4 + 3];
    const aBL = d[((H - 1) * W) * 4 + 3];
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
  if (!anyContent) return frames;

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

export async function manualCrop(
  frames: Frames,
  crop: FrameCrop,
): Promise<Frames> {
  if (isCropEmpty(crop) || frames.frames.length === 0) return frames;
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
