import type { Command } from "commander";
import {
  writeJsonOutput,
  fail,
  parseFloatArg,
  parseIntArg,
  loadSheet,
  sheetHeader,
  addHelpExtras,
  addGridOptions,
  gridPaddingFromOpts,
  type GridPaddingOpts,
} from "../lib/common";
import { generateOutline } from "../../src/lib/collision/outline";
import { computeNineSliceEntries } from "./nine-slice";
import {
  DEFAULT_ALPHA_THRESHOLD,
  DEFAULT_MIN_MIDDLE,
  DEFAULT_TOLERANCE,
} from "../../src/lib/nine-slice/nine-slice";
import { applyDurationSpecs } from "../../src/lib/animation/durations";

// Unified metadata emitter. One pass over the sheet produces collision +
// pivot + tag + 9-slice info in a single merged JSON, so agents don't have to
// run four subcommands and pipe through jq.

type Direction = "forward" | "reverse" | "pingpong";

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

export function registerMetaCommand(program: Command) {
  const cmd = program
    .command("meta <input>")
    .description("One-shot metadata pass: collision + pivot + tags + 9-slice in one merged JSON.")
    .option("--cols <n>", "columns", (v) => parseIntArg("cols", v))
    .option("--rows <n>", "rows", (v) => parseIntArg("rows", v))
    // Collision
    .option("--collision", "include collision polygons", false)
    .option(
      "--alpha <n>",
      "[collision] alpha threshold 0-255",
      (v) => parseFloatArg("alpha", v),
      10,
    )
    .option(
      "--tolerance <n>",
      "[collision] RDP tolerance (px)",
      (v) => parseFloatArg("tolerance", v),
      10,
    )
    .option("--convex-hull", "[collision] reduce to convex hull", false)
    // Pivot
    .option(
      "--pivot <preset>",
      `include pivots with preset (${PRESETS.map((p) => p.id).join(", ")})`,
    )
    .option("--pivot-x <n>", "[pivot] explicit X override", (v) => parseIntArg("pivot-x", v))
    .option("--pivot-y <n>", "[pivot] explicit Y override", (v) => parseIntArg("pivot-y", v))
    // Tags
    .option(
      "--tag <spec>",
      'repeatable animation tag "name=from-to[:fps[:direction]]"',
      collect,
      [],
    )
    .option("--fps <n>", "[tags] default FPS", (v) => parseIntArg("fps", v), 10)
    .option(
      "--duration <spec>",
      '[tags] repeatable per-frame hold "index=ms" or "from-to=ms"',
      collect,
      [],
    )
    // Nine-slice
    .option("--nine-slice", "include 9-slice insets + stretch regions", false)
    .option("--nine-slice-left <n>", "[nine-slice] explicit left inset in px", (v) =>
      parseIntArg("nine-slice-left", v),
    )
    .option("--nine-slice-right <n>", "[nine-slice] explicit right inset in px", (v) =>
      parseIntArg("nine-slice-right", v),
    )
    .option("--nine-slice-top <n>", "[nine-slice] explicit top inset in px", (v) =>
      parseIntArg("nine-slice-top", v),
    )
    .option("--nine-slice-bottom <n>", "[nine-slice] explicit bottom inset in px", (v) =>
      parseIntArg("nine-slice-bottom", v),
    )
    // Output
    .option("-o, --output <file>", "output JSON file (default: stdout)");

  addGridOptions(cmd);

  addHelpExtras(cmd, {
    examples: [
      "sprite-tools meta hero.png --collision --pivot bottom-center \\",
      "  --tag idle=0-5 --tag run=6-11 -o hero-meta.json",
      "",
      "# emit just what you ask for; unselected sections are omitted",
      "sprite-tools meta hero.png --pivot center   # only pivots",
      "",
      "# 9-slice insets: detected per frame, or pinned side by side",
      "sprite-tools meta panel.png --nine-slice --nine-slice-left 8 --nine-slice-right 8",
      "# hold the key pose; --duration is per sheet frame, not per tag",
      "sprite-tools meta hero.png --tag idle=0-5 --duration 0=250 --duration 1-4=80",
    ],
    output: [
      "{ source, frameWidth, frameHeight, grid, frameCount,",
      "  frameDurations?: [ms | null, ...]  (if --duration; one entry per",
      "                                      frame, null = use tag fps)",
      "  collision?: [...]   (if --collision)",
      "  pivots?:    [...]   (if --pivot)",
      "  tags?:      [...]   (if --tag)",
      "  nineSlice?: [...]   (if --nine-slice)  }",
    ],
  });

  cmd.action(
    (
      input: string,
      opts: {
        cols?: number;
        rows?: number;
        collision: boolean;
        alpha: number;
        tolerance: number;
        convexHull: boolean;
        pivot?: string;
        pivotX?: number;
        pivotY?: number;
        tag: string[];
        fps: number;
        nineSlice: boolean;
        nineSliceLeft?: number;
        nineSliceRight?: number;
        nineSliceTop?: number;
        nineSliceBottom?: number;
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
        const base: Record<string, unknown> = {
          ...sheetHeader(input, image, grid, frames),
          frameCount: frames.length,
        };

        // Durations are a property of the frames themselves, so they sit next
        // to frameCount rather than inside the tags section. undefined when
        // nothing was held, so an all-null array is never emitted.
        const frameDurations = applyDurationSpecs(opts.duration, frames.length);
        if (frameDurations) base.frameDurations = frameDurations;

        if (opts.collision) {
          base.collision = frames.map((f, i) => {
            const outline = generateOutline(f, {
              alphaThreshold: opts.alpha,
              simplifyTolerance: opts.tolerance,
              convexHull: opts.convexHull,
            });
            return {
              index: i,
              cell: { row: Math.floor(i / grid.cols), col: i % grid.cols },
              pointCount: outline.polygon.length,
              bounds: outline.bounds,
              polygon: outline.polygon.map((p) => [p.x, p.y] as const),
            };
          });
        }

        if (opts.pivot) {
          const preset = PRESETS.find((p) => p.id === opts.pivot);
          if (!preset) {
            fail(`--pivot must be one of ${PRESETS.map((p) => p.id).join(", ")}`);
          }
          base.pivots = frames.map((f, i) => {
            const x =
              opts.pivotX !== undefined ? opts.pivotX : Math.round(preset!.nx * (f.width - 1));
            const y =
              opts.pivotY !== undefined ? opts.pivotY : Math.round(preset!.ny * (f.height - 1));
            return {
              index: i,
              cell: { row: Math.floor(i / grid.cols), col: i % grid.cols },
              pivot: { x, y },
            };
          });
        }

        if (opts.tag.length > 0) {
          base.tags = opts.tag.map((spec) => parseTag(spec, frames.length, opts.fps));
        }

        if (opts.nineSlice) {
          // Sides left out are detected, which is a starting guess from per-axis
          // variance — run `sprite-tools nine-slice --preview` to check it before
          // trusting it on busy artwork.
          base.nineSlice = computeNineSliceEntries(
            frames,
            grid.cols,
            {
              left: opts.nineSliceLeft,
              right: opts.nineSliceRight,
              top: opts.nineSliceTop,
              bottom: opts.nineSliceBottom,
            },
            {
              alphaThreshold: DEFAULT_ALPHA_THRESHOLD,
              tolerance: DEFAULT_TOLERANCE,
              minMiddle: DEFAULT_MIN_MIDDLE,
            },
          );
        }

        writeJsonOutput(base, opts.output);
      } catch (e) {
        fail(e instanceof Error ? e.message : String(e));
      }
    },
  );
}

function collect(v: string, prev: string[]): string[] {
  return [...prev, v];
}

function parseTag(
  spec: string,
  frameCount: number,
  defaultFps: number,
): { name: string; from: number; to: number; direction: Direction; fps: number } {
  const eq = spec.indexOf("=");
  if (eq < 0) throw new Error(`invalid --tag "${spec}" (missing "=")`);
  const name = spec.slice(0, eq).trim();
  if (!name) throw new Error(`invalid --tag "${spec}" (empty name)`);
  const rest = spec.slice(eq + 1).trim();
  const [range, fpsStr, dirStr] = rest.split(":");
  const m = /^(-?\d+)-(-?\d+)$/.exec(range.trim());
  if (!m) throw new Error(`invalid --tag "${spec}" (range must be "from-to")`);
  const clamp = (n: number) => Math.max(0, Math.min(Math.max(0, frameCount - 1), n));
  return {
    name,
    from: clamp(parseInt(m[1], 10)),
    to: clamp(parseInt(m[2], 10)),
    direction: normalizeDir(dirStr),
    fps: fpsStr ? parseInt(fpsStr, 10) : defaultFps,
  };
}

function normalizeDir(s: string | undefined): Direction {
  if (!s) return "forward";
  const t = s.trim().toLowerCase();
  if (["forward", "fwd", "f"].includes(t)) return "forward";
  if (["reverse", "rev", "r"].includes(t)) return "reverse";
  if (["pingpong", "pp"].includes(t)) return "pingpong";
  throw new Error(`invalid direction "${s}" (forward|reverse|pingpong)`);
}
