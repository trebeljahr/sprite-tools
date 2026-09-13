import { type CellGeometry, cellRect, computeCellGeometry } from "./grid";
import {
  type AsepriteImportConfig,
  computeStats,
  type Frames,
  nextFrameId,
  type SheetSliceConfig,
  type Frame,
  type Progress,
  type VideoImportConfig,
} from "./types";

async function _blobToBitmap(blob: Blob): Promise<ImageBitmap> {
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
// We spin up several <video> elements pointing at the same blob URL
// and stripe frame extraction across them. Each element is its own
// decoder state, so seeks run in parallel across CPU decoders and we
// get near-linear speedup for large fps × duration.

async function loadVideoMeta(url: string): Promise<HTMLVideoElement> {
  const v = document.createElement("video");
  v.src = url;
  v.muted = true;
  v.playsInline = true;
  await new Promise<void>((resolve, reject) => {
    v.onloadedmetadata = () => resolve();
    v.onerror = () => reject(new Error("Video load failed"));
  });
  return v;
}

async function seekAndGrab(
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  tSec: number,
): Promise<ImageBitmap> {
  await new Promise<void>((resolve) => {
    video.onseeked = () => resolve();
    video.currentTime = tSec;
  });
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  return await createImageBitmap(canvas);
}

export async function* importFromVideo(
  source: File | string,
  cfg: VideoImportConfig,
): AsyncGenerator<Progress, Frames> {
  const url = typeof source === "string" ? source : URL.createObjectURL(source);

  // One element to read metadata + frame dimensions.
  const meta = await loadVideoMeta(url);
  const duration = meta.duration;
  const total = Math.max(1, Math.floor(duration * cfg.fps));
  const interval = 1 / cfg.fps;
  const vw = meta.videoWidth;
  const vh = meta.videoHeight;

  // Scale the parallelism down for tiny videos; spinning 4 decoders for
  // 3 frames is pure overhead.
  const PAR = Math.min(
    total,
    typeof navigator !== "undefined"
      ? Math.min(4, Math.max(2, (navigator.hardwareConcurrency || 4) - 1))
      : 2,
  );

  // Reuse the meta element as one of the workers; build the rest.
  const videos: HTMLVideoElement[] = [meta];
  for (let i = 1; i < PAR; i++) videos.push(await loadVideoMeta(url));
  const canvases: HTMLCanvasElement[] = [];
  const ctxs: CanvasRenderingContext2D[] = [];
  for (let i = 0; i < PAR; i++) {
    const c = document.createElement("canvas");
    c.width = vw;
    c.height = vh;
    const cx = c.getContext("2d");
    if (!cx) throw new Error("2D context unavailable");
    canvases.push(c);
    ctxs.push(cx);
  }

  const out: Frame[] = new Array(total);
  let completed = 0;

  const stripes = videos.map(async (v, vIdx) => {
    const c = canvases[vIdx];
    const ctx = ctxs[vIdx];
    for (let i = vIdx; i < total; i += PAR) {
      const bitmap = await seekAndGrab(v, c, ctx, i * interval);
      out[i] = {
        id: nextFrameId(),
        bitmap,
        width: bitmap.width,
        height: bitmap.height,
        sourceIndex: i,
        metadata: { timestamp: i * interval },
      };
      completed += 1;
    }
  });

  const allDone = Promise.all(stripes);
  yield { step: "import-video", current: 0, total };
  while (completed < total) {
    await Promise.race([
      new Promise<void>((r) => setTimeout(r, 60)),
      allDone.then(() => {}).catch(() => {}),
    ]);
    yield { step: "import-video", current: completed, total };
  }
  await allDone;

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

  // A GridFitError is user-facing (the pages toast its message verbatim), so it
  // escapes intact — just not while we still hold the decoded sheet.
  let geom: CellGeometry;
  try {
    geom = computeCellGeometry(bitmap.width, bitmap.height, cfg.cols, cfg.rows, {
      margin: cfg.margin,
      spacing: cfg.spacing,
    });
  } catch (e) {
    bitmap.close?.();
    throw e;
  }
  const { cellW, cellH } = geom;
  if (cellW <= 0 || cellH <= 0) {
    bitmap.close?.();
    throw new Error("Invalid grid: cell size is zero");
  }

  // Sample the sheet's background from its four corners so we can skip
  // cells that are entirely that background / transparent. Still correct with
  // a margin: the margin *is* background, so the corners read the same colour.
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
      const rect = cellRect(geom, c, r);
      const cell = await createImageBitmap(bitmap, rect.x, rect.y, rect.w, rect.h);
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
  let r = 0,
    g = 0,
    b = 0,
    a = 0;
  for (const [x, y] of corners) {
    const i = (y * W + x) * 4;
    r += d[i];
    g += d[i + 1];
    b += d[i + 2];
    a += d[i + 3];
  }
  r /= 4;
  g /= 4;
  b /= 4;
  a /= 4;
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
    // Browsers report `type: ""` for .ase/.aseprite, so the image guard below
    // would drop one without a word. Fail loudly instead — the file is
    // importable, just not through this step.
    if (isAsepriteFilename(f.name)) {
      throw new Error(`${f.name} is an Aseprite file — import it from the Aseprite source tab.`);
    }
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
// Aseprite (.ase / .aseprite) → Frames
// -----------------------------------------------------------------
// Note the import path: `inflateWeb` (DecompressionStream), never the
// Node zlib inflater. This module is part of the client bundle, and a
// Node built-in pulled in here breaks the Turbopack build.

import { compositeFrame, isAsepriteFile, parseAseprite } from "@/lib/aseprite";
import { inflateWeb } from "@/lib/aseprite/inflate";
import type { AseDocument } from "@/lib/aseprite/types";
import { type FrameDuration, normalizeFrameDurations } from "@/lib/animation/durations";

export type { AseDocument };

/** Extensions the source pickers route on. `File.type` is "" for both. */
export function isAsepriteFilename(name: string): boolean {
  return /\.(ase|aseprite)$/i.test(name);
}

// The source picker parses the file to show layers, tags and warnings before
// the user runs anything, and then the pipeline parses it again to composite.
// Parsing is the expensive half (every cel is inflated), so keep the document
// alive per File. A WeakMap keyed on the File is safe: a different upload is a
// different File object, so a stale document can never be served to a new file,
// and the entry dies with the File.
const docByFile = new WeakMap<File, Promise<AseDocument>>();

function parseFile(file: File): Promise<AseDocument> {
  const cached = docByFile.get(file);
  if (cached) return cached;
  const pending = (async () => {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!isAsepriteFile(bytes)) {
      throw new Error(`${file.name} is not an Aseprite file (bad magic number).`);
    }
    return await parseAseprite(bytes, { inflate: inflateWeb });
  })();
  docByFile.set(file, pending);
  // Forget a failure: a read can fail for reasons that go away (the file was
  // replaced on disk mid-read), and a cached rejection would make a retry of
  // the same File fail forever.
  pending.catch(() => {
    if (docByFile.get(file) === pending) docByFile.delete(file);
  });
  return pending;
}

/**
 * Document metadata for the UI: tags, layers, palette and `warnings`. Frames
 * alone cannot carry any of it. Shares the parse with importFromAseprite, so
 * calling this before a run costs nothing extra.
 */
export async function readAsepriteMeta(file: File): Promise<AseDocument> {
  return await parseFile(file);
}

// Aseprite tag names are free text and end up as export filenames.
function sanitizeName(name: string): string {
  return name.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "tag";
}

// Same dedupe rule the compositor uses: a note that fires on every run (or on
// every frame) must still show up once.
function warnOnce(doc: AseDocument, message: string): void {
  if (!doc.warnings.includes(message)) doc.warnings.push(message);
}

// -----------------------------------------------------------------
// Layer picker model
// -----------------------------------------------------------------
// DOM-free so the rules that decide what a user may select are testable
// without a browser, and so the source picker and the importer agree on them.

export interface AsepriteLayerChoice {
  index: number;
  name: string;
  childLevel: number;
  /** Set when the layer cannot contribute pixels; the picker shows it disabled with this text. */
  disabledReason?: string;
}

/**
 * Every pixel-bearing layer of the document, in file order, with the reason it
 * cannot be selected when it would never reach the output. Groups are left out
 * because they hold no pixels of their own; their children are listed instead.
 */
export function asepriteLayerChoices(
  doc: AseDocument,
  includeHiddenLayers: boolean,
): AsepriteLayerChoice[] {
  const out: AsepriteLayerChoice[] = [];
  for (const l of doc.layers) {
    if (l.type === "group") continue;
    let disabledReason: string | undefined;
    // Order matters: a hidden reference layer is still excluded by being a
    // reference layer, and turning on hidden layers would not change that.
    if (l.reference) {
      disabledReason = "Reference layer: Aseprite never renders it into an export";
    } else if (l.type === "tilemap") {
      disabledReason = "Tilemap layer: tilesets are not supported, so it renders empty";
    } else if (!l.effectivelyVisible && !includeHiddenLayers) {
      disabledReason = "Hidden in Aseprite: turn on Include hidden layers to use it";
    }
    out.push({ index: l.index, name: l.name, childLevel: l.childLevel, disabledReason });
  }
  return out;
}

/**
 * Next layer selection after the user clicks `name`. `null` means "every
 * layer" and is returned whenever the selection covers every selectable layer,
 * so the step config (and its cache key) stays minimal.
 *
 * A click on a disabled layer is ignored, and so is a click that would leave
 * nothing selectable selected: that import would produce a sheet of empty
 * frames with no hint why.
 */
export function toggleAsepriteLayer(
  current: string[] | null,
  name: string,
  choices: AsepriteLayerChoice[],
): string[] | null {
  const selectable = [...new Set(choices.filter((c) => !c.disabledReason).map((c) => c.name))];
  if (!selectable.includes(name)) return current;
  const base = current ?? selectable;
  const next = base.includes(name) ? base.filter((n) => n !== name) : [...base, name];
  if (!next.some((n) => selectable.includes(n))) return current;
  return selectable.every((n) => next.includes(n)) ? null : next;
}

// -----------------------------------------------------------------
// Import plan
// -----------------------------------------------------------------

export interface AsepriteImportPlan {
  /** Passed to the compositor; undefined composites every layer. */
  layerIndices?: number[];
  frames: { index: number; filename: string; durationMs: FrameDuration }[];
}

/**
 * Everything importFromAseprite decides before touching a pixel: which layers,
 * which frames, and what each frame is called and how long it is held. Pure
 * apart from appending to `doc.warnings`, which is where every non-fatal note
 * about this document goes so the source picker can show it.
 */
export function planAsepriteImport(
  doc: AseDocument,
  config: AsepriteImportConfig,
  sourceName: string,
): AsepriteImportPlan {
  // Names, not indices — see the comment on AsepriteImportConfig. A name that
  // no longer matches any layer simply drops out, and a selection that matches
  // nothing is treated as "no filter" so a stale config can't render nothing.
  let layerIndices: number[] | undefined;
  if (config.layerNames && config.layerNames.length > 0) {
    const wanted = new Set(config.layerNames);
    const matched = doc.layers.filter((l) => wanted.has(l.name));
    if (matched.length > 0) {
      layerIndices = matched.map((l) => l.index);
      const contributes = asepriteLayerChoices(doc, config.includeHiddenLayers).some(
        (c) => !c.disabledReason && wanted.has(c.name),
      );
      if (!contributes) {
        warnOnce(
          doc,
          "Every selected layer is hidden, a reference layer or a tilemap, so the imported frames are empty.",
        );
      }
    } else {
      warnOnce(doc, "None of the selected layers exist in this file; every layer was imported.");
    }
  }

  let from = 0;
  let to = doc.frameCount - 1;
  let activeTag: AseDocument["tags"][number] | undefined;
  if (config.tag !== undefined) {
    activeTag = doc.tags.find((t) => t.name === config.tag);
    if (!activeTag) {
      warnOnce(doc, `Tag "${config.tag}" is not in this file; every frame was imported.`);
    }
  }
  if (activeTag) {
    // Tag ranges come straight out of the file and are clamped rather than
    // trusted; a hand-edited .ase can name frames that do not exist.
    from = Math.max(0, activeTag.from);
    to = Math.min(doc.frameCount - 1, activeTag.to);
    if (from > to) {
      throw new Error(
        `Tag "${activeTag.name}" covers frames ${activeTag.from}-${activeTag.to}, but the file has ${doc.frameCount} frame(s).`,
      );
    }
    if (from !== activeTag.from || to !== activeTag.to) {
      warnOnce(
        doc,
        `Tag "${activeTag.name}" covers frames ${activeTag.from}-${activeTag.to}; clamped to ${from}-${to}.`,
      );
    }
  }

  // Main's duration model: positive whole milliseconds or null ("no explicit
  // hold"). Normalising here keeps a zero or corrupt frame duration from
  // reaching a consumer as a real hold time.
  const holds = normalizeFrameDurations(
    doc.frames.map((f) => f.durationMs),
    doc.frameCount,
  );

  const base = sanitizeName(sourceName.replace(/\.(ase|aseprite)$/i, ""));
  const frames: AsepriteImportPlan["frames"] = [];
  for (let i = from; i <= to; i++) {
    // Any tag covering this frame, not just the one being imported — a
    // full-document import still wants its tag names in the exported filenames.
    const tag = activeTag ?? doc.tags.find((t) => i >= t.from && i <= t.to);
    const seq = String(i).padStart(4, "0");
    frames.push({
      index: i,
      filename: tag ? `${base}-${sanitizeName(tag.name)}-${seq}.png` : `${base}-${seq}.png`,
      durationMs: holds?.[i] ?? null,
    });
  }
  return { layerIndices, frames };
}

/**
 * Raw straight-alpha RGBA to an ImageBitmap via the house canvas round-trip
 * (see transforms.ts bitmapToCanvas/canvasToBitmap). `putImageData` writes the
 * bytes unpremultiplied and without compositing, which is exactly what
 * Aseprite's cel data already is.
 */
async function rgbaToBitmap(rgba: Uint8ClampedArray, w: number, h: number): Promise<ImageBitmap> {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D context unavailable");
  // Copy into a fresh ImageData rather than `new ImageData(rgba, w, h)`: the
  // composited buffer is typed `Uint8ClampedArray<ArrayBufferLike>` and the
  // ImageData constructor only accepts a plain ArrayBuffer-backed view.
  const img = new ImageData(w, h);
  img.data.set(rgba);
  ctx.putImageData(img, 0, 0);
  return await createImageBitmap(canvas);
}

export async function importFromAseprite(
  file: File,
  config: AsepriteImportConfig,
): Promise<Frames> {
  const doc = await parseFile(file);
  const plan = planAsepriteImport(doc, config, file.name);
  const opts = { includeHiddenLayers: config.includeHiddenLayers, layerIndices: plan.layerIndices };
  const out: Frame[] = [];
  try {
    for (const planned of plan.frames) {
      // One frame at a time: a tag import only pays for its own range, and
      // only one canvas-sized buffer is alive between bitmaps.
      const src = compositeFrame(doc, planned.index, opts);
      const bitmap = await rgbaToBitmap(src.pixels, src.width, src.height);
      out.push({
        id: nextFrameId(),
        bitmap,
        width: src.width,
        height: src.height,
        sourceIndex: planned.index,
        metadata: { filename: planned.filename, durationMs: planned.durationMs },
      });
    }
  } catch (e) {
    // The pipeline only disposes frames it gets back; bitmaps made before a
    // failure would otherwise hold GPU memory until the page is closed.
    for (const f of out) f.bitmap.close();
    throw e;
  }
  return { frames: out, stats: computeStats(out) };
}

// -----------------------------------------------------------------
// Auto-detect sprite sheet grid
// -----------------------------------------------------------------

import { detectGridFromImageData, type SheetDetection as SheetDetectionType } from "./detect";

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
    return {
      cols: 1,
      rows: 1,
      confidence: 0,
      margin: { left: 0, top: 0, right: 0, bottom: 0 },
      spacing: { x: 0, y: 0 },
    };
  }
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close?.();
  return detectGridFromImageData(ctx.getImageData(0, 0, W, H));
}
