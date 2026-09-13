// Shared pixel and frame math for the lint rules.
//
// The orchestrator builds one RuleContext and hands it to every rule, so each
// rule reads the same slices, the same grid and the same config. Everything
// here is DOM-free (only the global ImageData shape, which both the browser
// and the Node CLI have) and stateless — rules own their own thresholds.
//
// Frame-local vs sheet-absolute: frames are sliced ImageData, so anything a
// rule measures inside a frame is frame-local. Findings are sheet-absolute,
// so convert with frameOriginOf / sheetPointOf / sheetRegionOf on the way out.

import { computeTrimRect } from "../atlas/pack";
import { type CellGeometry, cellRect } from "../pipeline/grid";
import type { RGB } from "../pixel-art/pixelate";
import {
  type CellRef,
  type Finding,
  type FindingData,
  type GridInfo,
  type LintConfig,
  type Point,
  type Region,
  type RuleId,
  type Severity,
  SEVERITY_ORDER,
  PIVOT_PRESETS,
  type PivotPresetId,
  type SkippedRule,
} from "./types";

// -----------------------------------------------------------------
// Rule plumbing
// -----------------------------------------------------------------

/** Built once by lintSheet() and passed to every rule. */
export interface RuleContext {
  source: string;
  image: ImageData;
  /** Row-major, one per grid cell. A 1x1 grid yields the sheet itself. */
  frames: ImageData[];
  grid: GridInfo;
  /** Cell size plus the margin/spacing the cells were cut with. */
  geometry: CellGeometry;
  frameWidth: number;
  frameHeight: number;
  config: LintConfig;
}

/**
 * A rule reports findings, skips, or both — a rule that cannot judge its
 * preconditions must skip with a reason rather than guess.
 */
export interface RuleResult {
  findings: Finding[];
  skipped: SkippedRule[];
}

export type LintRule = (ctx: RuleContext) => RuleResult;

export function ruleResult(findings: Finding[] = [], skipped: SkippedRule[] = []): RuleResult {
  return { findings, skipped };
}

/** Bail out of a rule, recording why it could not run. */
export function skipRule(rule: RuleId, reason: string): RuleResult {
  return { findings: [], skipped: [{ rule, reason }] };
}

export function isRuleEnabled(ctx: RuleContext, rule: RuleId): boolean {
  return ctx.config.rules[rule].enabled;
}

export function severityOf(ctx: RuleContext, rule: RuleId): Severity {
  return ctx.config.rules[rule].severity;
}

// -----------------------------------------------------------------
// Finding construction
// -----------------------------------------------------------------

export interface FindingInit {
  rule: RuleId;
  message: string;
  /** Defaults to the rule's configured severity. */
  severity?: Severity;
  /** Row-major frame index; omit for sheet-wide findings. */
  frame?: number | null;
  /** Derived from `frame` when omitted; pass null to suppress. */
  cell?: CellRef | null;
  /** Sheet-absolute. */
  at?: Point | null;
  /** Sheet-absolute. */
  region?: Region | null;
  data?: FindingData;
}

/**
 * Build a Finding with the null defaults filled in, so no rule hand-rolls the
 * object shape and every finding sorts and serialises the same way.
 */
export function makeFinding(ctx: RuleContext, init: FindingInit): Finding {
  const frame = init.frame ?? null;
  const cell =
    init.cell !== undefined ? init.cell : frame === null ? null : frameCellOf(frame, ctx.grid.cols);
  return {
    rule: init.rule,
    severity: init.severity ?? severityOf(ctx, init.rule),
    message: init.message,
    frame,
    cell,
    at: init.at ?? null,
    region: init.region ?? null,
    data: init.data ?? {},
  };
}

/** Report sort order: severity, then rule id, then frame index. */
export function compareFindings(a: Finding, b: Finding): number {
  const bySeverity = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
  if (bySeverity !== 0) return bySeverity;
  if (a.rule !== b.rule) return a.rule < b.rule ? -1 : 1;
  return (a.frame ?? -1) - (b.frame ?? -1);
}

export function countSeverities(findings: Finding[]): {
  errors: number;
  warnings: number;
  infos: number;
} {
  let errors = 0;
  let warnings = 0;
  let infos = 0;
  for (const f of findings) {
    if (f.severity === "error") errors++;
    else if (f.severity === "warning") warnings++;
    else infos++;
  }
  return { errors, warnings, infos };
}

// -----------------------------------------------------------------
// Frame / cell geometry
// -----------------------------------------------------------------

export function frameCellOf(index: number, cols: number): CellRef {
  const c = Math.max(1, cols);
  return { row: Math.floor(index / c), col: index % c };
}

export function frameIndexOf(row: number, col: number, cols: number): number {
  return row * Math.max(1, cols) + col;
}

/**
 * Top-left corner of a frame in sheet-absolute pixels. Goes through the
 * pipeline's cellRect so a margin and gutters land every finding on the same
 * cut lines the slicer used, not on a flush cols x cellW guess.
 */
export function frameOriginOf(ctx: RuleContext, index: number): Point {
  const { row, col } = frameCellOf(index, ctx.grid.cols);
  const rect = cellRect(ctx.geometry, col, row);
  return { x: rect.x, y: rect.y };
}

/** Frame-local point -> sheet-absolute point. */
export function sheetPointOf(ctx: RuleContext, frame: number, x: number, y: number): Point {
  const origin = frameOriginOf(ctx, frame);
  return { x: origin.x + x, y: origin.y + y };
}

/** Frame-local rect -> sheet-absolute rect. */
export function sheetRegionOf(ctx: RuleContext, frame: number, rect: Region): Region {
  const origin = frameOriginOf(ctx, frame);
  return { x: origin.x + rect.x, y: origin.y + rect.y, width: rect.width, height: rect.height };
}

/** The whole cell as a sheet-absolute rect — handy as a fallback region. */
export function frameRegionOf(ctx: RuleContext, frame: number): Region {
  const origin = frameOriginOf(ctx, frame);
  return { x: origin.x, y: origin.y, width: ctx.frameWidth, height: ctx.frameHeight };
}

export interface ContentBounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Frame-local opaque content rect, or null when the frame is empty. */
export function contentBoundsOf(frame: ImageData): ContentBounds | null {
  return computeTrimRect(frame);
}

export function boundsToRegion(bounds: ContentBounds): Region {
  return { x: bounds.x, y: bounds.y, width: bounds.w, height: bounds.h };
}

/**
 * Content-anchored pivot for a frame, cell-relative — the same derivation the
 * `pivot` command uses for presets, but anchored to the content bounds instead
 * of the cell. Null when the frame has no content to anchor to.
 */
export function contentPivotOf(frame: ImageData, preset: PivotPresetId): Point | null {
  const bounds = contentBoundsOf(frame);
  if (!bounds) return null;
  const { nx, ny } = PIVOT_PRESETS[preset];
  return {
    x: bounds.x + Math.round(nx * (bounds.w - 1)),
    y: bounds.y + Math.round(ny * (bounds.h - 1)),
  };
}

// -----------------------------------------------------------------
// Pixel access
// -----------------------------------------------------------------

/** Byte offset of pixel (x, y) — the red channel; alpha is +3. */
export function pixelOffset(image: ImageData, x: number, y: number): number {
  return (y * image.width + x) * 4;
}

export function inBounds(image: ImageData, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < image.width && y < image.height;
}

export function alphaAt(image: ImageData, x: number, y: number): number {
  return image.data[pixelOffset(image, x, y) + 3];
}

export function isOpaqueAt(image: ImageData, x: number, y: number, alphaThreshold = 0): boolean {
  return alphaAt(image, x, y) > alphaThreshold;
}

export function isFullyTransparentAt(image: ImageData, x: number, y: number): boolean {
  return alphaAt(image, x, y) === 0;
}

export function opaquePixelCount(image: ImageData, alphaThreshold = 0): number {
  const d = image.data;
  let count = 0;
  for (let i = 3; i < d.length; i += 4) {
    if (d[i] > alphaThreshold) count++;
  }
  return count;
}

export function opaqueCoverage(image: ImageData, alphaThreshold = 0): number {
  const total = image.width * image.height;
  if (total === 0) return 0;
  return opaquePixelCount(image, alphaThreshold) / total;
}

export function isFrameEmpty(image: ImageData, alphaThreshold = 0): boolean {
  const d = image.data;
  for (let i = 3; i < d.length; i += 4) {
    if (d[i] > alphaThreshold) return false;
  }
  return true;
}

export function hasAnyTransparent(image: ImageData, alphaThreshold = 0): boolean {
  const d = image.data;
  for (let i = 3; i < d.length; i += 4) {
    if (d[i] <= alphaThreshold) return true;
  }
  return false;
}

/**
 * True when any pixel is partially transparent. Pixel art is almost always
 * strictly binary here, which is exactly what the alpha-fringe rule uses to
 * decide it has nothing to say.
 */
export function hasAnySemiTransparent(image: ImageData, opaqueAlpha = 255): boolean {
  const d = image.data;
  for (let i = 3; i < d.length; i += 4) {
    if (d[i] > 0 && d[i] < opaqueAlpha) return true;
  }
  return false;
}

export function isBinaryAlpha(image: ImageData): boolean {
  return !hasAnySemiTransparent(image);
}

/**
 * 4-neighbour test against fully transparent pixels. Out-of-bounds counts as
 * NOT transparent: a sprite that runs to the frame edge is the neighbouring
 * cell's business, not an edge for fringe purposes.
 */
export function hasTransparentNeighbor(image: ImageData, x: number, y: number): boolean {
  return (
    (inBounds(image, x - 1, y) && isFullyTransparentAt(image, x - 1, y)) ||
    (inBounds(image, x + 1, y) && isFullyTransparentAt(image, x + 1, y)) ||
    (inBounds(image, x, y - 1) && isFullyTransparentAt(image, x, y - 1)) ||
    (inBounds(image, x, y + 1) && isFullyTransparentAt(image, x, y + 1))
  );
}

/** Pixels with any alpha that sit next to a fully transparent pixel. */
export function countTransparentAdjacentPixels(image: ImageData): number {
  let count = 0;
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      if (alphaAt(image, x, y) === 0) continue;
      if (hasTransparentNeighbor(image, x, y)) count++;
    }
  }
  return count;
}

// -----------------------------------------------------------------
// Colour
// -----------------------------------------------------------------

/** RGB triple packed into a single int, for use as a Map key. */
export function packRgb(r: number, g: number, b: number): number {
  return (r << 16) | (g << 8) | b;
}

export function unpackRgb(packed: number): RGB {
  return { r: (packed >> 16) & 0xff, g: (packed >> 8) & 0xff, b: packed & 0xff };
}

/** Distinct opaque RGB triples and how many pixels each covers. */
export function distinctOpaqueColors(image: ImageData, alphaThreshold = 0): Map<number, number> {
  const counts = new Map<number, number>();
  const d = image.data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] <= alphaThreshold) continue;
    const key = packRgb(d[i], d[i + 1], d[i + 2]);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

export function colorDistance(
  r1: number,
  g1: number,
  b1: number,
  r2: number,
  g2: number,
  b2: number,
): number {
  return Math.sqrt(colorDistanceSq(r1, g1, b1, r2, g2, b2));
}

export function colorDistanceSq(
  r1: number,
  g1: number,
  b1: number,
  r2: number,
  g2: number,
  b2: number,
): number {
  const dr = r1 - r2;
  const dg = g1 - g2;
  const db = b1 - b2;
  return dr * dr + dg * dg + db * db;
}

/**
 * Mean distance from sampled opaque pixels to their nearest palette entry —
 * how much detail a quantization would actually lose. Null when there was
 * nothing to sample, which callers should treat as "cannot judge".
 */
export function meanNearestColorDistance(
  image: ImageData,
  palette: RGB[],
  sampleStride = 1,
): number | null {
  if (palette.length === 0) return null;
  const stride = Math.max(1, Math.floor(sampleStride));
  const d = image.data;
  let sum = 0;
  let samples = 0;
  let seen = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    if (seen++ % stride !== 0) continue;
    let best = Infinity;
    for (const p of palette) {
      const dist = colorDistanceSq(d[i], d[i + 1], d[i + 2], p.r, p.g, p.b);
      if (dist < best) best = dist;
    }
    sum += Math.sqrt(best);
    samples++;
  }
  return samples === 0 ? null : sum / samples;
}

// -----------------------------------------------------------------
// Boxes and numbers
// -----------------------------------------------------------------

/** Accumulates a bounding box over offending pixels as a rule finds them. */
export interface BoxAccumulator {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  count: number;
}

export function createBox(): BoxAccumulator {
  return { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity, count: 0 };
}

export function expandBox(box: BoxAccumulator, x: number, y: number): void {
  if (x < box.minX) box.minX = x;
  if (y < box.minY) box.minY = y;
  if (x > box.maxX) box.maxX = x;
  if (y > box.maxY) box.maxY = y;
  box.count++;
}

export function boxToRegion(box: BoxAccumulator): Region | null {
  if (box.count === 0) return null;
  return {
    x: box.minX,
    y: box.minY,
    width: box.maxX - box.minX + 1,
    height: box.maxY - box.minY + 1,
  };
}

export function isPowerOfTwo(n: number): boolean {
  return Number.isInteger(n) && n > 0 && (n & (n - 1)) === 0;
}

export function nextPowerOfTwo(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

/** Median of a numeric list — the even case averages the two middle values. */
export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

/** Round to `digits` decimals — keeps report JSON readable and stable. */
export function round(value: number, digits = 4): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}
