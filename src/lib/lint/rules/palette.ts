// Colour-count and dimension rules: palette bloat, near-duplicate colours, and
// non-power-of-two sheet size.
//
// All three describe the file rather than condemn it, so they are info by
// default. Each one bails with a reason when its preconditions do not hold —
// a rule that fires on healthy art is worse than a missing rule, and these
// three are the ones most likely to misread legitimate gradient work as noise.
//
// Quantization is not reimplemented here: palette-bloat calls extractPalette(),
// which is the same median-cut the Pixelate module uses, so "what this sheet
// collapses to" means the same thing across the whole app.

import { extractPalette, rgbToHex } from "../../palette/extract";
import {
  colorDistance,
  distinctOpaqueColors,
  isRuleEnabled,
  makeFinding,
  meanNearestColorDistance,
  nextPowerOfTwo,
  isPowerOfTwo,
  packRgb,
  round,
  ruleResult,
  type RuleContext,
  type RuleResult,
  skipRule,
  unpackRgb,
} from "../helpers";
import type { Finding, Point } from "../types";

// -----------------------------------------------------------------
// palette-bloat
// -----------------------------------------------------------------

/**
 * Far more distinct colours than the sheet appears to use. Fires only when a
 * small palette reproduces the sheet almost exactly — a real gradient quantizes
 * badly and is left alone.
 */
export function runPaletteBloat(ctx: RuleContext): RuleResult {
  const rule = "palette-bloat";
  if (!isRuleEnabled(ctx, rule)) return ruleResult();
  const cfg = ctx.config.rules[rule];

  const distinct = distinctOpaqueColors(ctx.image).size;
  if (distinct < cfg.minColors) {
    return skipRule(
      rule,
      `${distinct} distinct opaque colours, below the ${cfg.minColors} minimum`,
    );
  }

  const palette = extractPalette(ctx.image, cfg.targetColors);
  if (palette.length === 0) {
    return skipRule(rule, "quantization produced no palette entries");
  }

  const error = meanNearestColorDistance(ctx.image, palette, cfg.sampleStride);
  if (error === null) {
    return skipRule(rule, "no opaque pixels to sample the quantization error over");
  }
  if (error >= cfg.maxQuantizationError) {
    return ruleResult();
  }

  const finding = makeFinding(ctx, {
    rule,
    message: `The sheet has ${distinct} distinct opaque colours but collapses to ${palette.length} with a mean error of ${round(error, 2)} per pixel — the extra colours are encoding noise, not gradient detail.`,
    data: {
      distinctColors: distinct,
      targetColors: cfg.targetColors,
      paletteSize: palette.length,
      meanQuantizationError: round(error, 3),
      maxQuantizationError: cfg.maxQuantizationError,
      sampleStride: cfg.sampleStride,
    },
  });
  return ruleResult([finding]);
}

// -----------------------------------------------------------------
// palette-near-duplicates
// -----------------------------------------------------------------

/** A pair needs two colours; below this there is nothing to compare. */
const MIN_DISTINCT_COLORS = 2;

/**
 * Colours a value or two apart, which is what a lossy re-encode leaves behind.
 * The pair search buckets colours into a coarse RGB grid sized to the distance
 * threshold, so each colour only compares against its 27 neighbouring buckets
 * instead of every other colour.
 */
export function runPaletteNearDuplicates(ctx: RuleContext): RuleResult {
  const rule = "palette-near-duplicates";
  if (!isRuleEnabled(ctx, rule)) return ruleResult();
  const cfg = ctx.config.rules[rule];

  const counts = distinctOpaqueColors(ctx.image);
  if (counts.size < MIN_DISTINCT_COLORS) {
    return skipRule(rule, `${counts.size} distinct opaque colour(s) — nothing to pair up`);
  }
  if (counts.size > cfg.maxColors) {
    return skipRule(
      rule,
      `${counts.size} distinct opaque colours exceeds the ${cfg.maxColors} maximum — photographic source`,
    );
  }

  const eligible: number[] = [];
  for (const [packed, pixels] of counts) {
    if (pixels >= cfg.minPixelsEach) eligible.push(packed);
  }
  if (eligible.length < MIN_DISTINCT_COLORS) return ruleResult();

  const pairs = findNearDuplicatePairs(eligible, counts, cfg.maxDistance);
  if (pairs.length === 0) return ruleResult();

  // Most-covered pairs first, so a truncated list is the significant one.
  pairs.sort((a, b) => {
    const byPixels = b.pixelsA + b.pixelsB - (a.pixelsA + a.pixelsB);
    if (byPixels !== 0) return byPixels;
    if (a.a !== b.a) return a.a - b.a;
    return a.b - b.b;
  });

  // One sheet-wide finding, never one per pair. Anti-aliased and gradient art
  // is full of colours one step apart by design, so a per-pair list buries
  // every other finding under something that is often not a defect at all. The
  // top pair is spelled out; the rest ride along as parallel columns in data.
  const reported = pairs.slice(0, Math.max(1, cfg.maxPairs));
  const top = reported[0];
  const rarer = top.pixelsA <= top.pixelsB ? top.a : top.b;
  const at = firstPositionsOf(ctx.image, new Set([rarer])).get(rarer) ?? null;
  const hexA = rgbToHex(unpackRgb(top.a));
  const hexB = rgbToHex(unpackRgb(top.b));
  const others = pairs.length - 1;

  const finding: Finding = makeFinding(ctx, {
    rule,
    message: `${pairs.length} colour pair(s) differ by ${cfg.maxDistance} or less, most-covered ${hexA} and ${hexB} (${round(top.distance, 2)} apart, ${top.pixelsA} and ${top.pixelsB} pixels)${others > 0 ? ` plus ${others} more` : ""} — encoding noise if this art is meant to use flat colours, though anti-aliased and gradient art has steps like these by design.`,
    at,
    data: {
      colorA: hexA,
      colorB: hexB,
      pixelsA: top.pixelsA,
      pixelsB: top.pixelsB,
      distance: round(top.distance, 3),
      maxDistance: cfg.maxDistance,
      distinctColors: counts.size,
      totalPairs: pairs.length,
      reportedPairs: reported.length,
      pairColorsA: reported.map((p) => rgbToHex(unpackRgb(p.a))),
      pairColorsB: reported.map((p) => rgbToHex(unpackRgb(p.b))),
      pairDistances: reported.map((p) => round(p.distance, 3)),
      pairPixelsA: reported.map((p) => p.pixelsA),
      pairPixelsB: reported.map((p) => p.pixelsB),
    },
  });
  return ruleResult([finding]);
}

interface NearDuplicatePair {
  a: number;
  b: number;
  pixelsA: number;
  pixelsB: number;
  distance: number;
}

/**
 * Bucket by RGB cell, then compare each colour only against the 3x3x3 block of
 * cells around it. A cell edge of ceil(maxDistance) guarantees any true pair
 * lands in adjacent cells, so nothing within range is missed.
 */
function findNearDuplicatePairs(
  colors: number[],
  counts: Map<number, number>,
  maxDistance: number,
): NearDuplicatePair[] {
  const cell = Math.max(1, Math.ceil(maxDistance));
  const buckets = new Map<number, number[]>();
  for (const packed of colors) {
    const { r, g, b } = unpackRgb(packed);
    const key = packRgb(Math.floor(r / cell), Math.floor(g / cell), Math.floor(b / cell));
    const bucket = buckets.get(key);
    if (bucket) bucket.push(packed);
    else buckets.set(key, [packed]);
  }

  const pairs: NearDuplicatePair[] = [];
  for (const packed of colors) {
    const { r, g, b } = unpackRgb(packed);
    const cr = Math.floor(r / cell);
    const cg = Math.floor(g / cell);
    const cb = Math.floor(b / cell);
    for (let dr = -1; dr <= 1; dr++) {
      for (let dg = -1; dg <= 1; dg++) {
        for (let db = -1; db <= 1; db++) {
          const neighbour = buckets.get(packRgb(cr + dr, cg + dg, cb + db));
          if (!neighbour) continue;
          for (const other of neighbour) {
            // Only the lower-valued colour of a pair emits it.
            if (other <= packed) continue;
            const o = unpackRgb(other);
            const distance = colorDistance(r, g, b, o.r, o.g, o.b);
            if (distance > maxDistance) continue;
            pairs.push({
              a: packed,
              b: other,
              pixelsA: counts.get(packed) ?? 0,
              pixelsB: counts.get(other) ?? 0,
              distance,
            });
          }
        }
      }
    }
  }
  return pairs;
}

/** First sheet-absolute occurrence of each wanted packed colour, in one pass. */
function firstPositionsOf(image: ImageData, wanted: Set<number>): Map<number, Point> {
  const found = new Map<number, Point>();
  if (wanted.size === 0) return found;
  const d = image.data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    const packed = packRgb(d[i], d[i + 1], d[i + 2]);
    if (!wanted.has(packed) || found.has(packed)) continue;
    const pixel = i / 4;
    found.set(packed, { x: pixel % image.width, y: Math.floor(pixel / image.width) });
    if (found.size === wanted.size) break;
  }
  return found;
}

// -----------------------------------------------------------------
// non-power-of-two
// -----------------------------------------------------------------

/**
 * Sheet (and optionally frame) dimensions that are not powers of two. Info,
 * never an error: whether it matters is entirely a question of target, so the
 * message names which targets care and which do not.
 */
export function runNonPowerOfTwo(ctx: RuleContext): RuleResult {
  const rule = "non-power-of-two";
  if (!isRuleEnabled(ctx, rule)) return ruleResult();
  const cfg = ctx.config.rules[rule];

  const findings: Finding[] = [];
  const { width, height } = ctx.image;

  if (!isPowerOfTwo(width) || !isPowerOfTwo(height)) {
    const padded = `${nextPowerOfTwo(width)}x${nextPowerOfTwo(height)}`;
    findings.push(
      makeFinding(ctx, {
        rule,
        message: `The sheet is ${width}x${height}, not a power of two (${padded} is the next one up) — GLES2 and WebGL1 restrict such textures to CLAMP_TO_EDGE with no mipmaps and Unity may pad them or refuse compressed formats, while desktop GL, WebGL2, Vulkan, Metal and every modern console handle them fine.`,
        data: {
          width,
          height,
          widthIsPowerOfTwo: isPowerOfTwo(width),
          heightIsPowerOfTwo: isPowerOfTwo(height),
          nextPowerOfTwoWidth: nextPowerOfTwo(width),
          nextPowerOfTwoHeight: nextPowerOfTwo(height),
          scope: "sheet",
        },
      }),
    );
  }

  const fw = ctx.frameWidth;
  const fh = ctx.frameHeight;
  const framesDifferFromSheet = fw !== width || fh !== height;
  if (cfg.checkFrames && framesDifferFromSheet && (!isPowerOfTwo(fw) || !isPowerOfTwo(fh))) {
    const padded = `${nextPowerOfTwo(fw)}x${nextPowerOfTwo(fh)}`;
    findings.push(
      makeFinding(ctx, {
        rule,
        message: `Each frame is ${fw}x${fh}, not a power of two (${padded} is the next one up) — this only matters if you repack frames as individual textures, since GLES2 and WebGL1 restrict NPOT textures to CLAMP_TO_EDGE with no mipmaps while WebGL2, desktop GL, Vulkan and Metal do not.`,
        data: {
          frameWidth: fw,
          frameHeight: fh,
          widthIsPowerOfTwo: isPowerOfTwo(fw),
          heightIsPowerOfTwo: isPowerOfTwo(fh),
          nextPowerOfTwoWidth: nextPowerOfTwo(fw),
          nextPowerOfTwoHeight: nextPowerOfTwo(fh),
          scope: "frame",
        },
      }),
    );
  }

  return ruleResult(findings);
}
