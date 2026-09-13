// Shared contract for the engine exporters.
//
// Every `sprite-tools` metadata command emits a header-shaped JSON document so
// that several of them merge cleanly with `jq -s add`. `atlas` emits a
// TexturePacker-style manifest instead. The exporters must not care which of
// those (or which merge of them) they were handed, so everything funnels
// through `normalizeExportInput` first and each format module is then a pure
// NormalizedDoc -> string / object function.
//
// No `node:` imports here — this module is pulled into browser bundles by the
// web surface, so `basename` is implemented locally.

import {
  cellRect,
  computeCellGeometry,
  GridFitError,
  normalizeGridPadding,
  type GridPadding,
} from "../pipeline/grid";
import type { SheetDetection } from "../pipeline/detect";
import { normalizeFrameDurations } from "../animation/durations";

export type Direction = "forward" | "reverse" | "pingpong";

export interface ExportRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ExportSize {
  w: number;
  h: number;
}

export interface ExportPoint {
  x: number;
  y: number;
}

export interface ExportTag {
  name: string;
  /** Inclusive, clamped into [0, frames.length - 1]. */
  from: number;
  /** Inclusive, always >= `from`. */
  to: number;
  direction: Direction;
  fps: number;
}

/**
 * One frame, fully resolved: where it lives in the texture, its untrimmed
 * canvas, its pivot, and how long it shows.
 */
export interface NormalizedFrame {
  /** Stable, unique frame name. */
  name: string;
  /** 0-based frame order. */
  index: number;
  /** Region within the texture. */
  frame: ExportRect;
  /** Always false — the packer never rotates. */
  rotated: boolean;
  trimmed: boolean;
  sourceSize: ExportSize;
  spriteSourceSize: ExportRect;
  /**
   * px, top-left origin, relative to `sourceSize`, as a continuous canvas
   * coordinate: `(w, h)` is the far corner of the canvas, not its last pixel.
   */
  pivot: ExportPoint | null;
  /**
   * On-screen time in ms: the frame's own `frameDurations` hold when it has
   * one, else the fps of the first tag covering it, else the default fps.
   */
  durationMs: number;
  /** The document's `frameDurations[index]` hold, or null when the frame has none. */
  explicitDurationMs: number | null;
  /** Collision, px relative to the frame. */
  polygon: Array<[number, number]> | null;
}

export interface NormalizedDoc {
  source: string | null;
  /** Image filename, e.g. "hero.png". */
  texture: string;
  textureWidth: number;
  textureHeight: number;
  grid: { cols: number; rows: number } | null;
  frames: NormalizedFrame[];
  tags: ExportTag[];
  /** Rate for frames no tag covers (`opts.defaultFps`, else 10). */
  defaultFps: number;
}

export interface NormalizeExportOptions {
  /** Override the texture filename. */
  texture?: string;
  /** Override the frame-name stem. */
  namePrefix?: string;
  defaultFps?: number;
  /**
   * Real pixel size of a grid document's sheet, read from the image itself.
   * Wins over the document's own `sourceWidth`/`sourceHeight`. Ignored for
   * atlas manifests, whose `width`/`height` describe the packed texture.
   */
  sheetSize?: { width: number; height: number };
}

/** Matches the `--fps` default of the `tags` / `meta` commands. */
export const EXPORT_DEFAULT_FPS = 10;

/** Fallback texture name when neither the input nor the caller supplies one. */
const FALLBACK_TEXTURE = "spritesheet.png";

// ---------------------------------------------------------------------------
// Raw input shapes — what the CLI actually writes. Every field is optional
// because the input is user-supplied JSON (often a partial `jq -s add` merge),
// so nothing may be assumed present before it is checked.
// ---------------------------------------------------------------------------

export interface RawGrid {
  cols?: number;
  rows?: number;
  detected?: boolean;
  /** Reported by `slice --json` and every MCP sheet tool; absent means flush. */
  margin?: number | { left?: number; top?: number; right?: number; bottom?: number };
  spacing?: number | { x?: number; y?: number };
}

export interface RawPivotEntry {
  index?: number;
  cell?: { row?: number; col?: number };
  pivot?: { x?: number; y?: number };
}

export interface RawCollisionEntry {
  index?: number;
  cell?: { row?: number; col?: number };
  pointCount?: number;
  rawContourLength?: number;
  bounds?: { x: number; y: number; width: number; height: number } | null;
  polygon?: Array<[number, number]>;
}

export interface RawTag {
  name?: string;
  from?: number;
  to?: number;
  direction?: string;
  fps?: number;
}

/** `collision` / `pivot` / `tags` / `meta` output, or any `jq -s add` merge of them. */
export interface SpriteMetaDocument {
  source?: string;
  /** Pixel size of `source`, recorded by the metadata commands. */
  sourceWidth?: number;
  sourceHeight?: number;
  frameWidth?: number;
  frameHeight?: number;
  grid?: RawGrid;
  frameCount?: number;
  collision?: RawCollisionEntry[];
  pivots?: RawPivotEntry[];
  tags?: RawTag[];
  /** ms per frame from `tags`/`meta --duration`; null = use the covering tag's fps. */
  frameDurations?: Array<number | null>;
  /** Provenance only — the per-command `options` blocks are never consumed. */
  options?: unknown;
  palette?: unknown;
  swaps?: unknown;
}

export interface AtlasFrameEntry {
  frame: ExportRect;
  trimmed?: boolean;
  sourceSize?: ExportSize;
  spriteSourceSize?: ExportRect;
}

/** `atlas` output — TexturePacker-style, not header-shaped. */
export interface AtlasManifestDocument {
  atlas?: string;
  width?: number;
  height?: number;
  frames: Record<string, AtlasFrameEntry>;
}

/** Anything `normalizeExportInput` accepts, including a header+atlas hybrid. */
export type ExportInputDocument = SpriteMetaDocument & Partial<AtlasManifestDocument>;

export type ExportInputKind = "atlas" | "grid" | "hybrid" | "unknown";

// ---------------------------------------------------------------------------
// Discriminators
// ---------------------------------------------------------------------------

/** True when the document carries an atlas manifest's `frames` map. */
export function isAtlasManifestDocument(doc: unknown): doc is AtlasManifestDocument {
  const rec = asRecord(doc);
  if (!rec) return false;
  const frames = asRecord(rec.frames);
  return frames !== null && Object.keys(frames).length > 0;
}

/** True when the document carries usable grid-sheet geometry. */
export function isSpriteMetaDocument(doc: unknown): doc is SpriteMetaDocument {
  const rec = asRecord(doc);
  if (!rec) return false;
  const grid = asRecord(rec.grid);
  return (
    asPositive(rec.frameWidth) !== null &&
    asPositive(rec.frameHeight) !== null &&
    grid !== null &&
    asPositive(grid.cols) !== null &&
    asPositive(grid.rows) !== null
  );
}

/**
 * Which geometry source(s) a document offers. Format modules rarely need this
 * — `normalizeExportInput` already resolves it — but it makes "this input
 * cannot carry X" messages precise.
 */
export function detectExportInputKind(doc: unknown): ExportInputKind {
  const atlas = isAtlasManifestDocument(doc);
  const grid = isSpriteMetaDocument(doc);
  if (atlas && grid) return "hybrid";
  if (atlas) return "atlas";
  if (grid) return "grid";
  return "unknown";
}

// ---------------------------------------------------------------------------
// Normalizer
// ---------------------------------------------------------------------------

export function normalizeExportInput(
  doc: unknown,
  opts: NormalizeExportOptions = {},
): NormalizedDoc {
  const rec = asRecord(doc);
  if (!rec) {
    throw new Error(
      "export: input must be a JSON object — expected a sprite-tools metadata document " +
        "(frameWidth/frameHeight/grid) or an atlas manifest (frames map); got " +
        describe(doc),
    );
  }

  // Image-producing tools (background removal, pixelate, palette swap) echo a
  // header-shaped block, but its `source`, `grid` and padding describe the
  // INPUT image while the pixels they wrote live at `output_path`, re-stitched
  // flush. Exporting it would point the engine at the wrong image.
  if (typeof rec.output_path === "string") {
    throw new Error(
      `export: this document describes an image written to ${JSON.stringify(rec.output_path)}, ` +
        "not metadata for a sheet — its grid is the input's. Run a metadata command " +
        "(sprite-tools meta / sprite_generate_meta) on the output PNG and export that instead.",
    );
  }

  const defaultFps = asPositive(opts.defaultFps) ?? EXPORT_DEFAULT_FPS;
  const atlasFrames = readAtlasFrames(rec);
  // A hybrid's `source` comes from the header, i.e. the pre-pack sheet. The
  // packed texture is a different asset, so nothing downstream (Unity's guid
  // seed, Aseprite's filename naming) may treat the header's path as its own.
  const source = !atlasFrames && typeof rec.source === "string" && rec.source ? rec.source : null;

  // A hybrid (header jq-merged with an atlas manifest) resolves to the atlas:
  // the manifest is the authoritative record of where pixels actually landed in
  // the packed texture, while the header's frameWidth/grid only describe the
  // pre-pack sheet. Tags/pivots/collision from the header still attach, by
  // index, to the manifest's own frame order.
  const geometry = atlasFrames ? buildFromAtlas(rec, atlasFrames, opts) : buildFromGrid(rec, opts);

  const frames = geometry.frames;
  if (frames.length === 0) {
    throw new Error(
      "export: input describes zero frames — nothing to export. Pipe in a sheet with a " +
        "non-zero frameCount/grid, or an atlas manifest with a non-empty frames map.",
    );
  }

  const tags = normalizeTags(rec.tags, frames.length, defaultFps);
  attachPivots(rec.pivots, frames);
  attachCollision(rec.collision, frames);
  attachDurations(frames, tags, defaultFps, rec.frameDurations);

  return {
    source,
    texture: geometry.texture,
    textureWidth: geometry.textureWidth,
    textureHeight: geometry.textureHeight,
    grid: geometry.grid,
    frames,
    tags,
    defaultFps,
  };
}

interface Geometry {
  texture: string;
  textureWidth: number;
  textureHeight: number;
  grid: { cols: number; rows: number } | null;
  frames: NormalizedFrame[];
}

function buildFromAtlas(
  rec: Record<string, unknown>,
  entries: Array<[string, Record<string, unknown>]>,
  opts: NormalizeExportOptions,
): Geometry {
  const texture =
    opts.texture ??
    (typeof rec.atlas === "string" && rec.atlas ? rec.atlas : null) ??
    (typeof rec.source === "string" && rec.source ? basename(rec.source) : null) ??
    FALLBACK_TEXTURE;

  const used = new Set<string>();
  const frames: NormalizedFrame[] = [];
  let maxRight = 0;
  let maxBottom = 0;

  entries.forEach(([key, entry], index) => {
    const frame = asRect(entry.frame);
    if (!frame || frame.w <= 0 || frame.h <= 0) {
      throw new Error(
        `export: atlas frame "${key}" has no usable rect — expected ` +
          `frame: { x, y, w, h } with positive w/h, got ${describe(entry.frame)}.`,
      );
    }
    const sourceSize = asSize(entry.sourceSize) ?? { w: frame.w, h: frame.h };
    const spriteSourceSize = asRect(entry.spriteSourceSize) ?? {
      x: 0,
      y: 0,
      w: frame.w,
      h: frame.h,
    };
    const trimmed =
      typeof entry.trimmed === "boolean"
        ? entry.trimmed
        : spriteSourceSize.x !== 0 ||
          spriteSourceSize.y !== 0 ||
          sourceSize.w !== frame.w ||
          sourceSize.h !== frame.h;

    maxRight = Math.max(maxRight, frame.x + frame.w);
    maxBottom = Math.max(maxBottom, frame.y + frame.h);

    frames.push({
      // Manifest keys are already meaningful sprite names — keep them verbatim.
      name: uniqueName(key, used),
      index,
      frame,
      rotated: false,
      trimmed,
      sourceSize,
      spriteSourceSize,
      pivot: null,
      durationMs: 0,
      explicitDurationMs: null,
      polygon: null,
    });
  });

  // A manifest always carries width/height, but a hand-merged doc may not —
  // fall back to the packed extent so downstream size checks still work.
  const textureWidth = asPositive(rec.width) ?? maxRight;
  const textureHeight = asPositive(rec.height) ?? maxBottom;

  return { texture, textureWidth, textureHeight, grid: null, frames };
}

function buildFromGrid(rec: Record<string, unknown>, opts: NormalizeExportOptions): Geometry {
  const grid = asRecord(rec.grid);
  const frameWidth = asFinite(rec.frameWidth);
  const frameHeight = asFinite(rec.frameHeight);

  if (frameWidth === null || frameHeight === null || !grid) {
    throw new Error(
      "export: no recognizable frame geometry — expected a sprite-tools metadata document " +
        "(frameWidth/frameHeight/grid) or an atlas manifest (frames map); got neither. " +
        "Pipe in `sprite-tools meta ...`, a `jq -s add` merge of collision/pivot/tags, " +
        "or `sprite-tools atlas --json ...`.",
    );
  }
  if (frameWidth <= 0 || frameHeight <= 0) {
    throw new Error(
      `export: frameWidth/frameHeight must be positive, got ${frameWidth}×${frameHeight}.`,
    );
  }

  const cols = asPositive(grid.cols);
  const rows = asPositive(grid.rows);
  if (cols === null || rows === null) {
    throw new Error(
      `export: grid must have positive cols/rows, got ${describe(grid.cols)}×${describe(grid.rows)}. ` +
        "Re-run the metadata command with --cols/--rows if grid detection failed.",
    );
  }

  // A padded sheet's cells do not start at col*frameWidth. The MCP sheet tools
  // (and `slice --json`) record the margin/spacing they sliced with inside
  // `grid`; ignoring it would shift every region into the gutter.
  let padding: GridPadding;
  try {
    padding = normalizeGridPadding({
      margin: grid.margin as RawGrid["margin"],
      spacing: grid.spacing as RawGrid["spacing"],
    } as Parameters<typeof normalizeGridPadding>[0]);
  } catch (err) {
    throw new Error(`export: invalid grid padding — ${(err as Error).message}.`);
  }
  const geom = { cellW: frameWidth, cellH: frameHeight, padding };
  const size = resolveSheetSize(rec, opts, cols, rows, frameWidth, frameHeight, padding);
  const { margin, spacing } = padding;

  const cells = cols * rows;
  const declared = asFinite(rec.frameCount);
  // Prefer the explicit frameCount (a sheet's last row may be short), but never
  // let it run past the grid — cells beyond it have no pixels behind them. A
  // declared 0 is honoured and falls through to the zero-frames error below.
  const count = declared !== null && declared >= 0 ? Math.min(Math.floor(declared), cells) : cells;

  const texture =
    opts.texture ??
    (typeof rec.source === "string" && rec.source ? basename(rec.source) : null) ??
    FALLBACK_TEXTURE;
  const rawStem = opts.namePrefix ?? stripExtension(basename(texture));
  const stem = rawStem.length > 0 ? rawStem : "frame";
  // 12 frames -> indices 0..11 -> width 2 -> hero_00 .. hero_11.
  const padWidth = String(Math.max(0, count - 1)).length;

  const used = new Set<string>();
  const frames: NormalizedFrame[] = [];
  for (let index = 0; index < count; index++) {
    const col = index % cols;
    const row = Math.floor(index / cols);
    frames.push({
      name: uniqueName(`${stem}_${String(index).padStart(padWidth, "0")}`, used),
      index,
      frame: cellRect(geom, col, row),
      rotated: false,
      trimmed: false,
      sourceSize: { w: frameWidth, h: frameHeight },
      spriteSourceSize: { x: 0, y: 0, w: frameWidth, h: frameHeight },
      pivot: null,
      durationMs: 0,
      explicitDurationMs: null,
      polygon: null,
    });
  }

  return {
    texture,
    textureWidth:
      size?.width ?? margin.left + margin.right + frameWidth * cols + spacing.x * (cols - 1),
    textureHeight:
      size?.height ?? margin.top + margin.bottom + frameHeight * rows + spacing.y * (rows - 1),
    grid: { cols, rows },
    frames,
  };
}

/**
 * The sheet's real pixel size, when anything knows it, checked against the
 * grid the document claims.
 *
 * Rebuilding the size from `frameWidth × cols` is wrong whenever the slicer
 * floored (a 64×65 sheet in 2 rows still slices 32px cells) — and Unity flips
 * every rect against that height, so a single stray pixel row shifts every
 * sprite. The check re-runs the slicer's own geometry: a document whose cells
 * disagree with its image was sliced with padding it did not record, and every
 * region would land in the gutter.
 */
function resolveSheetSize(
  rec: Record<string, unknown>,
  opts: NormalizeExportOptions,
  cols: number,
  rows: number,
  frameWidth: number,
  frameHeight: number,
  padding: GridPadding,
): { width: number; height: number } | null {
  const fromOpts = opts.sheetSize;
  const width = asPositive(fromOpts?.width) ?? asPositive(rec.sourceWidth);
  const height = asPositive(fromOpts?.height) ?? asPositive(rec.sourceHeight);
  if (width === null || height === null) return null;

  const padded =
    padding.margin.left + padding.margin.right + padding.margin.top + padding.margin.bottom > 0 ||
    padding.spacing.x + padding.spacing.y > 0;
  const layout = padded ? "the recorded margin/spacing" : "no margin or spacing";
  const hint = padded
    ? "Re-run the metadata command on this image."
    : "The document probably omits grid.margin/grid.spacing — re-run the metadata command " +
      "on this image with a current sprite-tools, which records them.";
  let cell: { cellW: number; cellH: number };
  try {
    cell = computeCellGeometry(width, height, cols, rows, padding);
  } catch (err) {
    if (!(err instanceof GridFitError)) throw err;
    throw new Error(
      `export: the ${cols}×${rows} grid does not fit the ${width}×${height} sheet — ` +
        `${err.message}. ${hint}`,
    );
  }
  if (cell.cellW !== frameWidth || cell.cellH !== frameHeight) {
    throw new Error(
      `export: a ${cols}×${rows} grid with ${layout} slices the ${width}×${height} sheet into ` +
        `${cell.cellW}×${cell.cellH} cells, but the document says ${frameWidth}×${frameHeight}. ` +
        hint,
    );
  }
  return { width, height };
}

/** Manifest entries in the map's own key order, or null when there is no map. */
function readAtlasFrames(
  rec: Record<string, unknown>,
): Array<[string, Record<string, unknown>]> | null {
  const frames = asRecord(rec.frames);
  if (!frames) return null;
  const entries: Array<[string, Record<string, unknown>]> = [];
  for (const key of Object.keys(frames)) {
    const entry = asRecord(frames[key]);
    if (entry) entries.push([key, entry]);
  }
  return entries.length > 0 ? entries : null;
}

function normalizeTags(raw: unknown, frameCount: number, defaultFps: number): ExportTag[] {
  if (!Array.isArray(raw)) return [];
  const last = frameCount - 1;
  const tags: ExportTag[] = [];
  for (const item of raw) {
    const rec = asRecord(item);
    if (!rec || typeof rec.name !== "string") continue;
    const a = asFinite(rec.from);
    const b = asFinite(rec.to);
    if (a === null || b === null) continue;
    // A tag authored against a different frame count may be inverted; swap
    // rather than drop, since the direction field carries playback order.
    const lo = Math.floor(Math.min(a, b));
    const hi = Math.floor(Math.max(a, b));
    if (hi < 0 || lo > last) continue;
    tags.push({
      name: rec.name,
      from: Math.max(0, lo),
      to: Math.min(last, hi),
      direction: normalizeDirection(rec.direction),
      fps: asPositive(rec.fps) ?? defaultFps,
    });
  }
  return tags;
}

function normalizeDirection(raw: unknown): Direction {
  if (raw === "reverse" || raw === "pingpong") return raw;
  return "forward";
}

function attachPivots(raw: unknown, frames: NormalizedFrame[]): void {
  if (!Array.isArray(raw)) return;
  for (const item of raw) {
    const rec = asRecord(item);
    if (!rec) continue;
    const index = asFinite(rec.index);
    // Pivot lists outlive the sheets they were made for; an index that no
    // longer exists is dropped rather than treated as a fatal input error.
    if (index === null || index < 0 || index >= frames.length) continue;
    const pivot = asRecord(rec.pivot);
    if (!pivot) continue;
    const x = asFinite(pivot.x);
    const y = asFinite(pivot.y);
    if (x === null || y === null) continue;
    // Already cell-relative with a top-left origin, which is exactly
    // sourceSize-relative for the untrimmed canvas the pivot was measured on.
    const frame = frames[Math.floor(index)];
    frame.pivot = { x: pixelToEdge(x, frame.sourceSize.w), y: pixelToEdge(y, frame.sourceSize.h) };
  }
}

function attachCollision(raw: unknown, frames: NormalizedFrame[]): void {
  if (!Array.isArray(raw)) return;
  for (const item of raw) {
    const rec = asRecord(item);
    if (!rec) continue;
    const index = asFinite(rec.index);
    if (index === null || index < 0 || index >= frames.length) continue;
    const polygon = asPolygon(rec.polygon);
    if (!polygon) continue;
    frames[Math.floor(index)].polygon = polygon;
  }
}

function attachDurations(
  frames: NormalizedFrame[],
  tags: ExportTag[],
  defaultFps: number,
  rawDurations: unknown,
): void {
  const fallback = msPerFrame(defaultFps);
  // `frameDurations` is indexed like pivots and collision — by frame index,
  // which for an atlas manifest is its key order. A hold belongs to the
  // drawing, so it overrides every tag's fps for that frame.
  const holds = normalizeFrameDurations(rawDurations, frames.length);
  for (const frame of frames) {
    const hold = holds?.[frame.index] ?? null;
    frame.explicitDurationMs = hold;
    if (hold !== null) {
      frame.durationMs = Math.max(1, Math.round(hold));
      continue;
    }
    // First covering tag wins. Tag order is authoring order (the order the
    // --tag flags were given), so "first" is the one the user listed first —
    // stable and explainable. Picking the narrowest span instead would let an
    // unrelated overlapping tag silently change a frame's timing.
    const tag = tags.find((t) => frame.index >= t.from && frame.index <= t.to);
    frame.durationMs = tag ? msPerFrame(tag.fps) : fallback;
  }
}

/**
 * The pivot tools (CLI, MCP, web) pick a PIXEL, clamped to 0..size-1, so the
 * `bottom-center` preset lands on row 47 of a 48px frame. Every engine reads
 * the pivot as a point on the canvas, where row 47 is one pixel above the
 * bottom edge and the sprite would sink into the ground by that pixel. The last
 * pixel therefore means the far edge. Interior values stay on the pixel's
 * leading edge, which keeps even-sized centres exact and every anchor on a
 * whole pixel.
 */
function pixelToEdge(v: number, size: number): number {
  return size > 1 && v === size - 1 ? size : v;
}

function msPerFrame(fps: number): number {
  return Math.max(1, Math.round(1000 / fps));
}

/**
 * A bare grid document for a sheet known only by its pixels: the web page's
 * "Use current sheet". Cell size comes from the same geometry the slicer uses,
 * so a detected border and gutter are subtracted before dividing — `width /
 * cols` on a padded sheet gives cells that straddle the gutters. Detected
 * padding that does not tile the sheet is dropped, as the CLI does, because
 * detection is a hint rather than an assertion.
 */
export function sheetDocumentFromDetection(
  source: string,
  width: number,
  height: number,
  detection: SheetDetection,
): SpriteMetaDocument & {
  sourceWidth: number;
  sourceHeight: number;
  grid: { cols: number; rows: number; detected: boolean } & GridPadding;
} {
  const cols = Math.max(1, Math.floor(detection.cols));
  const rows = Math.max(1, Math.floor(detection.rows));
  let geom: { cellW: number; cellH: number; padding: GridPadding };
  try {
    geom = computeCellGeometry(width, height, cols, rows, {
      margin: detection.margin,
      spacing: detection.spacing,
    });
  } catch (err) {
    if (!(err instanceof GridFitError)) throw err;
    geom = computeCellGeometry(width, height, cols, rows);
  }
  return {
    source,
    sourceWidth: width,
    sourceHeight: height,
    frameWidth: geom.cellW,
    frameHeight: geom.cellH,
    grid: {
      cols,
      rows,
      detected: detection.confidence > 0,
      margin: geom.padding.margin,
      spacing: geom.padding.spacing,
    },
    frameCount: cols * rows,
    tags: [],
  };
}

// ---------------------------------------------------------------------------
// Shared helpers for the format modules
// ---------------------------------------------------------------------------

/**
 * Frame indices a tag plays, in playback order. `pingpong` bakes to
 * from..to, to-1..from+1 — endpoints are not repeated, matching Aseprite (and
 * unlike Godot's native LOOP_PINGPONG, which replays them).
 */
export function expandTagFrameIndices(tag: ExportTag): number[] {
  const forward: number[] = [];
  for (let i = tag.from; i <= tag.to; i++) forward.push(i);
  if (tag.direction === "reverse") return forward.slice().reverse();
  if (tag.direction === "pingpong" && forward.length > 2) {
    return forward.concat(forward.slice(1, -1).reverse());
  }
  return forward;
}

/** Filename after the last `/` or `\`, so this works on Windows paths too. */
export function basename(path: string): string {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return cut >= 0 ? path.slice(cut + 1) : path;
}

/** Filename without its final extension. Leading-dot names keep their dot. */
export function stripExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

// ---------------------------------------------------------------------------
// unknown -> typed coercions
// ---------------------------------------------------------------------------

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function asFinite(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function asPositive(v: unknown): number | null {
  const n = asFinite(v);
  return n !== null && n > 0 ? n : null;
}

function asRect(v: unknown): ExportRect | null {
  const rec = asRecord(v);
  if (!rec) return null;
  const x = asFinite(rec.x);
  const y = asFinite(rec.y);
  const w = asFinite(rec.w);
  const h = asFinite(rec.h);
  if (x === null || y === null || w === null || h === null) return null;
  return { x, y, w, h };
}

function asSize(v: unknown): ExportSize | null {
  const rec = asRecord(v);
  if (!rec) return null;
  const w = asFinite(rec.w);
  const h = asFinite(rec.h);
  if (w === null || h === null) return null;
  return { w, h };
}

function asPolygon(v: unknown): Array<[number, number]> | null {
  if (!Array.isArray(v)) return null;
  const points: Array<[number, number]> = [];
  for (const p of v) {
    if (!Array.isArray(p)) continue;
    const x = asFinite(p[0]);
    const y = asFinite(p[1]);
    if (x === null || y === null) continue;
    points.push([x, y]);
  }
  return points.length > 0 ? points : null;
}

function uniqueName(base: string, used: Set<string>): string {
  const stem = base || "frame";
  if (!used.has(stem)) {
    used.add(stem);
    return stem;
  }
  let n = 2;
  while (used.has(`${stem}_${n}`)) n++;
  const name = `${stem}_${n}`;
  used.add(name);
  return name;
}

/** Renders the offending value into an error message — the value if it is a
 *  primitive, its shape otherwise, so messages point at real input. */
function describe(v: unknown): string {
  if (v === null) return "null";
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return "an array";
  if (typeof v === "object") return "an object";
  return typeof v;
}
