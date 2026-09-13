// Rules that judge the cell grid against the art: frame-bleed, empty-cell and
// opaque-frame.
//
// All three ask "does this grid actually match the sheet?", so they share the
// per-cell content pass and the seam scan below. Coordinates: frame-bleed reads
// the sheet directly because a seam straddles two frames, so its runs are
// already sheet-absolute; the other two read sliced frames and convert with
// frameRegionOf on the way out.

import { cellRect } from "../../pipeline/grid";
import {
  type RuleContext,
  type RuleResult,
  frameIndexOf,
  frameRegionOf,
  hasAnyTransparent,
  inBounds,
  isOpaqueAt,
  isRuleEnabled,
  makeFinding,
  mean,
  opaqueCoverage,
  opaquePixelCount,
  round,
  ruleResult,
  skipRule,
} from "../helpers";
import type { Finding } from "../types";

// -----------------------------------------------------------------
// frame-bleed
// -----------------------------------------------------------------

/** The longest stretch of a seam where both sides are opaque. */
interface SeamRun {
  start: number;
  length: number;
}

/**
 * Content touching or crossing an internal cell boundary: either the grid is
 * wrong or the sheet has spacing the slicer misses. Only continuous runs count
 * — a single pixel pair on a seam is normal art that happens to reach the edge.
 *
 * A seam only means something when there is transparency for the content to
 * stop at. Two cells that are both wall-to-wall opaque — a gutterless terrain
 * tileset, full-cell portrait or card art — are opaque on both sides of every
 * seam by construction, and this rule's premise ("the grid is wrong, or there
 * is spacing the slicer misses") is simply false there: the grid is right and
 * there is no spacing. Those seams are passed over, and a sheet with no
 * transparency at all skips the rule outright — the same tileset case
 * opaque-frame below already knows about.
 */
export function runFrameBleed(ctx: RuleContext): RuleResult {
  if (!isRuleEnabled(ctx, "frame-bleed")) return ruleResult();
  const cfg = ctx.config.rules["frame-bleed"];
  const { cols, rows } = ctx.grid;

  if (cols * rows < 2) {
    return skipRule("frame-bleed", "the grid is a single cell, so it has no internal seams");
  }
  if (ctx.grid.detected) {
    const confidence = ctx.grid.confidence ?? 0;
    if (confidence < cfg.minConfidence) {
      return skipRule(
        "frame-bleed",
        `grid detection confidence ${round(confidence, 2)} is below ${cfg.minConfidence}, so the seams are not trustworthy`,
      );
    }
  }

  // Per-frame, so a single keyed decal tile on an otherwise solid tileset does
  // not put every other seam back in play. The guard only covers seams with no
  // gutter: a gutter is empty space between cells by construction, so content
  // that crosses one is bleed however opaque the tiles themselves are.
  const keyed = ctx.frames.map((frame) => hasAnyTransparent(frame, cfg.alphaThreshold));
  const { spacing } = ctx.grid;
  if (!keyed.some(Boolean) && spacing.x === 0 && spacing.y === 0) {
    return skipRule(
      "frame-bleed",
      "no frame has a transparent pixel, so the cells are contiguous art (a tileset or full-cell art) and every seam is opaque by design",
    );
  }
  const judgeable = (a: number, b: number, gutter: number) => gutter > 0 || keyed[a] || keyed[b];

  const findings: Finding[] = [];
  const fw = ctx.frameWidth;
  const fh = ctx.frameHeight;

  // A crossing is a line of content from the last pixel of one cell, through
  // any gutter, to the first pixel of the next. With no gutter that is just the
  // two pixels either side of the seam; with one, content that merely sits in
  // the gutter without reaching the neighbour is not counted.

  // Vertical seams: last column of the left cell against the first of the right.
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col + 1 < cols; col++) {
      const frame = frameIndexOf(row, col, cols);
      const neighbour = frameIndexOf(row, col + 1, cols);
      if (!judgeable(frame, neighbour, spacing.x)) continue;
      const a = cellRect(ctx.geometry, col, row);
      const lastX = a.x + a.w - 1;
      const firstX = cellRect(ctx.geometry, col + 1, row).x;
      const run = longestSeamRun(fh, (i) => spanOpaque(ctx, lastX, firstX, a.y + i, "x"));
      const finding = bleedFinding(ctx, {
        seam: "vertical",
        frame,
        neighbour,
        run,
        boundaryLength: fh,
        region: run && {
          x: lastX,
          y: a.y + run.start,
          width: firstX - lastX + 1,
          height: run.length,
        },
      });
      if (finding) findings.push(finding);
    }
  }

  // Horizontal seams: last row of the upper cell against the first of the lower.
  for (let row = 0; row + 1 < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const frame = frameIndexOf(row, col, cols);
      const neighbour = frameIndexOf(row + 1, col, cols);
      if (!judgeable(frame, neighbour, spacing.y)) continue;
      const a = cellRect(ctx.geometry, col, row);
      const lastY = a.y + a.h - 1;
      const firstY = cellRect(ctx.geometry, col, row + 1).y;
      const run = longestSeamRun(fw, (i) => spanOpaque(ctx, lastY, firstY, a.x + i, "y"));
      const finding = bleedFinding(ctx, {
        seam: "horizontal",
        frame,
        neighbour,
        run,
        boundaryLength: fw,
        region: run && {
          x: a.x + run.start,
          y: lastY,
          width: run.length,
          height: firstY - lastY + 1,
        },
      });
      if (finding) findings.push(finding);
    }
  }

  return ruleResult(findings);
}

interface BleedCandidate {
  seam: "vertical" | "horizontal";
  frame: number;
  neighbour: number;
  run: SeamRun | null;
  boundaryLength: number;
  region: { x: number; y: number; width: number; height: number } | null;
}

/** Applies both thresholds and builds the finding, or returns null. */
function bleedFinding(ctx: RuleContext, candidate: BleedCandidate): Finding | null {
  const cfg = ctx.config.rules["frame-bleed"];
  const { run, region, boundaryLength } = candidate;
  if (!run || !region) return null;
  if (run.length < cfg.minRunLength) return null;
  const fraction = run.length / boundaryLength;
  if (fraction < cfg.minRunFraction) return null;

  return makeFinding(ctx, {
    rule: "frame-bleed",
    message: `Content crosses the ${candidate.seam} seam between frames ${candidate.frame} and ${candidate.neighbour}: ${run.length} of the ${boundaryLength} boundary pixels (${percent(fraction)}%) are opaque on both sides.`,
    frame: candidate.frame,
    at: { x: region.x, y: region.y },
    region,
    data: {
      seam: candidate.seam,
      neighbourFrame: candidate.neighbour,
      runLength: run.length,
      boundaryLength,
      runFraction: round(fraction),
      alphaThreshold: cfg.alphaThreshold,
    },
  });
}

/** Longest continuous stretch of `length` positions for which `crosses` holds. */
function longestSeamRun(length: number, crosses: (i: number) => boolean): SeamRun | null {
  let best: SeamRun | null = null;
  let start = -1;
  for (let i = 0; i <= length; i++) {
    const hit = i < length && crosses(i);
    if (hit) {
      if (start < 0) start = i;
      continue;
    }
    if (start >= 0) {
      const run = { start, length: i - start };
      if (!best || run.length > best.length) best = run;
      start = -1;
    }
  }
  return best;
}

/**
 * Every pixel from `from` to `to` inclusive along one axis carries content, at
 * the rule's own alpha floor — the edge pixel of each cell and the whole gutter
 * between them. `at` is the fixed coordinate on the other axis.
 */
function spanOpaque(
  ctx: RuleContext,
  from: number,
  to: number,
  at: number,
  axis: "x" | "y",
): boolean {
  const alpha = ctx.config.rules["frame-bleed"].alphaThreshold;
  for (let p = from; p <= to; p++) {
    const x = axis === "x" ? p : at;
    const y = axis === "x" ? at : p;
    if (!inBounds(ctx.image, x, y) || !isOpaqueAt(ctx.image, x, y, alpha)) return false;
  }
  return true;
}

// -----------------------------------------------------------------
// empty-cell
// -----------------------------------------------------------------

/**
 * A cell with no content, or so little that it reads as a slicing mistake.
 * Near-empty needs the rest of the sheet to be far denser, which is what keeps
 * thin-limbed art — whose every cell is sparse — from tripping it.
 *
 * Empty cells come in two kinds and only one is a defect. An unbroken run at
 * the END of the sheet is padding — the universal packer layout, n frames laid
 * into a cols x rows grid that does not divide evenly — and reports at the
 * softer paddingSeverity. An empty cell with content after it is a hole in the
 * sequence, which is a warning.
 */
export function runEmptyCell(ctx: RuleContext): RuleResult {
  if (!isRuleEnabled(ctx, "empty-cell")) return ruleResult();
  const cfg = ctx.config.rules["empty-cell"];
  const frames = ctx.frames;
  const count = frames.length;

  if (count < 2) {
    return skipRule("empty-cell", "the grid is a single cell, so there is no empty cell to find");
  }

  const coverages = frames.map((frame) => opaqueCoverage(frame, cfg.alphaThreshold));
  const nonEmpty = coverages.filter((coverage) => coverage > 0);

  // A wholly blank sheet is one finding, not one per cell. The claim is about
  // the area the grid covers, not the whole image: sliceFrames floors the cell
  // size, so up to cols-1 columns and rows-1 rows were never measured.
  if (nonEmpty.length === 0) {
    const { spacing, margin } = ctx.grid;
    const width = ctx.grid.cols * ctx.frameWidth + (ctx.grid.cols - 1) * spacing.x;
    const height = ctx.grid.rows * ctx.frameHeight + (ctx.grid.rows - 1) * spacing.y;
    return ruleResult([
      makeFinding(ctx, {
        rule: "empty-cell",
        message: `All ${count} cells are empty: no pixel in the ${width}x${height} the ${ctx.grid.cols}x${ctx.grid.rows} grid covers has alpha above ${cfg.alphaThreshold}.`,
        frame: null,
        region: { x: margin.left, y: margin.top, width, height },
        data: {
          frameCount: count,
          alphaThreshold: cfg.alphaThreshold,
          measuredWidth: width,
          measuredHeight: height,
        },
      }),
    ]);
  }

  const meanCoverage = mean(nonEmpty);
  // Everything past the last drawn cell is trailing padding rather than a hole.
  let lastDrawn = -1;
  for (let i = 0; i < count; i++) {
    if (coverages[i] > 0) lastDrawn = i;
  }
  const findings: Finding[] = [];

  for (let i = 0; i < count; i++) {
    const frame = frames[i];
    const coverage = coverages[i];
    const cellPixels = frame.width * frame.height;

    if (coverage === 0) {
      const padding = i > lastDrawn;
      findings.push(
        makeFinding(ctx, {
          rule: "empty-cell",
          severity: padding ? cfg.paddingSeverity : undefined,
          message: padding
            ? `Frame ${i} is empty, one of the ${count - lastDrawn - 1} unused cell(s) after the sheet's last drawn frame ${lastDrawn} — trailing padding from laying ${lastDrawn + 1} frames into a ${ctx.grid.cols}x${ctx.grid.rows} grid, not a hole in the sequence.`
            : `Frame ${i} is empty: none of its ${cellPixels} pixels have alpha above ${cfg.alphaThreshold}, while the sheet's ${nonEmpty.length} non-empty cells average ${percent(meanCoverage)}% coverage — and frames after it are drawn, so this is a hole rather than padding.`,
          frame: i,
          region: frameRegionOf(ctx, i),
          data: {
            coverage: 0,
            opaquePixels: 0,
            cellPixels,
            meanNonEmptyCoverage: round(meanCoverage),
            contrastRatio: null,
            trailingPadding: padding,
            lastDrawnFrame: lastDrawn,
          },
        }),
      );
      continue;
    }

    if (coverage >= cfg.nearEmptyFraction) continue;
    const contrastRatio = meanCoverage / coverage;
    if (contrastRatio < cfg.contrastFactor) continue;

    findings.push(
      makeFinding(ctx, {
        rule: "empty-cell",
        severity: cfg.nearEmptySeverity,
        message: `Frame ${i} is nearly empty: ${opaquePixelCount(frame, cfg.alphaThreshold)} of its ${cellPixels} pixels are opaque (${percent(coverage)}%), ${round(contrastRatio, 1)}x below the ${percent(meanCoverage)}% the sheet's other cells average.`,
        frame: i,
        region: frameRegionOf(ctx, i),
        data: {
          coverage: round(coverage, 6),
          opaquePixels: opaquePixelCount(frame, cfg.alphaThreshold),
          cellPixels,
          meanNonEmptyCoverage: round(meanCoverage),
          contrastRatio: round(contrastRatio, 2),
        },
      }),
    );
  }

  return ruleResult(findings);
}

// -----------------------------------------------------------------
// opaque-frame
// -----------------------------------------------------------------

/**
 * A frame with zero transparent pixels while most frames in the same sheet do
 * have transparency. The mix is the signal: a sheet that is mostly opaque is a
 * legitimate tileset and says nothing about a missing key.
 *
 * "Mostly" has to be proportional, not a count: a terrain tileset that ships
 * one keyed decal or overlay tile — the ordinary case — would otherwise turn
 * every one of its solid tiles into a finding on the strength of that single
 * transparent cell.
 */
export function runOpaqueFrame(ctx: RuleContext): RuleResult {
  if (!isRuleEnabled(ctx, "opaque-frame")) return ruleResult();
  const cfg = ctx.config.rules["opaque-frame"];
  const frames = ctx.frames;
  const count = frames.length;

  if (count < 2) {
    return skipRule(
      "opaque-frame",
      "the grid is a single cell, so there is no in-sheet contrast to judge against",
    );
  }

  const transparent = frames.map((frame) => hasAnyTransparent(frame));
  const transparentCount = transparent.filter(Boolean).length;

  const transparentFraction = transparentCount / count;
  if (transparentCount < cfg.minTransparentFrames) {
    return skipRule(
      "opaque-frame",
      `only ${transparentCount} of ${count} frames have transparency (minimum ${cfg.minTransparentFrames}) — a sheet with no keyed frames is a legitimate tileset`,
    );
  }
  if (transparentFraction < cfg.minTransparentFraction) {
    return skipRule(
      "opaque-frame",
      `only ${transparentCount} of ${count} frames have transparency (${percent(transparentFraction)}%, minimum ${percent(cfg.minTransparentFraction)}%) — a mostly opaque sheet is a legitimate tileset, keyed decal tiles and all`,
    );
  }

  const findings: Finding[] = [];
  for (let i = 0; i < count; i++) {
    if (transparent[i]) continue;
    findings.push(
      makeFinding(ctx, {
        rule: "opaque-frame",
        message: `Frame ${i} has no transparent pixels while ${transparentCount} of the sheet's ${count} frames do — its background was probably left un-keyed.`,
        frame: i,
        region: frameRegionOf(ctx, i),
        data: {
          frameCount: count,
          transparentFrames: transparentCount,
          opaqueFrames: count - transparentCount,
          transparentFraction: round(transparentFraction),
        },
      }),
    );
  }

  return ruleResult(findings);
}

// -----------------------------------------------------------------
// Shared
// -----------------------------------------------------------------

/** Fractions read as percentages in messages; the raw value stays in `data`. */
function percent(fraction: number): number {
  return round(fraction * 100, 1);
}
