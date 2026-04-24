import type { Command } from "commander";
import { writeBinaryOutput, fail, parseIntArg, loadSheet, addHelpExtras } from "../lib/common";
import { upscaleNearest } from "../lib/image-io";
import { GIFEncoder, applyPalette, quantize } from "gifenc";

export function registerGifCommand(program: Command) {
  const cmd = program
    .command("gif <input>")
    .description("Encode a sprite sheet animation as an animated GIF.")
    .option("--cols <n>", "sheet columns", (v) => parseIntArg("cols", v))
    .option("--rows <n>", "sheet rows", (v) => parseIntArg("rows", v))
    .option("--fps <n>", "frames per second", (v) => parseIntArg("fps", v), 10)
    .option("--scale <n>", "integer upscale factor", (v) => parseIntArg("scale", v), 1)
    .option(
      "--alpha-threshold <n>",
      "alpha cutoff for GIF transparency",
      (v) => parseIntArg("alpha-threshold", v),
      128,
    )
    .option("--reverse", "play frames in reverse order", false)
    .option("--pingpong", "forward then reverse", false)
    .option("-o, --output <file>", "output GIF file (default: stdout)");

  addHelpExtras(cmd, {
    examples: [
      "sprite-tools gif sheet.png -o anim.gif",
      "sprite-tools gif sheet.png --fps 24 --scale 2 --pingpong -o bounce.gif",
      "sprite-tools gif sheet.png --cols 8 --rows 1 --reverse -o rewind.gif",
    ],
    output: [
      "Animated GIF. Alpha binarized at --alpha-threshold since GIF has no",
      "partial transparency. Use --scale for nearest-neighbor pixel-art upscaling.",
    ],
  });

  cmd.action(
    (
      input: string,
      opts: {
        cols?: number;
        rows?: number;
        fps: number;
        scale: number;
        alphaThreshold: number;
        reverse: boolean;
        pingpong: boolean;
        output?: string;
      },
    ) => {
      try {
        const { frames } = loadSheet(input, opts.cols, opts.rows);
        if (frames.length === 0) fail("no frames found");

        // Build playback sequence.
        const fwd = frames.map((_, i) => i);
        const base = opts.reverse ? [...fwd].reverse() : fwd;
        const seq = opts.pingpong ? [...base, ...base.slice(1, -1).reverse()] : base;

        const scaled = frames.map((f) => (opts.scale > 1 ? upscaleNearest(f, opts.scale) : f));

        const W = scaled[0].width;
        const H = scaled[0].height;
        const delay = Math.max(20, Math.round(1000 / Math.max(1, opts.fps)));
        const enc = GIFEncoder();

        for (const i of seq) {
          const f = scaled[i];
          // Binarize alpha for GIF transparency.
          const d = new Uint8ClampedArray(f.data);
          for (let j = 3; j < d.length; j += 4) {
            d[j] = d[j] > opts.alphaThreshold ? 255 : 0;
          }
          const palette = quantize(d, 256, { format: "rgba4444" });
          const idx = applyPalette(d, palette, "rgba4444");
          const transparentIndex = findTransparentIndex(palette);
          enc.writeFrame(idx, W, H, {
            palette,
            delay,
            transparent: true,
            transparentIndex,
            dispose: 2,
          });
        }
        enc.finish();
        writeBinaryOutput(Buffer.from(enc.bytes()), opts.output);
      } catch (e) {
        fail(e instanceof Error ? e.message : String(e));
      }
    },
  );
}

function findTransparentIndex(palette: number[][]): number {
  for (let i = 0; i < palette.length; i++) {
    if (palette[i][3] === 0) return i;
  }
  return 0;
}
