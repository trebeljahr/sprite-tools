import type { Command } from "commander";
import { loadPng } from "../lib/image-io";
import { writeJsonOutput, fail, addHelpExtras } from "../lib/common";
import { detectGridFromImageData } from "../../src/lib/pipeline/detect";

export function registerDetectCommand(program: Command) {
  const cmd = program
    .command("detect <input>")
    .description("Auto-detect the sprite-sheet grid: cols, rows, margin, spacing. Prints JSON.")
    .option("-o, --output <file>", "write JSON to file (default: stdout)");

  addHelpExtras(cmd, {
    examples: [
      "sprite-tools detect sheet.png",
      "# pipe into another command:",
      "GRID=$(sprite-tools detect sheet.png | jq -r '.grid | \"--cols \\(.cols) --rows \\(.rows) --margin-x \\(.margin.left) --margin-y \\(.margin.top) --spacing-x \\(.spacing.x) --spacing-y \\(.spacing.y)\"')",
      "sprite-tools slice sheet.png $GRID",
    ],
    output: [
      "{ source, width, height, confidence,",
      "  grid: { cols, rows,",
      "          margin:  {left, top, right, bottom},   # outer border, 0 when flush",
      "          spacing: {x, y} } }                    # gutter between cells",
      "# confidence ∈ [0, 1]; above 0.5 is usually a reliable grid",
      "# margin/spacing feed straight back in as --margin-x/--spacing-x/... flags",
    ],
  });

  cmd.action((input: string, opts: { output?: string }) => {
    try {
      const img = loadPng(input);
      const det = detectGridFromImageData(img);
      writeJsonOutput(
        {
          source: input,
          width: img.width,
          height: img.height,
          grid: {
            cols: det.cols,
            rows: det.rows,
            margin: det.margin,
            spacing: det.spacing,
          },
          confidence: Number(det.confidence.toFixed(3)),
        },
        opts.output,
      );
    } catch (e) {
      fail(e instanceof Error ? e.message : String(e));
    }
  });
}
