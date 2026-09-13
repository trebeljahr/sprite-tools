import type { Command } from "commander";
import {
  writeBinaryOutput,
  fail,
  parseIntArg,
  loadSheet,
  addHelpExtras,
  addGridOptions,
  gridPaddingFromOpts,
  type GridPaddingOpts,
} from "../lib/common";
import { imageToPngBuffer, stitchSheet } from "../lib/image-io";
import { pixelate, hexToRgb } from "../../src/lib/pixel-art/pixelate";
import { paletteById, PALETTES } from "../../src/lib/pixel-art/palettes";
import {
  upscale,
  upscaleNearestBy,
  UPSCALE_ALGORITHMS,
  type UpscaleAlgorithm,
} from "../../src/lib/pixel-art/upscale";

// Built from the shared table so the help text cannot drift from the implementation.
const ALGO_IDS = UPSCALE_ALGORITHMS.map((a) => a.id);
const ALGO_HELP = `upscale filter for --upscale-factor (${ALGO_IDS.join(" | ")})`;
const ALGO_NOTES = UPSCALE_ALGORITHMS.map(
  (a) => `  ${a.id.padEnd(8)} ${a.nativeFactor}x  ${a.description}`,
);

export function registerPixelateCommand(program: Command) {
  const cmd = program
    .command("pixelate <input>")
    .description(
      "Downscale + quantize + dither + palette-snap, or pixel-art upscale. Outputs a PNG.",
    )
    .option("--cols <n>", "sheet columns (default 1)", (v) => parseIntArg("cols", v))
    .option("--rows <n>", "sheet rows (default 1)", (v) => parseIntArg("rows", v))
    .option("--auto-grid", "auto-detect sheet grid", false)
    .option(
      "--pixel-size <n>",
      "source pixels per output pixel (1 = no downscale)",
      (v) => parseIntArg("pixel-size", v),
      4,
    )
    .option(
      "--colors <n>",
      "palette size (0 = no quantization)",
      (v) => parseIntArg("colors", v),
      16,
    )
    .option("--palette <id>", `preset palette id (${PALETTES.map((p) => p.id).join(", ")})`, "none")
    .option("--dither", "Floyd–Steinberg dither", false)
    .option(
      "--alpha-threshold <n>",
      "binarize alpha above/below this",
      (v) => parseIntArg("alpha-threshold", v),
      0,
    )
    .option("--no-upscale", "keep output at the downscaled size (default: upscale to source size)")
    .option("--upscale-algo <id>", ALGO_HELP, "nearest")
    .option(
      "--upscale-factor <n>",
      "explicit magnification after pixelating (1 = off; >1 replaces the restore-to-source upscale)",
      (v) => parseIntArg("upscale-factor", v),
      1,
    )
    .option("-o, --output <file>", "output PNG file (default: stdout, use - for explicit stdout)");

  addGridOptions(cmd);

  addHelpExtras(cmd, {
    examples: [
      "sprite-tools pixelate hero.png -o hero-pixel.png",
      "sprite-tools pixelate hero.png --pixel-size 4 --palette gameboy -o gb.png",
      "sprite-tools pixelate hero.png --colors 16 --dither -o fs.png",
      "sprite-tools pixelate sheet.png --cols 8 --rows 4 --no-upscale -o tiny.png",
      "# pure upscale of an already-pixel-art sprite (no downscale, no quantization):",
      "sprite-tools pixelate hero.png --pixel-size 1 --colors 0 --upscale-algo scale2x --upscale-factor 4 -o hero-4x.png",
      "sprite-tools pixelate sheet.png --cols 8 --rows 4 --pixel-size 1 --colors 0 --upscale-algo xbr --upscale-factor 2 -o sheet-2x.png",
    ],
    output: [
      "PNG. --upscale (default) keeps source dimensions with blocky pixels.",
      "--no-upscale emits native low-res (source/pixelSize on each axis).",
      "--upscale-factor <n> with n > 1 emits (source/pixelSize * n) on each axis and",
      "  REPLACES the implicit restore-to-source upscale, so nothing is magnified twice.",
      "  --no-upscale is then irrelevant. At n = 1 (the default) output is unchanged.",
      "--upscale-algo picks the filter for --upscale-factor. The algorithm's native",
      "  factor is applied as often as it divides n evenly, remainder is nearest:",
      "  scale2x @4 = two scale2x passes, scale2x @6 = one pass then nearest x3.",
      "  Every filter only copies source pixels, so no new colours are invented",
      "  and transparency survives exactly:",
      ...ALGO_NOTES,
    ],
  });

  cmd.action(
    (
      input: string,
      opts: {
        cols?: number;
        rows?: number;
        autoGrid: boolean;
        pixelSize: number;
        colors: number;
        palette: string;
        dither: boolean;
        alphaThreshold: number;
        upscale: boolean;
        upscaleAlgo: string;
        upscaleFactor: number;
        output?: string;
      } & GridPaddingOpts,
    ) => {
      try {
        if (!ALGO_IDS.includes(opts.upscaleAlgo as UpscaleAlgorithm)) {
          fail(`upscale-algo: expected one of ${ALGO_IDS.join(", ")}, got "${opts.upscaleAlgo}"`);
        }
        if (opts.upscaleFactor < 1) {
          fail(`upscale-factor: expected integer >= 1, got "${opts.upscaleFactor}"`);
        }
        const explicitUpscale = opts.upscaleFactor > 1;

        const { frames, grid } = loadSheet(
          input,
          opts.autoGrid || opts.cols !== undefined || opts.rows !== undefined ? opts.cols : 1,
          opts.autoGrid || opts.cols !== undefined || opts.rows !== undefined ? opts.rows : 1,
          gridPaddingFromOpts(opts),
        );
        const preset = paletteById(opts.palette);
        const palette = preset.colors.length > 0 ? preset.colors.map(hexToRgb) : undefined;

        const processed = frames.map((f) => {
          const small = pixelate(f, {
            pixelSize: opts.pixelSize,
            colorCount: opts.colors,
            palette,
            dither: opts.dither ? "floyd-steinberg" : "none",
            alphaThreshold: opts.alphaThreshold,
          });
          // An explicit --upscale-factor takes over from the implicit
          // restore-to-source-size step; applying both would magnify twice.
          if (explicitUpscale) {
            return upscale(small, {
              algorithm: opts.upscaleAlgo as UpscaleAlgorithm,
              scale: opts.upscaleFactor,
            });
          }
          if (!opts.upscale) return small;
          // Upscale nearest-neighbor back to original frame size.
          const scale = Math.max(1, Math.round(f.width / small.width));
          return upscaleNearestBy(small, scale);
        });

        const output =
          processed.length === 1 ? processed[0] : stitchSheet(processed, grid.cols, grid.rows);
        writeBinaryOutput(imageToPngBuffer(output), opts.output);
      } catch (e) {
        fail(e instanceof Error ? e.message : String(e));
      }
    },
  );
}
