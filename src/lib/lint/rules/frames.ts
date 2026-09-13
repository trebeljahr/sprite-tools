// Frame-sequence lint rules: pivot-drift and duplicate-frames.
//
// Both rules read the sheet as an animation rather than as pixels: they only
// have something to say once there are several frames to compare against each
// other. Empty frames are excluded from both (the empty-cell rule owns those),
// so a padded sheet does not skew a median or match itself as a duplicate.
//
// duplicate-frames owns no pixel math of its own: it runs the pipeline's
// findDuplicateFrames, the code behind `sprite-tools dedupe`, so "lint says
// these are duplicates" and "dedupe removes these" are the same statement.
//
// pivot-drift derives its pivot exactly the way `cli/commands/pivot.ts` derives
// preset pivots — same table, same Math.round(n * (size - 1)) convention — but
// anchors to the frame's CONTENT bounds instead of the whole cell, because a
// cell-anchored pivot is identical on every frame and can never drift.

import {
  boundsToRegion,
  contentBoundsOf,
  contentPivotOf,
  frameRegionOf,
  isFrameEmpty,
  makeFinding,
  median,
  round,
  type RuleContext,
  type RuleResult,
  ruleResult,
  sheetPointOf,
  sheetRegionOf,
  skipRule,
} from "../helpers";
import { findDuplicateFrames } from "../../pipeline/dedupe-core";
import { type Finding, PIVOT_PRESETS, type PivotPresetId } from "../types";

// Re-exported so the CLI and MCP server can name presets from one place and
// stay in step with the linter. Order matches `cli/commands/pivot.ts`.
export { PIVOT_PRESETS };
export type { PivotPresetId };

export const PIVOT_PRESET_IDS: readonly PivotPresetId[] = [
  "center",
  "top-center",
  "top-left",
  "top-right",
  "bottom-center",
  "bottom-left",
  "bottom-right",
];

// ---------------------------------------------------------------
// pivot-drift
// ---------------------------------------------------------------

interface FramePivot {
  frame: number;
  x: number;
  y: number;
}

/**
 * A content-anchored pivot that jumps mid-sequence makes a character hop.
 *
 * A frame has to fail on the SAME axis twice to fire: far from the sequence
 * median AND a large step from the previous non-empty frame. Requiring both on
 * one axis is what lets a smooth walk-cycle drift, or a sprite that genuinely
 * travels inside its cell, pass without noise — only a discontinuity fires.
 */
export function runPivotDrift(ctx: RuleContext): RuleResult {
  const rule = "pivot-drift" as const;
  const cfg = ctx.config.rules[rule];
  if (!cfg.enabled) return ruleResult();

  // preset is a closed set in the type system and a bare string by the time it
  // arrives from a flag or an MCP call, so state what is wrong rather than
  // letting the preset table throw and blame an internal error.
  if (!PIVOT_PRESETS[cfg.preset]) {
    return skipRule(rule, `unknown preset "${cfg.preset}" (valid: ${PIVOT_PRESET_IDS.join(", ")})`);
  }

  const pivots: FramePivot[] = [];
  for (let i = 0; i < ctx.frames.length; i++) {
    const pivot = contentPivotOf(ctx.frames[i], cfg.preset);
    if (pivot) pivots.push({ frame: i, x: pivot.x, y: pivot.y });
  }

  if (pivots.length < cfg.minFrames) {
    return skipRule(
      rule,
      `only ${pivots.length} non-empty frame(s), need at least ${cfg.minFrames} to tell a jump from a pose`,
    );
  }

  const medianX = median(pivots.map((p) => p.x));
  const medianY = median(pivots.map((p) => p.y));
  const maxDeviationX = cfg.maxDeviationFraction * ctx.frameWidth;
  const maxDeviationY = cfg.maxDeviationFraction * ctx.frameHeight;
  const maxStepX = cfg.maxStepFraction * ctx.frameWidth;
  const maxStepY = cfg.maxStepFraction * ctx.frameHeight;

  const findings: Finding[] = [];
  for (let i = 0; i < pivots.length; i++) {
    const current = pivots[i];
    // A jump is a discontinuity, so it needs a neighbour to be a step away
    // from. The first frame borrows the next one; otherwise a sheet whose very
    // first frame is the odd one out would have no outlier to report at all.
    const neighbour = i === 0 ? pivots[1] : pivots[i - 1];
    // Only reachable with a configured minFrames below 2, where a lone frame
    // has no neighbour to be a step away from and so cannot be a discontinuity.
    if (!neighbour) continue;
    const deviationX = Math.abs(current.x - medianX);
    const deviationY = Math.abs(current.y - medianY);
    const stepX = Math.abs(current.x - neighbour.x);
    const stepY = Math.abs(current.y - neighbour.y);

    const driftsX = deviationX > maxDeviationX && stepX > maxStepX;
    const driftsY = deviationY > maxDeviationY && stepY > maxStepY;
    if (!driftsX && !driftsY) continue;

    const axis = driftsX && driftsY ? "both" : driftsX ? "x" : "y";
    const deviation = driftsX ? deviationX : deviationY;
    const step = driftsX ? stepX : stepY;
    const size = driftsX ? ctx.frameWidth : ctx.frameHeight;
    const bounds = contentBoundsOf(ctx.frames[current.frame]);

    findings.push(
      makeFinding(ctx, {
        rule,
        frame: current.frame,
        at: sheetPointOf(ctx, current.frame, current.x, current.y),
        region: bounds ? sheetRegionOf(ctx, current.frame, boundsToRegion(bounds)) : null,
        message: `Frame ${current.frame}'s ${cfg.preset} content pivot sits at (${current.x}, ${current.y}), ${round(deviation, 1)}px off the sequence median (${medianX}, ${medianY}) on ${axis === "both" ? "both axes" : `the ${axis} axis`} and ${round(step, 1)}px from frame ${neighbour.frame} — that is ${round((deviation / size) * 100, 1)}% of the ${size}px frame, so the sprite hops between these frames.`,
        data: {
          preset: cfg.preset,
          axis,
          pivotX: current.x,
          pivotY: current.y,
          medianX,
          medianY,
          neighbourFrame: neighbour.frame,
          deviationX,
          deviationY,
          stepX,
          stepY,
          deviationFractionX: round(deviationX / ctx.frameWidth),
          deviationFractionY: round(deviationY / ctx.frameHeight),
          stepFractionX: round(stepX / ctx.frameWidth),
          stepFractionY: round(stepY / ctx.frameHeight),
          nonEmptyFrames: pivots.length,
        },
      }),
    );
  }

  return ruleResult(findings);
}

// ---------------------------------------------------------------
// duplicate-frames
// ---------------------------------------------------------------

/**
 * Frames `sprite-tools dedupe` would remove, reported once per duplicate group.
 *
 * Info, never a warning: holds and repeated frames are a legitimate animation
 * technique, so this reports what is there and leaves the judgement to the
 * caller. A tiled sheet of n identical cells is one observation, not n-1 of
 * them — pterodactyl.png's 16 identical cells would otherwise bury every other
 * rule under 15 findings that all say the same thing.
 *
 * Grouping is dedupe's: a frame joins a group only by matching its
 * representative, never by chaining through another member, so frames at the
 * two ends of a gradual change are not called duplicates of each other.
 */
export function runDuplicateFrames(ctx: RuleContext): RuleResult {
  const rule = "duplicate-frames" as const;
  const cfg = ctx.config.rules[rule];
  if (!cfg.enabled) return ruleResult();

  const frameCount = ctx.frames.length;
  if (frameCount < 2) {
    return skipRule(rule, `sheet has ${frameCount} frame(s), nothing to compare`);
  }

  // Sheet index of each frame dedupe sees. Empty cells would otherwise all be
  // byte-identical to each other and turn padding into a duplicate group.
  const drawn = ctx.frames.flatMap((frame, i) => (isFrameEmpty(frame) ? [] : [i]));
  if (drawn.length < 2) {
    return skipRule(rule, `only ${drawn.length} non-empty frame(s), nothing to compare`);
  }

  // The exact pass hashes and is linear. Only a fuzzy threshold reads every
  // pixel of candidate pairs, and the web app runs lintSheet() synchronously,
  // so an unbudgeted scan there is a frozen tab rather than a slow command.
  const framePixels = ctx.frameWidth * ctx.frameHeight;
  const comparisonPixels = drawn.length * drawn.length * framePixels;
  if (cfg.threshold > 0 && comparisonPixels > cfg.maxComparisonPixels) {
    return skipRule(
      rule,
      `a fuzzy pass over ${drawn.length} frames of ${framePixels} pixels each reads about ${comparisonPixels} pixels, over the maxComparisonPixels budget of ${cfg.maxComparisonPixels}; threshold 0 (exact) has no budget`,
    );
  }

  const result = findDuplicateFrames(
    drawn.map((i) => ctx.frames[i]),
    { threshold: cfg.threshold },
  );
  const groups = result.groups.map((g) => ({
    keep: drawn[g.keep],
    duplicates: g.duplicates.map((d) => drawn[d]),
    maxDistance: g.distances.reduce((max, d) => (d > max ? d : max), 0),
  }));
  if (groups.length === 0) return ruleResult();

  // Biggest groups first, so a truncated list keeps the significant ones.
  groups.sort((a, b) => {
    const bySize = b.duplicates.length - a.duplicates.length;
    return bySize !== 0 ? bySize : a.keep - b.keep;
  });
  const reported = groups.slice(0, Math.max(0, cfg.maxGroupsReported));
  const command =
    cfg.threshold > 0 ? `sprite-tools dedupe --threshold ${cfg.threshold}` : "sprite-tools dedupe";

  const findings = reported.map((group) => {
    const list = collapseFrameRanges(group.duplicates);
    const one = group.duplicates.length === 1;
    const groupSize = group.duplicates.length + 1;
    const likeness =
      group.maxDistance === 0
        ? "their visible pixels are byte-identical"
        : `none further than a mean absolute difference of ${round(group.maxDistance, 3)} from it (threshold ${cfg.threshold})`;

    return makeFinding(ctx, {
      rule,
      frame: group.keep,
      region: frameRegionOf(ctx, group.keep),
      message: `${one ? "Frame" : "Frames"} ${list} ${one ? "duplicates" : "duplicate"} frame ${group.keep}: ${likeness}, so \`${command}\` would keep frame ${group.keep} and remove ${one ? "it" : `these ${group.duplicates.length}`}${groups.length > 1 ? ` — one of ${groups.length} duplicate groups on this sheet` : ""}.`,
      data: {
        duplicateOf: group.keep,
        memberFrames: [group.keep, ...group.duplicates],
        duplicateFrames: [...group.duplicates],
        groupSize,
        maxDistance: round(group.maxDistance, 4),
        threshold: cfg.threshold,
        method: result.method,
        totalGroups: groups.length,
        reportedGroups: reported.length,
      },
    });
  });

  return ruleResult(findings);
}

/** [1,2,3,5,8,9] -> "1-3, 5, 8-9" — ascending input, compact output. */
function collapseFrameRanges(frames: number[]): string {
  const parts: string[] = [];
  for (let i = 0; i < frames.length; ) {
    let end = i;
    while (end + 1 < frames.length && frames[end + 1] === frames[end] + 1) end++;
    parts.push(end > i ? `${frames[i]}-${frames[end]}` : `${frames[i]}`);
    i = end + 1;
  }
  return parts.join(", ");
}
