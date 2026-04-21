// Shared CLI helpers: JSON output dispatch, error handling, grid resolution.

import { writeFileSync } from "node:fs";
import { basename } from "node:path";
import type { Command } from "commander";
import { loadPng } from "./image-io";
import { detectGridFromImageData } from "../../src/lib/pipeline/detect";

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
    cmd.addHelpText("after", "\n" + sections.join("\n") + "\n");
  }
  return cmd;
}

export function writeJsonOutput(json: unknown, outPath?: string): void {
  const text = JSON.stringify(json, null, 2);
  if (!outPath || outPath === "-") {
    process.stdout.write(text + "\n");
  } else {
    writeFileSync(outPath, text + "\n");
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

export interface ResolvedGrid {
  cols: number;
  rows: number;
  detected: boolean;
  confidence?: number;
}

/**
 * Resolve the final (cols, rows) for a sheet. If the caller supplied both,
 * use them. Otherwise run auto-detect and fill in missing values.
 */
export function resolveGrid(
  image: ImageData,
  explicitCols?: number,
  explicitRows?: number,
): ResolvedGrid {
  if (explicitCols && explicitRows) {
    return { cols: explicitCols, rows: explicitRows, detected: false };
  }
  const det = detectGridFromImageData(image);
  return {
    cols: explicitCols ?? det.cols,
    rows: explicitRows ?? det.rows,
    detected: true,
    confidence: det.confidence,
  };
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
): { image: ImageData; grid: ResolvedGrid; frames: ImageData[] } {
  const image = loadPng(path);
  const grid = resolveGrid(image, cols, rows);
  const frames = sliceSheetImpl(image, grid.cols, grid.rows);
  return { image, grid, frames };
}

function sliceSheetImpl(img: ImageData, cols: number, rows: number): ImageData[] {
  if (cols <= 0 || rows <= 0) return [img];
  if (cols === 1 && rows === 1) return [img];
  // Delegate to image-io.sliceSheet.
  // (Inlined import to avoid a cyclic module reference if it ever grows.)
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { sliceSheet } = require("./image-io");
  return sliceSheet(img, cols, rows);
}
