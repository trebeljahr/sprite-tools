import { Command } from "commander";
import {
  writeBinaryOutput,
  fail,
  parseFloatArg,
  parseIntArg,
  loadSheet,
} from "../lib/common";
import { imageToPngBuffer, stitchSheet } from "../lib/image-io";
import {
  generateNormalMap,
  type NormalSource,
} from "../../src/lib/normal-map/normal-map";

export function registerNormalMapCommand(program: Command) {
  program
    .command("normal-map <input>")
    .description("Generate an OpenGL-style normal map from alpha or luminance.")
    .option("--cols <n>", "sheet columns", (v) => parseIntArg("cols", v))
    .option("--rows <n>", "sheet rows", (v) => parseIntArg("rows", v))
    .option("--source <mode>", "alpha | luminance | mixed", "alpha")
    .option("--strength <n>", "height scale (bigger = steeper)", (v) => parseFloatArg("strength", v), 1.0)
    .option("--mix <n>", "alpha/luminance blend 0..1 (mixed mode)", (v) => parseFloatArg("mix", v), 0.5)
    .option("--flip-y", "flip Y for DirectX-style normal maps", false)
    .option("--blur <n>", "pre-blur radius in px", (v) => parseIntArg("blur", v), 0)
    .option("-o, --output <file>", "output PNG file (default: stdout)")
    .action(
      (
        input: string,
        opts: {
          cols?: number;
          rows?: number;
          source: NormalSource;
          strength: number;
          mix: number;
          flipY: boolean;
          blur: number;
          output?: string;
        },
      ) => {
        try {
          if (!["alpha", "luminance", "mixed"].includes(opts.source)) {
            fail(`--source must be one of alpha | luminance | mixed`);
          }
          const { frames, grid } = loadSheet(input, opts.cols, opts.rows);
          const processed = frames.map((f) =>
            generateNormalMap(f, {
              source: opts.source,
              strength: opts.strength,
              mix: opts.mix,
              flipY: opts.flipY,
              blur: opts.blur,
            }),
          );
          const output =
            processed.length === 1
              ? processed[0]
              : stitchSheet(processed, grid.cols, grid.rows);
          writeBinaryOutput(imageToPngBuffer(output), opts.output);
        } catch (e) {
          fail(e instanceof Error ? e.message : String(e));
        }
      },
    );
}
