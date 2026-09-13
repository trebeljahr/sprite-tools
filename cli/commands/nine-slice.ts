import type { Command } from "commander";
import {
  writeJsonOutput,
  fail,
  parseFloatArg,
  parseIntArg,
  loadSheet,
  resolveGrid,
  addHelpExtras,
} from "../lib/common";
import { loadPng, savePng, sliceSheet } from "../lib/image-io";
import {
  clampInsets,
  detectNineSlice,
  nineSliceRegions,
  stretchNineSlice,
  DEFAULT_ALPHA_THRESHOLD,
  DEFAULT_TOLERANCE,
  DEFAULT_MIN_MIDDLE,
  type NineSliceInsets,
  type NineSliceRegion,
} from "../../src/lib/nine-slice/nine-slice";
import { decodeNinePatch, encodeNinePatch } from "../../src/lib/nine-slice/ninepatch";

// 9-slice insets for panels, dialogue boxes and health bars: the four border
// widths that stay 1:1 while the middle stretches. Insets can come from an
// Android .9.png border (--from-9patch), from explicit --left/--right/--top/
// --bottom, or from the variance-profile guess in detectNineSlice — which is a
// starting point, not an answer, so --preview exists to check it.

export interface NineSliceExplicit {
  left?: number;
  right?: number;
  top?: number;
  bottom?: number;
}

export interface NineSliceComputeOptions {
  alphaThreshold: number;
  tolerance: number;
  minMiddle: number;
}

export interface NineSliceEntry {
  index: number;
  cell: { row: number; col: number };
  insets: NineSliceInsets;
  detected: boolean;
  confidence: number;
  regions: NineSliceRegion[];
}

/**
 * Resolve insets for every frame. Sides given in `explicit` win; the rest come
 * from detection, which is only a starting guess derived from per-axis
 * variance. `detected` is false (and confidence 0) when all four sides were
 * supplied. Shared with the `meta` command's --nine-slice section.
 */
export function computeNineSliceEntries(
  frames: ImageData[],
  cols: number,
  explicit: NineSliceExplicit,
  opts: NineSliceComputeOptions,
): NineSliceEntry[] {
  const sides = definedSides(explicit);
  const fullyExplicit =
    sides.left !== undefined &&
    sides.right !== undefined &&
    sides.top !== undefined &&
    sides.bottom !== undefined;

  return frames.map((f, i) => {
    let confidence = 0;
    let merged: Partial<NineSliceInsets> = sides;
    if (!fullyExplicit) {
      const det = detectNineSlice(f, opts);
      confidence = det.confidence;
      merged = { ...det.insets, ...sides };
    }
    const insets = clampInsets(merged, f.width, f.height, opts.minMiddle);
    return {
      index: i,
      cell: { row: Math.floor(i / cols), col: i % cols },
      insets,
      detected: !fullyExplicit,
      confidence,
      regions: nineSliceRegions(insets, f.width, f.height),
    };
  });
}

export function registerNineSliceCommand(program: Command) {
  const cmd = program
    .command("nine-slice <input>")
    .description("Emit 9-slice insets + stretch regions for each frame.")
    .option("--cols <n>", "columns (auto-detected if omitted)", (v) => parseIntArg("cols", v))
    .option("--rows <n>", "rows (auto-detected if omitted)", (v) => parseIntArg("rows", v))
    .option("--left <n>", "explicit left inset in px", (v) => parseIntArg("left", v))
    .option("--right <n>", "explicit right inset in px", (v) => parseIntArg("right", v))
    .option("--top <n>", "explicit top inset in px", (v) => parseIntArg("top", v))
    .option("--bottom <n>", "explicit bottom inset in px", (v) => parseIntArg("bottom", v))
    .option(
      "--alpha <n>",
      "alpha threshold: pixels below it compare as equal",
      (v) => parseFloatArg("alpha", v),
      DEFAULT_ALPHA_THRESHOLD,
    )
    .option(
      "--tolerance <n>",
      "0-1 adjacent-line difference that still counts as flat",
      (v) => parseFloatArg("tolerance", v),
      DEFAULT_TOLERANCE,
    )
    .option(
      "--min-middle <n>",
      "minimum size the stretchable middle keeps",
      (v) => parseIntArg("min-middle", v),
      DEFAULT_MIN_MIDDLE,
    )
    .option("--from-9patch", "read insets off the input's Android .9.png border", false)
    .option("--emit-9patch <file>", "also write a .9.png encoding the resolved insets")
    .option("--preview <file>", "also write a stretched PNG to eyeball the insets")
    .option("--preview-size <WxH>", "size for --preview (default: 3x the frame)")
    .option("-o, --output <file>", "output JSON file (default: stdout)");

  addHelpExtras(cmd, {
    examples: [
      "sprite-tools nine-slice panel.png",
      "sprite-tools nine-slice panel.png --left 8 --right 8 --top 8 --bottom 8",
      "sprite-tools nine-slice panel.png --top 12 --tolerance 0.05   # detect the other 3 sides",
      "sprite-tools nine-slice panel.png --preview panel-192x96.png --preview-size 192x96",
      "sprite-tools nine-slice panel.png --emit-9patch panel.9.png",
      "sprite-tools nine-slice panel.9.png --from-9patch",
      "",
      "# Without explicit sides the insets are a STARTING GUESS: the detector walks",
      "# per-axis variance and calls the flat middle stretchable. That lands on panels",
      "# with an obviously flat or repeated middle and falls apart on busy or gradient",
      "# artwork. Render --preview, look at it, then set --left/--right/--top/--bottom",
      "# by hand — the manual insets are the real interface.",
      "",
      "# --emit-9patch and --preview operate on frame 0 of a multi-frame sheet.",
    ],
    output: [
      "{ source, frameWidth, frameHeight, grid, options,",
      "  nineSlice: [{ index, cell:{row,col}, insets:{left,right,top,bottom},",
      "               detected, confidence,",
      "               regions: [{ name, x, y, width, height, stretchX, stretchY },",
      "                         ... 9 row-major, top-left to bottom-right] }, ...] }",
    ],
  });

  cmd.action(
    (
      input: string,
      opts: {
        cols?: number;
        rows?: number;
        left?: number;
        right?: number;
        top?: number;
        bottom?: number;
        alpha: number;
        tolerance: number;
        minMiddle: number;
        from9patch: boolean;
        emit9patch?: string;
        preview?: string;
        previewSize?: string;
        output?: string;
      },
    ) => {
      try {
        const explicit: NineSliceExplicit = definedSides(opts);
        const sheet = opts.from9patch
          ? loadNinePatchSheet(input, opts.cols, opts.rows)
          : { ...loadSheet(input, opts.cols, opts.rows), insets: null, padding: null };
        const { frames, grid } = sheet;
        if (frames.length === 0) fail("no frames to slice — check --cols / --rows");

        // A .9.png border supplies every side that was not overridden on the
        // command line, so nothing is left to detect.
        const resolved: NineSliceExplicit = sheet.insets
          ? { ...sheet.insets, ...explicit }
          : explicit;

        const entries = computeNineSliceEntries(frames, grid.cols, resolved, {
          alphaThreshold: opts.alpha,
          tolerance: opts.tolerance,
          minMiddle: opts.minMiddle,
        });

        const first = frames[0];
        const firstInsets = entries[0].insets;
        if (opts.emit9patch) {
          // Carry a decoded content box through, same as the MCP tool does.
          savePng(encodeNinePatch(first, firstInsets, sheet.padding), opts.emit9patch);
        }
        if (opts.preview) {
          const size = opts.previewSize
            ? parsePreviewSize(opts.previewSize)
            : { width: first.width * 3, height: first.height * 3 };
          savePng(stretchNineSlice(first, firstInsets, size.width, size.height), opts.preview);
        }

        writeJsonOutput(
          {
            source: input,
            frameWidth: first.width,
            frameHeight: first.height,
            grid: { cols: grid.cols, rows: grid.rows, detected: grid.detected },
            options: {
              auto: entries.some((e) => e.detected),
              explicit: Object.keys(explicit).length > 0 ? explicit : null,
              alphaThreshold: opts.alpha,
              tolerance: opts.tolerance,
              minMiddle: opts.minMiddle,
              ...(opts.from9patch ? { ninePatch: true } : {}),
            },
            nineSlice: entries,
          },
          opts.output,
        );
      } catch (e) {
        fail(e instanceof Error ? e.message : String(e));
      }
    },
  );
}

/** Only the sides the caller actually supplied, so spreads don't null out the rest. */
function definedSides(e: NineSliceExplicit): NineSliceExplicit {
  const out: NineSliceExplicit = {};
  if (e.left !== undefined) out.left = e.left;
  if (e.right !== undefined) out.right = e.right;
  if (e.top !== undefined) out.top = e.top;
  if (e.bottom !== undefined) out.bottom = e.bottom;
  return out;
}

/**
 * Strip the .9.png marker border off the input and slice the interior as the
 * sheet, returning the insets the border encoded. Everything downstream then
 * sees plain content.
 */
function loadNinePatchSheet(
  input: string,
  cols: number | undefined,
  rows: number | undefined,
): {
  frames: ImageData[];
  grid: ReturnType<typeof resolveGrid>;
  insets: NineSliceInsets;
  padding: NineSliceInsets | null;
} {
  const decoded = decodeNinePatch(loadPng(input));
  const content = decoded.content;
  const grid = resolveGrid(content, cols, rows);
  const frames =
    grid.cols > 1 || grid.rows > 1 ? sliceSheet(content, grid.cols, grid.rows) : [content];
  return { frames, grid, insets: decoded.insets, padding: decoded.padding };
}

/** "192x96" -> { width: 192, height: 96 }. */
function parsePreviewSize(v: string): { width: number; height: number } {
  const m = /^(\d+)\s*[x×]\s*(\d+)$/i.exec(v.trim());
  if (!m) fail(`preview-size: expected WxH (e.g. "192x96"), got "${v}"`);
  return { width: parseInt(m![1], 10), height: parseInt(m![2], 10) };
}
