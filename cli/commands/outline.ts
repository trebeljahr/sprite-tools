// Outline + drop shadow. Both effects come off the same alpha pass in
// src/lib/outline/outline-fx.ts, so they share one command rather than two.
//
// Sheets: the margin is computed ONCE from the options (requiredMargin depends
// only on the options, never on the pixels) and handed to every frame, so all
// cells grow identically and the stitched sheet keeps a uniform cell size.

import type { Command } from "commander";
import {
  addGridOptions,
  addHelpExtras,
  fail,
  gridPaddingFromOpts,
  type GridPaddingOpts,
  loadSheet,
  parseFloatArg,
  parseIntArg,
  writeBinaryOutput,
  writeJsonOutput,
} from "../lib/common";
import { imageToPngBuffer, stitchSheet } from "../lib/image-io";
import {
  applyOutlineFx,
  requiredMargin,
  type Connectivity,
  type OutlineFxConfig,
  type OutlineStyle,
  type OverflowMode,
} from "../../src/lib/outline/outline-fx";

interface OutlineCommandOptions extends GridPaddingOpts {
  cols?: number;
  rows?: number;
  style: string;
  width: number;
  color: string;
  opacity: number;
  connectivity: number;
  alphaThreshold: number;
  overflow: string;
  outline: boolean;
  shadow: boolean;
  shadowOffset: string;
  shadowColor: string;
  shadowOpacity: number;
  shadowBlur: number;
  json?: string;
  output?: string;
}

export function registerOutlineCommand(program: Command) {
  const cmd = program
    .command("outline <input>")
    .description("Add an outer/inner outline and/or a drop shadow. Outputs a PNG.")
    .option("--cols <n>", "sheet columns (auto-detect when omitted)", (v) => parseIntArg("cols", v))
    .option("--rows <n>", "sheet rows (auto-detect when omitted)", (v) => parseIntArg("rows", v))
    .option("--style <mode>", "outer | inner", "outer")
    .option("--width <n>", "outline thickness in px", (v) => parseIntArg("width", v), 1)
    .option("--color <hex>", "outline colour", "#000000")
    .option("--opacity <n>", "outline opacity 0..1", (v) => parseFloatArg("opacity", v), 1)
    .option(
      "--connectivity <n>",
      "4 = mitred corners, 8 = square corners",
      (v) => parseIntArg("connectivity", v),
      8,
    )
    .option(
      "--alpha-threshold <n>",
      "a pixel counts as sprite when alpha > this (0-255)",
      (v) => parseIntArg("alpha-threshold", v),
      8,
    )
    .option("--overflow <mode>", "expand | clip", "expand")
    .option("--no-outline", "skip the outline (shadow only)")
    .option("--shadow", "enable the drop shadow", false)
    .option("--shadow-offset <x,y>", "shadow offset in px", "2,2")
    .option("--shadow-color <hex>", "shadow colour", "#000000")
    .option(
      "--shadow-opacity <n>",
      "shadow opacity 0..1",
      (v) => parseFloatArg("shadow-opacity", v),
      0.5,
    )
    .option(
      "--shadow-blur <n>",
      "shadow box-blur radius in px",
      (v) => parseIntArg("shadow-blur", v),
      0,
    )
    .option("--json <file>", "also write metadata JSON here")
    .option("-o, --output <file>", "output PNG file (default: stdout, use - for explicit stdout)");

  addGridOptions(cmd);

  addHelpExtras(cmd, {
    examples: [
      "sprite-tools outline hero.png -o hero-outlined.png",
      "sprite-tools outline hero.png --width 2 --color '#ffffff' -o hero-outlined.png",
      "sprite-tools outline hero.png --style inner --width 1 -o hero-inner.png",
      "sprite-tools outline hero.png --connectivity 4 --width 2 -o hero-mitred.png",
      "sprite-tools outline hero.png --shadow --shadow-offset 3,3 --shadow-blur 2 -o hero-drop.png",
      "sprite-tools outline hero.png --no-outline --shadow -o hero-shadow-only.png",
      "sprite-tools outline sheet.png --cols 8 --rows 4 --overflow clip -o sheet-outlined.png",
    ],
    output: [
      "PNG. --overflow expand (default) grows every frame by the required",
      "margin so nothing is cropped; --overflow clip keeps the source cell",
      "size and lets the effect run off the edge.",
      "--json: { source, sourceWidth, sourceHeight, grid:{cols,rows,margin,spacing},",
      "          frameWidth, frameHeight, outputWidth, outputHeight,",
      "          margin:{left,top,right,bottom}, options:{...} }",
    ],
  });

  cmd.action((input: string, opts: OutlineCommandOptions) => {
    try {
      const cfg = buildConfig(opts);

      const { image, grid, frames } = loadSheet(
        input,
        opts.cols,
        opts.rows,
        gridPaddingFromOpts(opts),
      );
      if (frames.length === 0) fail("no frames — check --cols / --rows");

      // One margin for every frame keeps the stitched sheet's cells uniform.
      const margin = requiredMargin(cfg);
      const processed = frames.map((f) => {
        const res = applyOutlineFx(f, { ...cfg, margin });
        // Copy into a real ImageData so stitchSheet / imageToPngBuffer see the
        // shape they expect; OutlineFxResult is deliberately DOM-free.
        const frame = new ImageData(res.width, res.height);
        frame.data.set(res.data);
        return frame;
      });

      const output =
        processed.length === 1 ? processed[0] : stitchSheet(processed, grid.cols, grid.rows);
      writeBinaryOutput(imageToPngBuffer(output), opts.output);

      if (opts.json) {
        const applied = cfg.overflow === "clip" ? ZERO_MARGIN : margin;
        writeJsonOutput(
          {
            source: input,
            sourceWidth: image.width,
            sourceHeight: image.height,
            grid: { cols: grid.cols, rows: grid.rows, margin: grid.margin, spacing: grid.spacing },
            frameWidth: frames[0].width,
            frameHeight: frames[0].height,
            outputWidth: output.width,
            outputHeight: output.height,
            margin: applied,
            options: {
              outline: cfg.outline ?? null,
              shadow: cfg.shadow ?? null,
              overflow: cfg.overflow,
            },
          },
          opts.json,
        );
      }
    } catch (e) {
      fail(e instanceof Error ? e.message : String(e));
    }
  });
}

const ZERO_MARGIN = { left: 0, top: 0, right: 0, bottom: 0 };

/** Validate the flags up front so bad input fails loudly instead of silently
 *  falling back to a default inside the core module. */
function buildConfig(opts: OutlineCommandOptions): OutlineFxConfig {
  if (opts.style !== "outer" && opts.style !== "inner") {
    fail(`--style must be one of outer | inner, got "${opts.style}"`);
  }
  if (opts.overflow !== "expand" && opts.overflow !== "clip") {
    fail(`--overflow must be one of expand | clip, got "${opts.overflow}"`);
  }
  if (opts.connectivity !== 4 && opts.connectivity !== 8) {
    fail(`--connectivity must be 4 or 8, got "${opts.connectivity}"`);
  }
  if (opts.width < 0) fail(`--width must be >= 0, got "${opts.width}"`);
  if (opts.shadowBlur < 0) fail(`--shadow-blur must be >= 0, got "${opts.shadowBlur}"`);
  if (opts.alphaThreshold < 0 || opts.alphaThreshold > 255) {
    fail(`--alpha-threshold must be 0..255, got "${opts.alphaThreshold}"`);
  }
  checkUnit("--opacity", opts.opacity);
  checkUnit("--shadow-opacity", opts.shadowOpacity);

  if (!opts.outline && !opts.shadow) {
    fail("--no-outline with no --shadow leaves nothing to draw");
  }

  const { x, y } = parseOffsetArg(opts.shadowOffset);

  return {
    outline: opts.outline
      ? {
          style: opts.style as OutlineStyle,
          width: opts.width,
          color: parseHexArg("--color", opts.color),
          opacity: opts.opacity,
          connectivity: opts.connectivity as Connectivity,
          alphaThreshold: opts.alphaThreshold,
        }
      : null,
    shadow: opts.shadow
      ? {
          offsetX: x,
          offsetY: y,
          color: parseHexArg("--shadow-color", opts.shadowColor),
          opacity: opts.shadowOpacity,
          blur: opts.shadowBlur,
          alphaThreshold: opts.alphaThreshold,
        }
      : null,
    overflow: opts.overflow as OverflowMode,
  };
}

function checkUnit(name: string, v: number): void {
  if (v < 0 || v > 1) fail(`${name} must be 0..1, got "${v}"`);
}

/** outline-fx's hexToRgb falls back to black on garbage, which would look like
 *  a successful run — so reject it here instead. */
function parseHexArg(name: string, v: string): string {
  if (!/^#?([a-f\d]{3}|[a-f\d]{6})$/i.test(v)) {
    fail(`${name}: expected a #rgb or #rrggbb hex colour, got "${v}"`);
  }
  return v;
}

function parseOffsetArg(v: string): { x: number; y: number } {
  const parts = v.split(",").map((p) => p.trim());
  if (parts.length !== 2) fail(`--shadow-offset: expected "x,y", got "${v}"`);
  const x = Number(parts[0]);
  const y = Number(parts[1]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    fail(`--shadow-offset: expected two numbers, got "${v}"`);
  }
  return { x: Math.round(x), y: Math.round(y) };
}
