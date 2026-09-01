import type { Command } from "commander";
import { writeBinaryOutput, fail, parseIntArg, addHelpExtras } from "../lib/common";
import { loadPng, imageToPngBuffer } from "../lib/image-io";
import {
  applyChromaKeyToImageData,
  applySolidFillToImageData,
  detectBackgroundColor,
  hexToRgb,
  type ChromaCoreConfig,
} from "../../src/lib/pipeline/chroma-core";
import { computeTrimRect } from "../../src/lib/atlas/pack";

export function registerChromaCommand(program: Command) {
  const cmd = program
    .command("chroma <input>")
    .alias("remove-bg")
    .description("Chroma-key background removal. Outputs a PNG.")
    .option("--mode <mode>", "transparent | solid", "transparent")
    .option(
      "--similarity <n>",
      "colour distance treated as pure background",
      (v) => parseIntArg("similarity", v),
      30,
    )
    .option(
      "--softness <n>",
      "width of the partial-alpha falloff band",
      (v) => parseIntArg("softness", v),
      10,
    )
    .option(
      "--spill <n>",
      "desaturate background bleed this far past the edge",
      (v) => parseIntArg("spill", v),
      20,
    )
    .option("--choke <n>", "erode the matte by n pixels", (v) => parseIntArg("choke", v), 1)
    .option("--color <hex>", "background colour to key out (default: auto-detect from corners)")
    .option("--fill <hex>", "fill colour for --mode solid (default: auto-sample corners)")
    .option("--trim", "auto-crop the transparent border afterwards", false)
    .option("-o, --output <file>", "output PNG file (default: stdout, use - for explicit stdout)");

  addHelpExtras(cmd, {
    examples: [
      "sprite-tools chroma hero.png -o hero-cut.png",
      "sprite-tools chroma hero.png --color '#00ff00' --similarity 60 -o hero-cut.png",
      "sprite-tools chroma hero.png --softness 20 --spill 30 --choke 2 --trim -o hero-cut.png",
      "sprite-tools chroma hero.png --mode solid --fill '#ffffff' -o hero-white.png",
      "# pipe in and out:",
      "cat hero.png | sprite-tools remove-bg - -o - | sprite-tools collision -",
    ],
    output: [
      "PNG at source dimensions (smaller when --trim crops the border).",
      "  transparent mode — background alpha goes to 0, edges feathered by",
      "                     --softness and eroded by --choke.",
      "  solid mode      — output is fully opaque; background is replaced by",
      "                     --fill, or by an interpolated corner gradient.",
    ],
  });

  cmd.action(
    (
      input: string,
      opts: {
        mode: string;
        similarity: number;
        softness: number;
        spill: number;
        choke: number;
        color?: string;
        fill?: string;
        trim: boolean;
        output?: string;
      },
    ) => {
      try {
        if (opts.mode !== "transparent" && opts.mode !== "solid") {
          fail(`mode: expected "transparent" or "solid", got "${opts.mode}"`);
        }

        const img = loadPng(input);
        const config: ChromaCoreConfig = {
          mode: opts.mode === "solid" ? "chroma-solid" : "chroma-transparent",
          similarity: opts.similarity,
          softness: opts.softness,
          spill: opts.spill,
          choke: opts.choke,
          solidColor: opts.fill ? parseHexArg("fill", opts.fill) : undefined,
          // Matches the web tool: with no explicit fill, the corners are
          // sampled and interpolated across the frame.
          autoDetermineFillColor: !opts.fill,
        };

        if (config.mode === "chroma-solid") {
          applySolidFillToImageData(img, config);
        } else {
          const target = opts.color
            ? hexToRgb(parseHexArg("color", opts.color))
            : detectBackgroundColor(img);
          applyChromaKeyToImageData(img, target, config);
        }

        writeBinaryOutput(imageToPngBuffer(opts.trim ? trimTransparent(img) : img), opts.output);
      } catch (e) {
        fail(e instanceof Error ? e.message : String(e));
      }
    },
  );
}

/**
 * Validate a hex colour up front. chroma-core's hexToRgb silently falls back
 * to white on garbage input, which would look like a successful run.
 */
function parseHexArg(name: string, v: string): string {
  if (!/^#?[a-f\d]{6}$/i.test(v)) fail(`${name}: expected a #rrggbb hex colour, got "${v}"`);
  return v;
}

/** Crop to the opaque bounding box, same rect the atlas packer uses. */
function trimTransparent(img: ImageData): ImageData {
  const rect = computeTrimRect(img);
  if (!rect) fail("image is fully transparent after keying — nothing left to trim");

  const { x, y, w, h } = rect!;
  const out = new ImageData(w, h);
  for (let yy = 0; yy < h; yy++) {
    const srcRow = ((y + yy) * img.width + x) * 4;
    out.data.set(img.data.subarray(srcRow, srcRow + w * 4), yy * w * 4);
  }
  return out;
}
