import { readFileSync } from "node:fs";
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
import { upscaleNearest } from "../lib/image-io";
import { GIFEncoder, applyPalette, quantize } from "gifenc";
import {
  applyDurationSpecs,
  type FrameDurations,
  normalizeFrameDurations,
  quantizeGifDelayMs,
  resolveSequenceDurationsMs,
} from "../../src/lib/animation/durations";

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
    .option("--duration <spec>", 'repeatable: "index=ms" or "from-to=ms"', collect, [])
    .option("--tags-json <file>", "read frameDurations from a `sprite-tools tags` document")
    .option("-o, --output <file>", "output GIF file (default: stdout)");

  addGridOptions(cmd);

  addHelpExtras(cmd, {
    examples: [
      "sprite-tools gif sheet.png -o anim.gif",
      "sprite-tools gif sheet.png --fps 24 --scale 2 --pingpong -o bounce.gif",
      "sprite-tools gif sheet.png --cols 8 --rows 1 --reverse -o rewind.gif",
      "",
      "# hold frame 0 for 250ms; every other frame stays at --fps",
      "sprite-tools gif sheet.png --duration 0=250 -o idle.gif",
      "# reuse holds already authored with `sprite-tools tags --duration`",
      "sprite-tools gif sheet.png --tags-json hero-tags.json -o idle.gif",
      "# --duration wins per frame over the values in --tags-json",
      "sprite-tools gif sheet.png --tags-json hero-tags.json --duration 2-4=60 -o fast.gif",
    ],
    output: [
      "Animated GIF. Alpha binarized at --alpha-threshold since GIF has no",
      "partial transparency. Use --scale for nearest-neighbor pixel-art upscaling.",
      "",
      "GIF stores frame delays in 10ms units, so every duration is rounded to",
      "the nearest 10ms and floored at 20ms (browsers stretch anything shorter",
      "to 100ms). A 125ms hold is written as 130ms; a 5ms hold as 20ms.",
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
        duration: string[];
        tagsJson?: string;
        output?: string;
      } & GridPaddingOpts,
    ) => {
      try {
        const { frames } = loadSheet(input, opts.cols, opts.rows, gridPaddingFromOpts(opts));
        if (frames.length === 0) fail("no frames found");

        // Build playback sequence.
        const fwd = frames.map((_, i) => i);
        const base = opts.reverse ? [...fwd].reverse() : fwd;
        const seq = opts.pingpong ? [...base, ...base.slice(1, -1).reverse()] : base;

        const scaled = frames.map((f) => (opts.scale > 1 ? upscaleNearest(f, opts.scale) : f));

        const W = scaled[0].width;
        const H = scaled[0].height;

        // Per-frame holds: the tags document supplies the baseline, --duration
        // overrides it frame by frame, and anything still null falls back to
        // --fps. With neither flag every delay is round(1000 / fps) quantized
        // to 10ms, which writes the same centisecond count into the Graphic
        // Control Extension as the old uniform `Math.max(20, round(1000/fps))`
        // — so a durationless encode is byte-identical to the previous one.
        const fileDurations = readTagsJsonDurations(opts.tagsJson, frames.length);
        const frameDurations =
          opts.duration.length > 0
            ? applyDurationSpecs(opts.duration, frames.length, fileDurations)
            : fileDurations;
        const delays = resolveSequenceDurationsMs(seq, frameDurations, opts.fps).map(
          quantizeGifDelayMs,
        );

        const enc = GIFEncoder();

        for (let s = 0; s < seq.length; s++) {
          const i = seq[s];
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
            delay: delays[s],
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

function collect(v: string, prev: string[]): string[] {
  return [...prev, v];
}

/**
 * Pull `frameDurations` out of a `sprite-tools tags` (or `meta`) document and
 * fit it to this sheet. Missing file, unreadable file and malformed JSON are
 * hard errors; a document that simply carries no durations is not.
 */
function readTagsJsonDurations(
  path: string | undefined,
  frameCount: number,
): FrameDurations | undefined {
  if (!path) return undefined;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    throw new Error(`--tags-json: cannot read "${path}" (${e instanceof Error ? e.message : e})`);
  }
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    throw new Error(
      `--tags-json: "${path}" is not valid JSON (${e instanceof Error ? e.message : e})`,
    );
  }
  const raw = typeof doc === "object" && doc !== null ? (doc as Record<string, unknown>) : {};
  return normalizeFrameDurations(raw.frameDurations, frameCount);
}

function findTransparentIndex(palette: number[][]): number {
  for (let i = 0; i < palette.length; i++) {
    if (palette[i][3] === 0) return i;
  }
  return 0;
}
