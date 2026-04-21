import { Command } from "commander";
import { loadPng } from "../lib/image-io";
import { writeJsonOutput, fail } from "../lib/common";
import { detectGridFromImageData } from "../../src/lib/pipeline/detect";

export function registerDetectCommand(program: Command) {
  program
    .command("detect <input>")
    .description("Auto-detect the sprite-sheet grid. Prints {cols, rows, confidence} as JSON.")
    .option("-o, --output <file>", "write JSON to file (default: stdout)")
    .action((input: string, opts: { output?: string }) => {
      try {
        const img = loadPng(input);
        const det = detectGridFromImageData(img);
        writeJsonOutput(
          {
            source: input,
            width: img.width,
            height: img.height,
            grid: { cols: det.cols, rows: det.rows },
            confidence: Number(det.confidence.toFixed(3)),
          },
          opts.output,
        );
      } catch (e) {
        fail(e instanceof Error ? e.message : String(e));
      }
    });
}
