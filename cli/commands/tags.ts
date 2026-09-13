import type { Command } from "commander";
import {
  writeJsonOutput,
  fail,
  parseIntArg,
  loadSheet,
  sheetHeader,
  addHelpExtras,
  addGridOptions,
  gridPaddingFromOpts,
  type GridPaddingOpts,
} from "../lib/common";
import { applyDurationSpecs } from "../../src/lib/animation/durations";

type Direction = "forward" | "reverse" | "pingpong";

interface ParsedTag {
  name: string;
  from: number;
  to: number;
  direction: Direction;
  fps: number;
}

export function registerTagsCommand(program: Command) {
  const cmd = program
    .command("tags <input>")
    .description("Emit animation tag (named frame range) metadata.")
    .option("--cols <n>", "sheet columns", (v) => parseIntArg("cols", v))
    .option("--rows <n>", "sheet rows", (v) => parseIntArg("rows", v))
    .option("--tag <spec>", 'repeatable: "name=from-to[:fps[:direction]]"', collect, [])
    .option("--fps <n>", "default FPS for tags", (v) => parseIntArg("fps", v), 10)
    .option("--duration <spec>", 'repeatable: "index=ms" or "from-to=ms"', collect, [])
    .option("-o, --output <file>", "output JSON file (default: stdout)");

  addGridOptions(cmd);

  addHelpExtras(cmd, {
    examples: [
      "sprite-tools tags hero.png --tag idle=0-5 --tag run=6-11",
      "sprite-tools tags hero.png --tag attack=12-18:24:forward --fps 12",
      "sprite-tools tags hero.png --tag bounce=0-7:10:pingpong",
      "# direction may be forward (default), reverse, or pingpong",
      "",
      "# hold the key pose, flick through the in-betweens (milliseconds)",
      "sprite-tools tags hero.png --tag idle=0-5 --duration 0=250 --duration 1-4=80",
      "sprite-tools tags hero.png --tag attack=0-9:24 --duration 3=200",
      "# --duration is per sheet frame, not per tag; frames you never name",
      "# stay null and play at the fps of whichever tag is running them",
    ],
    output: [
      "{ source, frameWidth, frameHeight, grid, frameCount,",
      "  frameDurations?: [ms | null, ...]  (only with --duration; one entry",
      "                                      per frame, null = use tag fps)",
      "  tags: [{ name, from, to, direction, fps }, ...] }",
    ],
  });

  cmd.action(
    (
      input: string,
      opts: {
        cols?: number;
        rows?: number;
        tag: string[];
        fps: number;
        duration: string[];
        output?: string;
      } & GridPaddingOpts,
    ) => {
      try {
        const { image, frames, grid } = loadSheet(
          input,
          opts.cols,
          opts.rows,
          gridPaddingFromOpts(opts),
        );
        const frameCount = frames.length;
        const tags: ParsedTag[] = opts.tag.map((spec) => parseTag(spec, frameCount, opts.fps));
        // undefined when nothing was held, so an all-null array is never emitted.
        const frameDurations = applyDurationSpecs(opts.duration, frameCount);

        writeJsonOutput(
          {
            ...sheetHeader(input, image, grid, frames),
            frameCount,
            ...(frameDurations ? { frameDurations } : {}),
            tags,
          },
          opts.output,
        );
      } catch (e) {
        fail(e instanceof Error ? e.message : String(e));
      }
    },
  );
}

function collect(v: string, prev: string[]): string[] {
  return [...prev, v];
}

function parseTag(spec: string, frameCount: number, defaultFps: number): ParsedTag {
  // Accept: name=from-to[:fps[:direction]]
  const eq = spec.indexOf("=");
  if (eq < 0) {
    throw new Error(`invalid --tag "${spec}" (missing "=")`);
  }
  const name = spec.slice(0, eq).trim();
  if (!name) throw new Error(`invalid --tag "${spec}" (empty name)`);
  const rest = spec.slice(eq + 1).trim();
  const [range, fpsStr, dirStr] = rest.split(":");
  const rangeMatch = /^(-?\d+)-(-?\d+)$/.exec(range.trim());
  if (!rangeMatch) {
    throw new Error(`invalid --tag "${spec}" (range must be "from-to")`);
  }
  const from = clamp(parseInt(rangeMatch[1], 10), 0, Math.max(0, frameCount - 1));
  const to = clamp(parseInt(rangeMatch[2], 10), 0, Math.max(0, frameCount - 1));
  const fps = fpsStr ? parseInt(fpsStr, 10) : defaultFps;
  const direction: Direction = normalizeDir(dirStr);
  return { name, from, to, direction, fps };
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

function normalizeDir(s: string | undefined): Direction {
  if (!s) return "forward";
  const t = s.trim().toLowerCase();
  if (t === "forward" || t === "fwd" || t === "f") return "forward";
  if (t === "reverse" || t === "rev" || t === "r") return "reverse";
  if (t === "pingpong" || t === "pp") return "pingpong";
  throw new Error(`invalid direction "${s}" (forward|reverse|pingpong)`);
}
