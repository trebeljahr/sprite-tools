import { Command } from "commander";
import { writeJsonOutput, fail, addHelpExtras } from "../lib/common";
import { loadPng } from "../lib/image-io";
import { detectGridFromImageData } from "../../src/lib/pipeline/detect";
import { computeTrimRect } from "../../src/lib/atlas/pack";

export function registerInfoCommand(program: Command) {
  const cmd = program
    .command("info <input>")
    .description("Print image + sprite-sheet info as JSON (opaque pixel count, detected grid, content bounds).")
    .option("-o, --output <file>", "output JSON file (default: stdout)");

  addHelpExtras(cmd, {
    examples: [
      "sprite-tools info sheet.png",
      "sprite-tools info sheet.png | jq '.grid'",
      "cat sheet.png | sprite-tools info -",
    ],
    output: [
      "{ source, width, height,",
      "  opaquePixels, opaqueFraction,",
      "  contentBounds: {x,y,width,height} | null,",
      "  grid: {cols, rows, confidence} }",
    ],
  });

  cmd.action((input: string, opts: { output?: string }) => {
    try {
      const img = loadPng(input);
      let opaque = 0;
      for (let i = 3; i < img.data.length; i += 4) {
        if (img.data[i] > 0) opaque++;
      }
      const total = img.width * img.height;
      const det = detectGridFromImageData(img);
      const bounds = computeTrimRect(img);
      writeJsonOutput(
        {
          source: input,
          width: img.width,
          height: img.height,
          opaquePixels: opaque,
          opaqueFraction: total > 0 ? Number((opaque / total).toFixed(4)) : 0,
          contentBounds: bounds
            ? { x: bounds.x, y: bounds.y, width: bounds.w, height: bounds.h }
            : null,
          grid: {
            cols: det.cols,
            rows: det.rows,
            confidence: Number(det.confidence.toFixed(3)),
          },
        },
        opts.output,
      );
    } catch (e) {
      fail(e instanceof Error ? e.message : String(e));
    }
  });
}
