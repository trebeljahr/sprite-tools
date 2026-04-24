import type { Command } from "commander";
import {
  writeJsonOutput,
  writeBinaryOutput,
  fail,
  parseIntArg,
  loadSheet,
  addHelpExtras,
} from "../lib/common";
import { imageToPngBuffer, stitchSheet } from "../lib/image-io";
import {
  applyPaletteSwap,
  extractPalette,
  rgbToHex,
  hexToRgb,
} from "../../src/lib/palette/extract";
import type { RGB } from "../../src/lib/pixel-art/pixelate";

export function registerPaletteCommand(program: Command) {
  const cmd = program
    .command("palette <input>")
    .description("Extract dominant colors and optionally recolor via swaps.")
    .option("--cols <n>", "sheet columns", (v) => parseIntArg("cols", v))
    .option("--rows <n>", "sheet rows", (v) => parseIntArg("rows", v))
    .option("--colors <n>", "palette size", (v) => parseIntArg("colors", v), 8)
    .option(
      "--swap <from>=<to>",
      'repeatable: hex=hex swap, e.g. "#ff0000=#0000ff"',
      collectSwap,
      [],
    )
    .option("--image <file>", "write recolored sheet PNG here (in addition to JSON)")
    .option("-o, --output <file>", "output JSON file (default: stdout)");

  addHelpExtras(cmd, {
    examples: [
      "sprite-tools palette hero.png --colors 12",
      'sprite-tools palette hero.png --swap "#ff0000=#0000ff" --image hero-blue.png',
      "# extract once, reuse the palette:",
      "sprite-tools palette hero.png | jq -r '.palette[]'",
    ],
    output: [
      "{ source, frameWidth, frameHeight, grid, options,",
      "  palette: ['#rrggbb', ...],",
      "  swaps: [{ from: '#rrggbb', to: '#rrggbb' }, ...] }",
    ],
  });

  cmd.action(
    (
      input: string,
      opts: {
        cols?: number;
        rows?: number;
        colors: number;
        swap: string[];
        image?: string;
        output?: string;
      },
    ) => {
      try {
        const { frames, grid } = loadSheet(input, opts.cols, opts.rows);

        // Build a merged ImageData over ALL frames to extract a shared palette.
        const total = frames.reduce((n, f) => n + f.width * f.height, 0);
        const merged = new ImageData(total, 1);
        let off = 0;
        for (const f of frames) {
          merged.data.set(f.data, off);
          off += f.data.length;
        }
        const palette = extractPalette(merged, opts.colors);
        const paletteHex = palette.map(rgbToHex);

        // Parse swaps.
        const swapMap = new Map<string, string>();
        for (const s of opts.swap) {
          const m = /^(#?[0-9a-f]{6})\s*=\s*(#?[0-9a-f]{6})$/i.exec(s.trim());
          if (!m) fail(`invalid --swap "${s}" (expected "#rrggbb=#rrggbb")`);
          swapMap.set(normalizeHex(m![1]), normalizeHex(m![2]));
        }
        const swaps = palette
          .map((p) => {
            const key = rgbToHex(p).toLowerCase();
            const to = swapMap.get(key);
            if (!to) return null;
            return { from: p, to: hexToRgb(to) };
          })
          .filter((s): s is { from: RGB; to: RGB } => s !== null);

        // Optional: write a recolored sheet.
        if (opts.image && swaps.length > 0) {
          const recolored = frames.map((f) => applyPaletteSwap(f, palette, swaps));
          const out =
            recolored.length === 1 ? recolored[0] : stitchSheet(recolored, grid.cols, grid.rows);
          writeBinaryOutput(imageToPngBuffer(out), opts.image);
        }

        writeJsonOutput(
          {
            source: input,
            frameWidth: frames[0]?.width ?? 0,
            frameHeight: frames[0]?.height ?? 0,
            grid: { cols: grid.cols, rows: grid.rows, detected: grid.detected },
            options: { colors: opts.colors },
            palette: paletteHex,
            swaps: swaps.map((s) => ({ from: rgbToHex(s.from), to: rgbToHex(s.to) })),
          },
          opts.output,
        );
      } catch (e) {
        fail(e instanceof Error ? e.message : String(e));
      }
    },
  );
}

function collectSwap(value: string, prev: string[]): string[] {
  return [...prev, value];
}

function normalizeHex(s: string): string {
  return (s.startsWith("#") ? s : `#${s}`).toLowerCase();
}
