import type { Command } from "commander";
import { writeBinaryOutput, fail, parseIntArg, loadSheet, addHelpExtras } from "../lib/common";
import { imageToPngBuffer, stitchSheet } from "../lib/image-io";
import { pixelate, hexToRgb } from "../../src/lib/pixel-art/pixelate";
import { paletteById, PALETTES } from "../../src/lib/pixel-art/palettes";

export function registerPixelateCommand(program: Command) {
  const cmd = program
    .command("pixelate <input>")
    .description("Downscale + quantize + dither + palette-snap. Outputs a PNG.")
    .option("--cols <n>", "sheet columns (default 1)", (v) => parseIntArg("cols", v))
    .option("--rows <n>", "sheet rows (default 1)", (v) => parseIntArg("rows", v))
    .option("--auto-grid", "auto-detect sheet grid", false)
    .option(
      "--pixel-size <n>",
      "source pixels per output pixel",
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
    .option("-o, --output <file>", "output PNG file (default: stdout, use - for explicit stdout)");

  addHelpExtras(cmd, {
    examples: [
      "sprite-tools pixelate hero.png -o hero-pixel.png",
      "sprite-tools pixelate hero.png --pixel-size 4 --palette gameboy -o gb.png",
      "sprite-tools pixelate hero.png --colors 16 --dither -o fs.png",
      "sprite-tools pixelate sheet.png --cols 8 --rows 4 --no-upscale -o tiny.png",
    ],
    output: [
      "PNG. --upscale (default) keeps source dimensions with blocky pixels.",
      "--no-upscale emits native low-res (source/pixelSize on each axis).",
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
        output?: string;
      },
    ) => {
      try {
        const { frames, grid } = loadSheet(
          input,
          opts.autoGrid || opts.cols !== undefined || opts.rows !== undefined ? opts.cols : 1,
          opts.autoGrid || opts.cols !== undefined || opts.rows !== undefined ? opts.rows : 1,
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
          if (!opts.upscale) return small;
          // Upscale nearest-neighbor back to original frame size.
          const scale = Math.max(1, Math.round(f.width / small.width));
          return upscaleNearest(small, scale);
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

function upscaleNearest(img: ImageData, f: number): ImageData {
  if (f <= 1) return img;
  const out = new ImageData(img.width * f, img.height * f);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const si = (y * img.width + x) * 4;
      const r = img.data[si];
      const g = img.data[si + 1];
      const b = img.data[si + 2];
      const a = img.data[si + 3];
      for (let dy = 0; dy < f; dy++) {
        for (let dx = 0; dx < f; dx++) {
          const di = ((y * f + dy) * out.width + x * f + dx) * 4;
          out.data[di] = r;
          out.data[di + 1] = g;
          out.data[di + 2] = b;
          out.data[di + 3] = a;
        }
      }
    }
  }
  return out;
}
