import { Command } from "commander";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  writeJsonOutput,
  fail,
  parseIntArg,
  loadSheet,
  addHelpExtras,
} from "../lib/common";
import { savePng } from "../lib/image-io";

export function registerSliceCommand(program: Command) {
  const cmd = program
    .command("slice <input>")
    .description("Split a sprite sheet into one PNG per cell on disk.")
    .option("--cols <n>", "columns (auto-detected if omitted)", (v) => parseIntArg("cols", v))
    .option("--rows <n>", "rows (auto-detected if omitted)", (v) => parseIntArg("rows", v))
    .option("--out-dir <dir>", "directory to write frames into", "frames")
    .option(
      "--name <pattern>",
      "filename pattern (printf-style %d / %02d substitutions)",
      "frame_%02d.png",
    )
    .option("--json <file>", "also write an index JSON to this path");

  addHelpExtras(cmd, {
    examples: [
      "sprite-tools slice sheet.png",
      "sprite-tools slice sheet.png --cols 8 --rows 4 --out-dir ./frames",
      'sprite-tools slice sheet.png --name "run_%03d.png" --json index.json',
    ],
    output: [
      "Writes one PNG per cell into --out-dir. Optional --json writes:",
      "  { source, frameWidth, frameHeight, grid, frames: [{ index, cell, path }, ...] }",
    ],
  });

  cmd.action(
    (
      input: string,
      opts: {
        cols?: number;
        rows?: number;
        outDir: string;
        name: string;
        json?: string;
      },
    ) => {
      try {
        const { frames, grid } = loadSheet(input, opts.cols, opts.rows);
        mkdirSync(opts.outDir, { recursive: true });
        const paths: string[] = [];
        for (let i = 0; i < frames.length; i++) {
          const filename = formatPattern(opts.name, i);
          const p = join(opts.outDir, filename);
          mkdirSync(dirname(p), { recursive: true });
          savePng(frames[i], p);
          paths.push(p);
        }
        if (opts.json) {
          writeJsonOutput(
            {
              source: input,
              frameWidth: frames[0]?.width ?? 0,
              frameHeight: frames[0]?.height ?? 0,
              grid: { cols: grid.cols, rows: grid.rows, detected: grid.detected },
              frames: paths.map((p, i) => ({
                index: i,
                cell: { row: Math.floor(i / grid.cols), col: i % grid.cols },
                path: p,
              })),
            },
            opts.json,
          );
        }
        // Silent success by default — print count to stderr so stdout stays clean.
        process.stderr.write(`sliced ${frames.length} frames → ${opts.outDir}\n`);
      } catch (e) {
        fail(e instanceof Error ? e.message : String(e));
      }
    },
  );
}

function formatPattern(pattern: string, n: number): string {
  // Accept printf-style %d and %0Nd
  return pattern.replace(/%(0?\d*)d/g, (_m, pad: string) => {
    const s = String(n);
    if (pad.startsWith("0")) {
      const width = parseInt(pad, 10);
      return s.padStart(width, "0");
    }
    if (pad) {
      const width = parseInt(pad, 10);
      return s.padStart(width, " ");
    }
    return s;
  });
}
