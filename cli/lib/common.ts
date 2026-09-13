// Shared CLI helpers: JSON output dispatch, error handling, grid resolution.

import { writeFileSync } from "node:fs";
import { basename } from "node:path";
import type { Command } from "commander";
import { loadPng } from "./image-io";
import { detectGridFromImageData } from "../../src/lib/pipeline/detect";
import {
  computeCellGeometry,
  GridFitError,
  isZeroPadding,
  normalizeGridPadding,
  type GridMargin,
  type GridPadding,
  type GridPaddingInput,
  type GridSpacing,
} from "../../src/lib/pipeline/grid";

/**
 * Append an "Examples" block and optional "Output" block to a subcommand's
 * --help. Keeps examples discoverable right next to the option list, which
 * is the main thing a cold-context agent reads.
 */
export function addHelpExtras(
  cmd: Command,
  opts: { examples?: string[]; output?: string[] },
): Command {
  const sections: string[] = [];
  if (opts.examples && opts.examples.length > 0) {
    sections.push("Examples:");
    for (const e of opts.examples) sections.push(`  ${e}`);
  }
  if (opts.output && opts.output.length > 0) {
    if (sections.length > 0) sections.push("");
    sections.push("Output shape:");
    for (const o of opts.output) sections.push(`  ${o}`);
  }
  if (sections.length > 0) {
    cmd.addHelpText("after", `\n${sections.join("\n")}\n`);
  }
  return cmd;
}

export function writeJsonOutput(json: unknown, outPath?: string): void {
  const text = JSON.stringify(json, null, 2);
  if (!outPath || outPath === "-") {
    process.stdout.write(`${text}\n`);
  } else {
    writeFileSync(outPath, `${text}\n`);
  }
}

export function writeBinaryOutput(buf: Buffer | Uint8Array, outPath?: string): void {
  if (!outPath || outPath === "-") {
    process.stdout.write(buf);
  } else {
    writeFileSync(outPath, buf);
  }
}

export function fail(msg: string, code = 1): never {
  process.stderr.write(`sprite-tools: ${msg}\n`);
  process.exit(code);
}

export function parseIntArg(name: string, v: string): number {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) fail(`${name}: expected integer, got "${v}"`);
  return n;
}

export function parseFloatArg(name: string, v: string): number {
  const n = parseFloat(v);
  if (!Number.isFinite(n)) fail(`${name}: expected number, got "${v}"`);
  return n;
}

/** The six padding flags as commander hands them back. */
export interface GridPaddingOpts {
  margin?: number;
  marginX?: number;
  marginY?: number;
  spacing?: number;
  spacingX?: number;
  spacingY?: number;
}

/** Pixel counts: integers, never negative. */
export function parsePixelArg(name: string, v: string): number {
  const n = parseIntArg(name, v);
  if (n < 0) fail(`${name}: must be 0 or more pixels, got ${n}`);
  return n;
}

/**
 * Register the margin/spacing flags. Declared once here so all nine grid
 * commands stay in sync — the flags are worthless if they mean different
 * things in `slice` and in `collision`.
 */
export function addGridOptions(cmd: Command): Command {
  return cmd
    .option("--margin <n>", "border around the whole sheet, px", (v) => parsePixelArg("margin", v))
    .option("--margin-x <n>", "left+right border, px (beats --margin)", (v) =>
      parsePixelArg("margin-x", v),
    )
    .option("--margin-y <n>", "top+bottom border, px (beats --margin)", (v) =>
      parsePixelArg("margin-y", v),
    )
    .option("--spacing <n>", "gutter between cells, px", (v) => parsePixelArg("spacing", v))
    .option("--spacing-x <n>", "horizontal gutter, px (beats --spacing)", (v) =>
      parsePixelArg("spacing-x", v),
    )
    .option("--spacing-y <n>", "vertical gutter, px (beats --spacing)", (v) =>
      parsePixelArg("spacing-y", v),
    );
}

/** Fold the parsed flags into a GridPaddingInput, or undefined if none were given. */
export function gridPaddingFromOpts(o: GridPaddingOpts): GridPaddingInput | undefined {
  const { margin, marginX, marginY, spacing, spacingX, spacingY } = o;
  if (
    margin === undefined &&
    marginX === undefined &&
    marginY === undefined &&
    spacing === undefined &&
    spacingX === undefined &&
    spacingY === undefined
  ) {
    return undefined;
  }
  return { margin, marginX, marginY, spacing, spacingX, spacingY };
}

export interface ResolvedGrid {
  cols: number;
  rows: number;
  detected: boolean;
  confidence?: number;
  /** Always present; all zeros for a flush sheet. */
  margin: GridMargin;
  spacing: GridSpacing;
}

/** Which padding fields the caller actually stated, so detection fills only the rest. */
function statedFields(input?: GridPaddingInput | null) {
  const m = input?.margin;
  const mSides = typeof m === "object" && m !== null ? m : undefined;
  const mAll = typeof m === "number";
  const s = input?.spacing;
  const sAxes = typeof s === "object" && s !== null ? s : undefined;
  const sAll = typeof s === "number";
  const side = (k: keyof GridMargin, axis: number | undefined) =>
    mSides?.[k] !== undefined || axis !== undefined || mAll;
  const gap = (k: keyof GridSpacing, axis: number | undefined) =>
    sAxes?.[k] !== undefined || axis !== undefined || sAll;
  return {
    left: side("left", input?.marginX),
    right: side("right", input?.marginX),
    top: side("top", input?.marginY),
    bottom: side("bottom", input?.marginY),
    x: gap("x", input?.spacingX),
    y: gap("y", input?.spacingY),
  };
}

/**
 * Resolve the final grid for a sheet. If the caller supplied both cols and
 * rows, use them. Otherwise run auto-detect and fill in missing values —
 * margin/spacing included, per field, with anything the caller stated winning.
 *
 * Detected padding is a hint, not an assertion: if it does not tile the sheet
 * we drop it rather than fail, so a sheet that slices today keeps slicing. A
 * padding the user typed is an assertion and its GridFitError propagates.
 */
export function resolveGrid(
  image: ImageData,
  explicitCols?: number,
  explicitRows?: number,
  padding?: GridPaddingInput | null,
): ResolvedGrid {
  const stated = normalizeGridPadding(padding);
  if (explicitCols && explicitRows) {
    return {
      cols: explicitCols,
      rows: explicitRows,
      detected: false,
      margin: stated.margin,
      spacing: stated.spacing,
    };
  }
  const det = detectGridFromImageData(image);
  const cols = explicitCols ?? det.cols;
  const rows = explicitRows ?? det.rows;
  const has = statedFields(padding);
  const merged: GridPadding = {
    margin: {
      left: has.left ? stated.margin.left : det.margin.left,
      right: has.right ? stated.margin.right : det.margin.right,
      top: has.top ? stated.margin.top : det.margin.top,
      bottom: has.bottom ? stated.margin.bottom : det.margin.bottom,
    },
    spacing: {
      x: has.x ? stated.spacing.x : det.spacing.x,
      y: has.y ? stated.spacing.y : det.spacing.y,
    },
  };
  const usable = isZeroPadding(merged) || fits(image, cols, rows, merged) ? merged : stated;
  return {
    cols,
    rows,
    detected: true,
    confidence: det.confidence,
    margin: usable.margin,
    spacing: usable.spacing,
  };
}

function fits(image: ImageData, cols: number, rows: number, padding: GridPadding): boolean {
  try {
    computeCellGeometry(image.width, image.height, cols, rows, padding);
    return true;
  } catch (e) {
    if (e instanceof GridFitError) return false;
    throw e;
  }
}

export function baseName(path: string): string {
  return basename(path).replace(/\.[^.]+$/, "");
}

/**
 * Load a PNG and optionally auto-detect its grid. Returns the image, the
 * resolved grid, and the frames. Most CLI commands need exactly this combo.
 */
export function loadSheet(
  path: string,
  cols?: number,
  rows?: number,
  padding?: GridPaddingInput | null,
): { image: ImageData; grid: ResolvedGrid; frames: ImageData[] } {
  return sheetFromImage(loadPng(path), cols, rows, padding);
}

/**
 * loadSheet for pixels already in memory (a .9.png with its marker border
 * stripped, say). Resolving and slicing happen together so the grid a caller
 * reports is always the geometry the frames were actually cut with.
 */
export function sheetFromImage(
  image: ImageData,
  cols?: number,
  rows?: number,
  padding?: GridPaddingInput | null,
): { image: ImageData; grid: ResolvedGrid; frames: ImageData[] } {
  const grid = resolveGrid(image, cols, rows, padding);
  const frames = sliceSheetImpl(image, grid.cols, grid.rows, {
    margin: grid.margin,
    spacing: grid.spacing,
  });
  return { image, grid, frames };
}

function sliceSheetImpl(
  img: ImageData,
  cols: number,
  rows: number,
  padding: GridPadding,
): ImageData[] {
  if (cols <= 0 || rows <= 0) return [img];
  // A 1×1 padded sheet still has a border to crop off, so only the flush case
  // can take the whole-image shortcut.
  if (cols === 1 && rows === 1 && isZeroPadding(padding)) return [img];
  // Delegate to image-io.sliceSheet.
  // (Inlined import to avoid a cyclic module reference if it ever grows.)
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { sliceSheet } = require("./image-io");
  return sliceSheet(img, cols, rows, padding);
}
