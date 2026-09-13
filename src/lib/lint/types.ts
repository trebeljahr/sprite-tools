// Public contract for the sprite-sheet linter.
//
// Everything an agent, the CLI, the MCP server and the web overlay key off
// lives here: the rule ids, the finding/report shapes, the tunable config with
// its defaults, and the prose that documents each rule. Rule modules import
// from this file; nothing here touches the DOM or reads pixels.
//
// Coordinate convention: `at` and `region` on a Finding are SHEET-ABSOLUTE
// pixel coordinates, so a viewer can draw them straight onto the sheet without
// knowing the grid. This deliberately differs from the collision and pivot
// commands, whose coordinates are cell-relative.

import type { GridMargin, GridSpacing } from "../pipeline/grid";

// -----------------------------------------------------------------
// Findings
// -----------------------------------------------------------------

export type Severity = "error" | "warning" | "info";

/** Sort weight for severities: errors first, infos last. */
export const SEVERITY_ORDER: Record<Severity, number> = {
  error: 0,
  warning: 1,
  info: 2,
};

export const RULE_IDS = [
  "alpha-fringe",
  "frame-bleed",
  "pivot-drift",
  "duplicate-frames",
  "empty-cell",
  "opaque-frame",
  "non-power-of-two",
  "palette-bloat",
  "palette-near-duplicates",
] as const;

export type RuleId = (typeof RULE_IDS)[number];

export function isRuleId(value: string): value is RuleId {
  return (RULE_IDS as readonly string[]).includes(value);
}

export interface Point {
  x: number;
  y: number;
}

export interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CellRef {
  row: number;
  col: number;
}

/**
 * The raw numbers behind a message, so callers never have to parse prose.
 * Scalars, plus flat lists for things that are naturally a set: a duplicate
 * group's frame indices, or the parallel colour/count columns of a pair list.
 */
export type FindingData = Record<string, number | string | boolean | null | number[] | string[]>;

export interface Finding {
  rule: RuleId;
  severity: Severity;
  /** Human-readable, one sentence, states the numbers. */
  message: string;
  /** Row-major frame index, null when the finding is sheet-wide. */
  frame: number | null;
  cell: CellRef | null;
  /** Sheet-absolute pixel coordinates. */
  at: Point | null;
  /** Sheet-absolute rect. */
  region: Region | null;
  data: FindingData;
}

// -----------------------------------------------------------------
// Report
// -----------------------------------------------------------------

export interface GridInfo {
  cols: number;
  rows: number;
  /**
   * True only when BOTH dimensions came from auto-detection. A caller who
   * supplies either cols or rows owns the grid, so the confidence of the
   * detection they overrode would not describe it.
   */
  detected: boolean;
  /** Detection confidence, null unless the whole grid was detected. */
  confidence: number | null;
  /**
   * The outer border and inter-cell gutter actually used to cut the cells, in
   * px — stated by the caller, inferred by detection, or zeros for a flush
   * sheet. Pass them straight back into any other sheet command.
   */
  margin: GridMargin;
  spacing: GridSpacing;
}

export interface SkippedRule {
  rule: RuleId;
  reason: string;
}

export interface LintSummary {
  errors: number;
  warnings: number;
  infos: number;
  frameCount: number;
  rulesRun: RuleId[];
  rulesSkipped: SkippedRule[];
}

export interface LintReport {
  source: string;
  width: number;
  height: number;
  frameWidth: number;
  frameHeight: number;
  grid: GridInfo;
  summary: LintSummary;
  /** Sorted by severity, then rule id, then frame index. */
  findings: Finding[];
}

// -----------------------------------------------------------------
// Config
// -----------------------------------------------------------------

/**
 * Every rule is individually disableable, its severity overridable, and every
 * threshold it uses lives on its own config — no magic numbers in rule bodies.
 * The index signature keeps `LintConfig["rules"]` assignable to
 * `Record<RuleId, RuleConfig>`; the per-rule interfaces below give rules typed
 * access to their own thresholds.
 */
export interface RuleConfig {
  enabled: boolean;
  severity: Severity;
  [option: string]: unknown;
}

/** Pivot anchor presets, mirroring `cli/commands/pivot.ts`. */
export type PivotPresetId =
  | "center"
  | "top-center"
  | "top-left"
  | "top-right"
  | "bottom-center"
  | "bottom-left"
  | "bottom-right";

export const PIVOT_PRESETS: Record<PivotPresetId, { nx: number; ny: number }> = {
  center: { nx: 0.5, ny: 0.5 },
  "top-center": { nx: 0.5, ny: 0 },
  "top-left": { nx: 0, ny: 0 },
  "top-right": { nx: 1, ny: 0 },
  "bottom-center": { nx: 0.5, ny: 1 },
  "bottom-left": { nx: 0, ny: 1 },
  "bottom-right": { nx: 1, ny: 1 },
};

export interface AlphaFringeConfig extends RuleConfig {
  /** Alpha at or above which a pixel counts as opaque rather than fringe. */
  opaqueAlpha: number;
  /** Max euclidean RGB distance from the detected background to count. */
  colourDistance: number;
  minPixels: number;
  /** Share of the frame's transparent-adjacent edge pixels that must offend. */
  minEdgeFraction: number;
}

export interface FrameBleedConfig extends RuleConfig {
  /** Detection confidence below which the grid is not trusted enough to judge. */
  minConfidence: number;
  minRunLength: number;
  minRunFraction: number;
  /** Alpha above which a seam pixel counts as content; 0 means any alpha at all. */
  alphaThreshold: number;
}

export interface PivotDriftConfig extends RuleConfig {
  preset: PivotPresetId;
  minFrames: number;
  /** Deviation from the median pivot, as a share of frame size. */
  maxDeviationFraction: number;
  /** Step from the previous non-empty frame, as a share of frame size. */
  maxStepFraction: number;
}

export interface DuplicateFramesConfig extends RuleConfig {
  /**
   * Max mean absolute RGBA difference, 0-255 scale — the same number `sprite-tools
   * dedupe --threshold` takes, so a finding reproduces with that command. 0 means
   * byte-identical visible pixels only.
   */
  threshold: number;
  /**
   * Budget for the fuzzy pass, in pixel comparisons (frames² × frame area). The
   * exact pass hashes and is linear; only threshold > 0 reads every pixel of
   * candidate pairs, and the web app runs this on its render path.
   */
  maxComparisonPixels: number;
  /** Cap on reported duplicate groups; the true total stays in the finding data. */
  maxGroupsReported: number;
}

export interface EmptyCellConfig extends RuleConfig {
  /** Severity for near-empty (as opposed to fully empty) cells. */
  nearEmptySeverity: Severity;
  /** Severity for the unbroken run of empty cells at the end of the sheet. */
  paddingSeverity: Severity;
  alphaThreshold: number;
  nearEmptyFraction: number;
  /** How many times the mean non-empty coverage must exceed a cell's own. */
  contrastFactor: number;
}

export interface OpaqueFrameConfig extends RuleConfig {
  /** At least this many frames must have transparency for the mix to matter. */
  minTransparentFrames: number;
  /**
   * And they must be at least this share of the sheet. A mostly-opaque tileset
   * that ships one keyed decal tile is a tileset, not fifteen un-keyed frames.
   */
  minTransparentFraction: number;
}

export interface NonPowerOfTwoConfig extends RuleConfig {
  /** Also report frame dimensions, not just the sheet's. */
  checkFrames: boolean;
}

export interface PaletteBloatConfig extends RuleConfig {
  minColors: number;
  targetColors: number;
  /** Sample every Nth opaque pixel when measuring quantization error. */
  sampleStride: number;
  maxQuantizationError: number;
}

export interface PaletteNearDuplicatesConfig extends RuleConfig {
  /** Above this distinct-colour count the source is photographic — skip. */
  maxColors: number;
  maxDistance: number;
  minPixelsEach: number;
  /** Cap on the pair columns in the finding data; data.totalPairs keeps the true count. */
  maxPairs: number;
}

export interface LintRuleConfigs {
  "alpha-fringe": AlphaFringeConfig;
  "frame-bleed": FrameBleedConfig;
  "pivot-drift": PivotDriftConfig;
  "duplicate-frames": DuplicateFramesConfig;
  "empty-cell": EmptyCellConfig;
  "opaque-frame": OpaqueFrameConfig;
  "non-power-of-two": NonPowerOfTwoConfig;
  "palette-bloat": PaletteBloatConfig;
  "palette-near-duplicates": PaletteNearDuplicatesConfig;
}

export interface LintConfig {
  rules: LintRuleConfigs;
}

export type DeepPartial<T> = T extends readonly unknown[]
  ? T
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

/**
 * Defaults tuned so the bundled samples in `public/samples/` produce no error-
 * or warning-severity findings. A rule that fires on healthy art is worse than
 * a missing rule, so thresholds lean conservative.
 *
 * Deep-frozen: `resolveLintConfig()` always hands back a fresh mutable copy.
 */
export const DEFAULT_LINT_CONFIG: LintConfig = deepFreeze({
  rules: {
    "alpha-fringe": {
      enabled: true,
      severity: "warning",
      opaqueAlpha: 250,
      colourDistance: 60,
      minPixels: 24,
      minEdgeFraction: 0.02,
    },
    "frame-bleed": {
      enabled: true,
      severity: "error",
      minConfidence: 0.5,
      minRunLength: 3,
      minRunFraction: 0.05,
      // Alpha 8 is about 3% opacity. Below it a pixel is invisible noise, and
      // this is the one rule that fails a build, so it must not fail on that.
      alphaThreshold: 8,
    },
    "pivot-drift": {
      enabled: true,
      severity: "info",
      preset: "bottom-center",
      minFrames: 3,
      maxDeviationFraction: 0.25,
      maxStepFraction: 0.15,
    },
    "duplicate-frames": {
      enabled: true,
      severity: "info",
      // Exact only by default. MAE is averaged over the whole frame, so at 1 a
      // 48x48 frame whose 15-pixel detail changed completely still matches — a
      // real pose change reported as a duplicate. Raise it for video or AI noise.
      threshold: 0,
      // ~1s of scanning, measured. A 512x512 sheet of 64 frames fits; a
      // 2048x2048 one of 256 needs 1.07e9 and is where the minutes were.
      maxComparisonPixels: 32_000_000,
      maxGroupsReported: 20,
    },
    "empty-cell": {
      enabled: true,
      severity: "warning",
      nearEmptySeverity: "info",
      paddingSeverity: "info",
      alphaThreshold: 0,
      nearEmptyFraction: 0.005,
      contrastFactor: 10,
    },
    "opaque-frame": {
      enabled: true,
      severity: "warning",
      minTransparentFrames: 1,
      minTransparentFraction: 0.5,
    },
    "non-power-of-two": {
      enabled: true,
      severity: "info",
      checkFrames: false,
    },
    "palette-bloat": {
      enabled: true,
      severity: "info",
      minColors: 256,
      targetColors: 32,
      sampleStride: 7,
      maxQuantizationError: 4.0,
    },
    "palette-near-duplicates": {
      enabled: true,
      severity: "info",
      maxColors: 4096,
      maxDistance: 2.0,
      minPixelsEach: 8,
      maxPairs: 20,
    },
  } satisfies LintRuleConfigs,
});

/**
 * Deep-merge caller overrides onto the defaults. Rule configs are flat bags of
 * scalars, so a per-rule field merge is the whole of it; unknown rule ids and
 * `undefined` values are ignored rather than clobbering a default.
 */
export function resolveLintConfig(overrides?: DeepPartial<LintConfig>): LintConfig {
  const rules = {} as LintRuleConfigs;
  const slots = rules as Record<RuleId, RuleConfig>;
  for (const id of RULE_IDS) slots[id] = { ...DEFAULT_LINT_CONFIG.rules[id] };
  const resolved: LintConfig = { rules };

  const patches = overrides?.rules;
  if (!patches) return resolved;

  for (const id of RULE_IDS) {
    const patch = patches[id];
    if (!patch || typeof patch !== "object") continue;
    const target = resolved.rules[id] as Record<string, unknown>;
    for (const [key, value] of Object.entries(patch)) {
      if (value !== undefined) target[key] = value;
    }
  }
  return resolved;
}

/** Every option name a rule accepts, in declaration order. */
export function ruleOptionNames(rule: RuleId): string[] {
  return Object.keys(DEFAULT_LINT_CONFIG.rules[rule]);
}

/**
 * Closed-set options, by name. Severities and pivot presets are unions in the
 * type system and plain strings by the time they arrive from a CLI flag or an
 * MCP call, so the surfaces have to check them against something.
 */
const OPTION_ENUMS: Record<string, readonly string[]> = {
  severity: Object.keys(SEVERITY_ORDER),
  nearEmptySeverity: Object.keys(SEVERITY_ORDER),
  paddingSeverity: Object.keys(SEVERITY_ORDER),
  preset: Object.keys(PIVOT_PRESETS),
};

/**
 * Validate one caller-supplied option against the defaults, returning an error
 * message or null. resolveLintConfig cannot do this itself — it merges plain
 * objects and has no business failing — so every surface that accepts overrides
 * (`--set`, the MCP `options` record) runs values through here first.
 *
 * Without it a typo is worse than an error: an unknown name is dropped
 * silently, and a non-numeric value for a threshold makes every `<` and `>=`
 * comparison against it false, which inverts a gate rather than disabling it.
 */
export function validateRuleOption(rule: RuleId, option: string, value: unknown): string | null {
  const defaults = DEFAULT_LINT_CONFIG.rules[rule] as Record<string, unknown>;
  const fallback = defaults[option];
  if (fallback === undefined) {
    return `unknown option "${option}" for rule "${rule}" (valid: ${ruleOptionNames(rule).join(", ")})`;
  }
  if (typeof value !== typeof fallback) {
    return `option "${rule}.${option}" expects a ${typeof fallback}, got ${typeof value} "${String(value)}"`;
  }
  const allowed = OPTION_ENUMS[option];
  if (allowed && !allowed.includes(value as string)) {
    return `option "${rule}.${option}" expects one of ${allowed.join("|")}, got "${String(value)}"`;
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    return `option "${rule}.${option}" expects a finite number, got "${String(value)}"`;
  }
  return null;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

// -----------------------------------------------------------------
// Rule documentation
// -----------------------------------------------------------------

export interface RuleDoc {
  title: string;
  summary: string;
  /** What the rule deliberately does not catch — stated so nobody trusts it blindly. */
  knownMisses: string;
}

/**
 * Single source of truth for rule prose: the docs page and `lint --help`
 * render from this, so a rule's explanation never drifts between surfaces.
 */
export const RULE_DOCS: Record<RuleId, RuleDoc> = {
  "alpha-fringe": {
    title: "Alpha fringe",
    summary:
      "A ring of semi-transparent, off-colour pixels around sprites, left behind by a sloppy chroma key. Counts only pixels that are partially transparent, touch a fully transparent neighbour, and sit close to the sheet's background colour. Skipped entirely when the alpha channel is strictly binary, which is the normal pixel-art case, and skipped when no corner of the sheet still carries a background colour to compare against.",
    knownMisses:
      "A fringe keyed against a background colour that is not in the corners; a fringe on a sheet whose invisible pixels had their colour zeroed by an optimizer, because the background is then unknowable rather than black; a fully opaque halo, which shows up as palette noise instead.",
  },
  "frame-bleed": {
    title: "Frame bleed",
    summary:
      "Content touching or crossing a cell boundary, meaning the grid is wrong or the sheet has spacing the slicer misses. Only internal seams count — content touching the outer sheet edge is never bleed — and the crossing has to be a continuous run, not a stray pixel. On a sheet with gutters the run must span the whole gutter from one cell's last pixel to the next cell's first. A seam between two cells that are both wall-to-wall opaque says nothing, because a tileset or full-cell art is opaque on both sides of every seam by design, so those seams are passed over and a sheet with no transparency anywhere skips the rule outright.",
    knownMisses:
      "Content that runs into a gutter or the outer margin without reaching the next cell, which the slicer silently crops; bleed between two cells that both happen to be padded at the seam; bleed where the true grid is so wrong that detection returned a single cell; bleed on a sheet with no transparency at all, which is indistinguishable from contiguous art. Faint content at or below alphaThreshold (default 8, about 3% opacity) is ignored, so a genuinely faint shadow or glow crossing a seam goes unreported unless you lower it.",
  },
  "pivot-drift": {
    title: "Pivot drift",
    summary:
      "A content-anchored pivot that jumps mid-sequence, which makes a character visibly hop. Derives each frame's pivot from its content bounds, takes the median across non-empty frames, and fires only when a frame is both far from that median and a large step from the previous frame. Info, never a warning: an airborne frame in a jump is by construction far from the median and a large step from its neighbour, and nothing here can tell that from a mis-anchored frame, so this reports and leaves the judgement to you — `--set pivot-drift.severity=warning` promotes it once you know the sheet holds no intentional excursions.",
    knownMisses:
      "A sheet where every frame's pivot is equally wrong, so there is no outlier to find; multi-animation sheets where two animations legitimately anchor differently — pass explicit rows or lint per-row to avoid noise.",
  },
  "duplicate-frames": {
    title: "Duplicate frames",
    summary:
      "Frames that sprite-tools dedupe would remove, found by the same code with the same threshold, so a finding and the dedupe command never disagree. Reported as info rather than a warning because held and repeated frames are a legitimate animation technique. Each duplicate group reports once, anchored on its lowest frame index, and names the dedupe command that would collapse it. Empty cells are left to empty-cell rather than grouped as duplicates of each other.",
    knownMisses:
      "At the default threshold of 0 only byte-identical frames match (RGB under fully transparent pixels ignored), so near-duplicates from lossy video or AI generation are missed until threshold is raised — and a raised threshold is a mean over the whole frame, so it starts merging frames whose small details genuinely differ. Frames that differ only by a small translation never match. The fuzzy pass is skipped, with a reason, once frames² × frame area exceeds maxComparisonPixels; the group list is capped, though the true group total is always in the finding data.",
  },
  "empty-cell": {
    title: "Empty cell",
    summary:
      "A cell with no content, or so little content that it looks like a slicing mistake. Near-empty only fires when the rest of the sheet is far denser, which is what keeps thin-limbed art from tripping it. An unbroken run of empty cells at the END of the sheet is packer padding — n frames laid into a grid that does not divide evenly — so it reports at the softer paddingSeverity; a warning is reserved for an empty cell that still has content after it, which is a hole in the sequence.",
    knownMisses:
      "An intentional blank spacer in the middle of a strip reads as a hole and still warns — that is what disabling the rule is for.",
  },
  "opaque-frame": {
    title: "Opaque frame",
    summary:
      "A frame with zero transparent pixels while most frames in the same sheet do have transparency. The mixed signal is what makes it unlikely to be intended — usually a background was left un-keyed on that frame. A sheet that is mostly opaque is a legitimate tileset and is skipped, so a terrain set shipping one keyed decal tile does not turn every other tile into a finding.",
    knownMisses:
      "A frame whose background was keyed to a solid colour rather than to transparency looks intentional here and is not reported; an un-keyed frame on a sheet where the keyed frames are the minority is read as a tileset and skipped, which is what minTransparentFraction tunes.",
  },
  "non-power-of-two": {
    title: "Non-power-of-two dimensions",
    summary:
      "Sheet width or height is not a power of two. Always info, never an error: older GLES2 / WebGL1 targets restrict NPOT textures to CLAMP_TO_EDGE with no mipmaps and Unity may pad them or refuse compressed formats, while desktop GL, WebGL2, Vulkan, Metal and every modern console handle NPOT fine.",
    knownMisses:
      "Nothing here knows your target platform, so this is a note for you to judge, not a defect.",
  },
  "palette-bloat": {
    title: "Palette bloat",
    summary:
      "Far more distinct colours than the sheet appears to use. Quantizes to a small palette and measures the mean error; fires only when the sheet genuinely collapses, so the extra colours are noise rather than real gradient detail.",
    knownMisses:
      "Sheets that legitimately use gradients or anti-aliasing quantize badly and are left alone by design.",
  },
  "palette-near-duplicates": {
    title: "Palette near-duplicates",
    summary:
      "Colours differing by one or two values, which on flat-colour art usually means the file went through a lossy re-encode. Both colours in a pair must cover a meaningful number of pixels. Reports once per sheet, not once per pair: the most-covered pair is in the message and the capped pair list rides along in the finding data, with the true total alongside.",
    knownMisses:
      "Photographic sources have too many colours to check and are skipped outright. Nothing here can tell a lossy re-encode from deliberate anti-aliasing or a gradient, which both produce colours one step apart — that is why the rule is info and says so, rather than asserting noise.",
  },
};
