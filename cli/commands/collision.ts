import type { Command } from "commander";
import {
  writeJsonOutput,
  fail,
  parseFloatArg,
  parseIntArg,
  loadSheet,
  addHelpExtras,
} from "../lib/common";
import { generateOutline } from "../../src/lib/collision/outline";

export function registerCollisionCommand(program: Command) {
  const cmd = program
    .command("collision <input>")
    .description("Generate per-frame collision polygon JSON from a sprite or sheet")
    .option("--cols <n>", "columns (auto-detected if omitted)", (v) => parseIntArg("cols", v))
    .option("--rows <n>", "rows (auto-detected if omitted)", (v) => parseIntArg("rows", v))
    .option(
      "--alpha <n>",
      "alpha threshold 0-255 (pixels above are opaque)",
      (v) => parseFloatArg("alpha", v),
      10,
    )
    .option(
      "--tolerance <n>",
      "RDP simplification tolerance in px (0 = keep every point)",
      (v) => parseFloatArg("tolerance", v),
      10,
    )
    .option("--convex-hull", "reduce each polygon to its convex hull", false)
    .option("-o, --output <file>", "output JSON file (default: stdout)");

  addHelpExtras(cmd, {
    examples: [
      "sprite-tools collision sprite.png > collision.json",
      "sprite-tools collision sheet.png --tolerance 4 -o collision.json",
      "sprite-tools collision sheet.png --cols 8 --rows 4 --convex-hull",
      "# lower --tolerance = more vertices; --convex-hull = engine-friendly convex fixtures",
    ],
    output: [
      "{ source, frameWidth, frameHeight, grid, options,",
      "  collision: [{ index, cell:{row,col}, pointCount, bounds,",
      "               polygon: [[x,y], ...] }, ...] }",
    ],
  });

  cmd.action(
    (
      input: string,
      opts: {
        cols?: number;
        rows?: number;
        alpha: number;
        tolerance: number;
        convexHull: boolean;
        output?: string;
      },
    ) => {
      try {
        const { frames, grid } = loadSheet(input, opts.cols, opts.rows);
        const results = frames.map((f, i) => {
          const outline = generateOutline(f, {
            alphaThreshold: opts.alpha,
            simplifyTolerance: opts.tolerance,
            convexHull: opts.convexHull,
          });
          return {
            index: i,
            cell: { row: Math.floor(i / grid.cols), col: i % grid.cols },
            pointCount: outline.polygon.length,
            rawContourLength: outline.rawContourLength,
            bounds: outline.bounds,
            polygon: outline.polygon.map((p) => [p.x, p.y] as const),
          };
        });
        writeJsonOutput(
          {
            source: input,
            frameWidth: frames[0]?.width ?? 0,
            frameHeight: frames[0]?.height ?? 0,
            grid: { cols: grid.cols, rows: grid.rows, detected: grid.detected },
            options: {
              alphaThreshold: opts.alpha,
              simplifyTolerance: opts.tolerance,
              convexHull: opts.convexHull,
            },
            collision: results,
          },
          opts.output,
        );
      } catch (e) {
        fail(e instanceof Error ? e.message : String(e));
      }
    },
  );
}
