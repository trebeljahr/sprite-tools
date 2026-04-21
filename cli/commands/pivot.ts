import { Command } from "commander";
import {
  writeJsonOutput,
  fail,
  parseIntArg,
  loadSheet,
  addHelpExtras,
} from "../lib/common";

interface PivotPreset {
  id: string;
  nx: number;
  ny: number;
}

const PRESETS: PivotPreset[] = [
  { id: "center", nx: 0.5, ny: 0.5 },
  { id: "top-center", nx: 0.5, ny: 0 },
  { id: "top-left", nx: 0, ny: 0 },
  { id: "top-right", nx: 1, ny: 0 },
  { id: "bottom-center", nx: 0.5, ny: 1 },
  { id: "bottom-left", nx: 0, ny: 1 },
  { id: "bottom-right", nx: 1, ny: 1 },
];

export function registerPivotCommand(program: Command) {
  const cmd = program
    .command("pivot <input>")
    .description("Emit pivot (anchor) metadata for each frame.")
    .option("--cols <n>", "sheet columns", (v) => parseIntArg("cols", v))
    .option("--rows <n>", "sheet rows", (v) => parseIntArg("rows", v))
    .option(
      "--preset <id>",
      `one of ${PRESETS.map((p) => p.id).join(", ")}`,
      "bottom-center",
    )
    .option("--x <n>", "explicit pivot X (overrides preset)", (v) => parseIntArg("x", v))
    .option("--y <n>", "explicit pivot Y (overrides preset)", (v) => parseIntArg("y", v))
    .option("-o, --output <file>", "output JSON file (default: stdout)");

  addHelpExtras(cmd, {
    examples: [
      "sprite-tools pivot hero.png                                    # default: bottom-center",
      "sprite-tools pivot hero.png --preset center",
      "sprite-tools pivot hero.png --preset bottom-center --cols 8 --rows 4",
      "sprite-tools pivot hero.png --x 32 --y 48     # override preset with explicit coords",
    ],
    output: [
      "{ source, frameWidth, frameHeight, grid, options,",
      "  pivots: [{ index, cell:{row,col}, pivot:{x,y} }, ...] }",
    ],
  });

  cmd.action(
      (
        input: string,
        opts: {
          cols?: number;
          rows?: number;
          preset: string;
          x?: number;
          y?: number;
          output?: string;
        },
      ) => {
        try {
          const preset = PRESETS.find((p) => p.id === opts.preset);
          if (!preset) {
            fail(`--preset must be one of ${PRESETS.map((p) => p.id).join(", ")}`);
          }
          const { frames, grid } = loadSheet(input, opts.cols, opts.rows);
          const pivots = frames.map((f, i) => {
            const x =
              opts.x !== undefined
                ? opts.x
                : Math.round(preset!.nx * (f.width - 1));
            const y =
              opts.y !== undefined
                ? opts.y
                : Math.round(preset!.ny * (f.height - 1));
            return {
              index: i,
              cell: { row: Math.floor(i / grid.cols), col: i % grid.cols },
              pivot: { x, y },
            };
          });
          writeJsonOutput(
            {
              source: input,
              frameWidth: frames[0]?.width ?? 0,
              frameHeight: frames[0]?.height ?? 0,
              grid: { cols: grid.cols, rows: grid.rows, detected: grid.detected },
              options: {
                preset: opts.preset,
                explicit:
                  opts.x !== undefined || opts.y !== undefined
                    ? { x: opts.x, y: opts.y }
                    : null,
              },
              pivots,
            },
            opts.output,
          );
        } catch (e) {
          fail(e instanceof Error ? e.message : String(e));
        }
      },
    );
}
