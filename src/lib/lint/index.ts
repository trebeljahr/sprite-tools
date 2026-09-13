// The lint orchestrator: one entry point every surface calls.
//
// lintSheet() resolves the grid, slices the frames, builds a single RuleContext
// and runs every enabled rule over it. Rules are isolated from each other — a
// rule that throws becomes a rulesSkipped entry rather than taking the whole
// report down, because a partial report is still useful to an agent deciding
// what to do with a sheet.
//
// This module is DOM-free and Node/browser safe: grid resolution mirrors
// cli/lib/common.ts resolveGrid and the slice goes through the pipeline's own
// cell geometry, inlined here so the core never reaches into the CLI package.

import { detectGridFromImageData } from "../pipeline/detect";
import {
  type CellGeometry,
  cellRect,
  computeCellGeometry,
  GridFitError,
  type GridPadding,
  type GridPaddingInput,
  isZeroPadding,
  normalizeGridPadding,
} from "../pipeline/grid";
import { compareFindings, countSeverities, round, type RuleContext } from "./helpers";
import { runAlphaFringe } from "./rules/alpha";
import { runDuplicateFrames, runPivotDrift } from "./rules/frames";
import { runEmptyCell, runFrameBleed, runOpaqueFrame } from "./rules/grid";
import { runNonPowerOfTwo, runPaletteBloat, runPaletteNearDuplicates } from "./rules/palette";
import {
  type DeepPartial,
  type Finding,
  type GridInfo,
  type LintConfig,
  type LintReport,
  RULE_IDS,
  type RuleId,
  type SkippedRule,
  resolveLintConfig,
} from "./types";

export type {
  AlphaFringeConfig,
  CellRef,
  DeepPartial,
  DuplicateFramesConfig,
  EmptyCellConfig,
  Finding,
  FindingData,
  FrameBleedConfig,
  GridInfo,
  LintConfig,
  LintReport,
  LintRuleConfigs,
  LintSummary,
  NonPowerOfTwoConfig,
  OpaqueFrameConfig,
  PaletteBloatConfig,
  PaletteNearDuplicatesConfig,
  PivotDriftConfig,
  PivotPresetId,
  Point,
  Region,
  RuleConfig,
  RuleDoc,
  RuleId,
  Severity,
  SkippedRule,
} from "./types";
export {
  DEFAULT_LINT_CONFIG,
  PIVOT_PRESETS,
  RULE_DOCS,
  RULE_IDS,
  SEVERITY_ORDER,
  isRuleId,
  resolveLintConfig,
  ruleOptionNames,
  validateRuleOption,
} from "./types";

/** Rule id -> implementation. Order of execution follows RULE_IDS. */
const RULE_IMPLS: Record<
  RuleId,
  (ctx: RuleContext) => { findings: Finding[]; skipped: SkippedRule[] }
> = {
  "alpha-fringe": runAlphaFringe,
  "frame-bleed": runFrameBleed,
  "pivot-drift": runPivotDrift,
  "duplicate-frames": runDuplicateFrames,
  "empty-cell": runEmptyCell,
  "opaque-frame": runOpaqueFrame,
  "non-power-of-two": runNonPowerOfTwo,
  "palette-bloat": runPaletteBloat,
  "palette-near-duplicates": runPaletteNearDuplicates,
};

export interface LintInput {
  source: string;
  image: ImageData;
  /** Explicit grid. When both are given, detection is skipped entirely. */
  cols?: number;
  rows?: number;
  /**
   * Outer margin and inter-cell spacing. Stated fields win; detection fills the
   * rest unless both cols and rows are given. Padding that does not tile the
   * sheet throws a GridFitError naming the numbers.
   */
  padding?: GridPaddingInput | null;
  config?: DeepPartial<LintConfig>;
}

export function lintSheet(input: LintInput): LintReport {
  const { source, image } = input;
  const config = resolveLintConfig(input.config);
  const { grid, geometry } = resolveGrid(image, input.cols, input.rows, input.padding);
  const frameWidth = geometry.cellW;
  const frameHeight = geometry.cellH;
  const frames = sliceFrames(image, grid, geometry);

  const ctx: RuleContext = {
    source,
    image,
    frames,
    grid,
    geometry,
    frameWidth,
    frameHeight,
    config,
  };

  const findings: Finding[] = [];
  const rulesRun: RuleId[] = [];
  const rulesSkipped: SkippedRule[] = [];

  for (const id of RULE_IDS) {
    // A disabled rule appears in neither rulesRun nor rulesSkipped: it was not
    // asked to judge, so it has nothing to report either way.
    if (!config.rules[id].enabled) continue;
    rulesRun.push(id);
    try {
      const result = RULE_IMPLS[id](ctx);
      findings.push(...result.findings);
      rulesSkipped.push(...result.skipped);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      rulesSkipped.push({ rule: id, reason: `rule threw: ${message}` });
    }
  }

  // Array.prototype.sort is stable, so findings a rule emitted in a meaningful
  // order (near-duplicate pairs, most significant first) keep that order.
  findings.sort(compareFindings);
  const counts = countSeverities(findings);

  return {
    source,
    width: image.width,
    height: image.height,
    frameWidth,
    frameHeight,
    grid,
    summary: {
      errors: counts.errors,
      warnings: counts.warnings,
      infos: counts.infos,
      frameCount: frames.length,
      rulesRun,
      rulesSkipped,
    },
    findings,
  };
}

/**
 * Same precedence as `cli/lib/common.ts` resolveGrid: a caller-supplied
 * dimension wins outright, and detection only runs to fill in what the caller
 * left out — margin and spacing included, per field, with anything the caller
 * stated winning. Detected padding is a hint: if it does not tile the sheet it
 * is dropped rather than thrown, so a sheet that lints flush today still lints.
 * Stated padding is an assertion, and its GridFitError propagates.
 *
 * `detected` and `confidence` follow provenance, not effort. A half-explicit
 * grid — say `--cols 3` on a sheet detection reads as 5x5 — is the CALLER's
 * grid, so reporting it as detected with the overridden detection's confidence
 * would hand frame-bleed a trust score describing a different grid than the one
 * being linted. The caller owning either dimension makes the whole grid theirs.
 *
 * A flush grid finer than the sheet has pixels collapses to 1x1 rather than
 * being honoured: every rule assumes `cols * rows === frames.length`, and a
 * zero-wide cell cannot satisfy that.
 */
function resolveGrid(
  image: ImageData,
  explicitCols: number | undefined,
  explicitRows: number | undefined,
  padding: GridPaddingInput | null | undefined,
): { grid: GridInfo; geometry: CellGeometry } {
  const stated = normalizeGridPadding(padding);
  const fromDetection = explicitCols === undefined && explicitRows === undefined;
  const det =
    explicitCols !== undefined && explicitRows !== undefined
      ? null
      : detectGridFromImageData(image);
  let cols = Math.max(1, Math.floor(explicitCols ?? det?.cols ?? 1));
  let rows = Math.max(1, Math.floor(explicitRows ?? det?.rows ?? 1));

  let used: GridPadding = stated;
  if (det) {
    const has = statedFields(padding);
    const merged: GridPadding = {
      margin: {
        left: has.left ? stated.margin.left : det.margin.left,
        right: has.right ? stated.margin.right : det.margin.right,
        top: has.top ? stated.margin.top : det.margin.top,
        bottom: has.bottom ? stated.margin.bottom : det.margin.bottom,
      },
      spacing: {
        x: has.x ? stated.spacing.x : det.spacing.x,
        y: has.y ? stated.spacing.y : det.spacing.y,
      },
    };
    if (isZeroPadding(merged) || tiles(image, cols, rows, merged)) used = merged;
  }

  if (
    isZeroPadding(used) &&
    (Math.floor(image.width / cols) < 1 || Math.floor(image.height / rows) < 1)
  ) {
    cols = 1;
    rows = 1;
  }
  const geometry = computeCellGeometry(image.width, image.height, cols, rows, used);
  const padded = { margin: geometry.padding.margin, spacing: geometry.padding.spacing };

  if (!fromDetection) {
    return { grid: { cols, rows, detected: false, confidence: null, ...padded }, geometry };
  }
  // Rounded so report JSON stays stable and readable; 4 digits is far finer
  // than any threshold reads it at.
  return {
    grid: { cols, rows, detected: true, confidence: round(det?.confidence ?? 0), ...padded },
    geometry,
  };
}

/** Which padding fields the caller actually stated, so detection fills only the rest. */
function statedFields(input?: GridPaddingInput | null) {
  const m = input?.margin;
  const mSides = typeof m === "object" && m !== null ? m : undefined;
  const mAll = typeof m === "number";
  const s = input?.spacing;
  const sAxes = typeof s === "object" && s !== null ? s : undefined;
  const sAll = typeof s === "number";
  const side = (k: "left" | "top" | "right" | "bottom", axis: number | undefined) =>
    mSides?.[k] !== undefined || axis !== undefined || mAll;
  const gap = (k: "x" | "y", axis: number | undefined) =>
    sAxes?.[k] !== undefined || axis !== undefined || sAll;
  return {
    left: side("left", input?.marginX),
    right: side("right", input?.marginX),
    top: side("top", input?.marginY),
    bottom: side("bottom", input?.marginY),
    x: gap("x", input?.spacingX),
    y: gap("y", input?.spacingY),
  };
}

function tiles(image: ImageData, cols: number, rows: number, padding: GridPadding): boolean {
  try {
    computeCellGeometry(image.width, image.height, cols, rows, padding);
    return true;
  } catch (e) {
    if (e instanceof GridFitError) return false;
    throw e;
  }
}

/**
 * Row-major cell slices on the pipeline's cut lines, so margin and gutter
 * pixels never leak into a frame. A flush 1x1 grid hands back the sheet itself
 * so rules never pay for a full copy of it.
 */
function sliceFrames(image: ImageData, grid: GridInfo, geometry: CellGeometry): ImageData[] {
  if (grid.cols <= 1 && grid.rows <= 1 && isZeroPadding(geometry.padding)) return [image];

  const frames: ImageData[] = [];
  for (let r = 0; r < grid.rows; r++) {
    for (let c = 0; c < grid.cols; c++) {
      const rect = cellRect(geometry, c, r);
      const sub = new ImageData(rect.w, rect.h);
      for (let y = 0; y < rect.h; y++) {
        const srcRow = ((rect.y + y) * image.width + rect.x) * 4;
        sub.data.set(image.data.subarray(srcRow, srcRow + rect.w * 4), y * rect.w * 4);
      }
      frames.push(sub);
    }
  }
  return frames;
}
