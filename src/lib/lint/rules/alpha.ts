// Alpha-channel rules: alpha-fringe.
//
// A sloppy chroma key leaves a ring of half-transparent pixels around each
// sprite, still tinted with the background colour it was keyed against. That
// ring is invisible at 1x and obvious the moment the sprite is scaled or drawn
// over a different background.
//
// The whole risk here is false positives, so the rule bails before it measures
// anything: pixel art almost always has strictly binary alpha, and a sheet with
// no partially transparent pixel cannot have a fringe by definition. Past that
// gate a pixel only counts when it is partially transparent, sits next to a
// fully transparent pixel, AND is close to the sheet's background colour —
// anti-aliased art fails the third test because its soft edge is tinted with
// the sprite's own colours, not the background's.
//
// That third test only holds while the background colour is real, which is why
// the corner vote below reads alpha as well as RGB. See cornerBackground().

import {
  countTransparentAdjacentPixels,
  createBox,
  expandBox,
  hasTransparentNeighbor,
  isBinaryAlpha,
  isRuleEnabled,
  makeFinding,
  type RuleContext,
  type RuleResult,
  boxToRegion,
  colorDistanceSq,
  pixelOffset,
  round,
  ruleResult,
  sheetPointOf,
  sheetRegionOf,
  skipRule,
} from "../helpers";
import type { Finding, Point } from "../types";

const RULE = "alpha-fringe" as const;

interface Rgb {
  r: number;
  g: number;
  b: number;
}

/**
 * Majority vote over the four corner pixels, restricted to corners that
 * actually carry a colour — the chroma keyer's own corner sampling with alpha
 * taken into account.
 *
 * A corner is evidence when it is still opaque (the background is right there),
 * or when it is transparent but its RGB was left in place (a keyer that only
 * touched alpha). A corner that is transparent AND zeroed is not evidence of
 * anything: canvas, `new ImageData` and every optimizer that zeroes invisible
 * pixels leave rgb(0,0,0) there, and reading that as "the background was black"
 * turns the colour gate into "is this pixel dark?", which every dark
 * anti-aliased outline — the pixel-art convention — passes. Null when no corner
 * is informative, so the rule skips instead of measuring against a phantom.
 */
function cornerBackground(image: ImageData): Rgb | null {
  const { width: w, height: h, data } = image;
  const corners = [
    [0, 0],
    [w - 1, 0],
    [0, h - 1],
    [w - 1, h - 1],
  ] as const;

  const votes = new Map<string, { colour: Rgb; count: number }>();
  for (const [x, y] of corners) {
    const off = pixelOffset(image, x, y);
    const colour = { r: data[off], g: data[off + 1], b: data[off + 2] };
    const carriesColour = data[off + 3] > 0 || colour.r !== 0 || colour.g !== 0 || colour.b !== 0;
    if (!carriesColour) continue;
    const key = `${colour.r},${colour.g},${colour.b}`;
    const seen = votes.get(key);
    if (seen) seen.count++;
    else votes.set(key, { colour, count: 1 });
  }

  let best: { colour: Rgb; count: number } | null = null;
  for (const vote of votes.values()) {
    if (!best || vote.count > best.count) best = vote;
  }
  return best?.colour ?? null;
}

export function runAlphaFringe(ctx: RuleContext): RuleResult {
  if (!isRuleEnabled(ctx, RULE)) return ruleResult();
  const cfg = ctx.config.rules[RULE];

  // Cheapest possible gate, and the one that matters most: no partially
  // transparent pixel anywhere means there is nothing a chroma key could have
  // smeared. Early-exits on the first semi-transparent byte it sees.
  if (isBinaryAlpha(ctx.image)) {
    return skipRule(RULE, "sheet alpha is strictly binary, so no fringe is possible");
  }

  const bg = cornerBackground(ctx.image);
  if (!bg) {
    return skipRule(
      RULE,
      "the sheet's corners are transparent with their colour zeroed, so it carries no background colour to compare a fringe against",
    );
  }
  const maxDistanceSq = cfg.colourDistance * cfg.colourDistance;
  const findings: Finding[] = [];

  for (let index = 0; index < ctx.frames.length; index++) {
    const frame = ctx.frames[index];
    const box = createBox();
    let first: Point | null = null;

    for (let y = 0; y < frame.height; y++) {
      for (let x = 0; x < frame.width; x++) {
        const off = pixelOffset(frame, x, y);
        const alpha = frame.data[off + 3];
        if (alpha === 0 || alpha >= cfg.opaqueAlpha) continue;
        if (!hasTransparentNeighbor(frame, x, y)) continue;
        const distSq = colorDistanceSq(
          frame.data[off],
          frame.data[off + 1],
          frame.data[off + 2],
          bg.r,
          bg.g,
          bg.b,
        );
        if (distSq > maxDistanceSq) continue;
        if (!first) first = { x, y };
        expandBox(box, x, y);
      }
    }

    if (box.count < cfg.minPixels) continue;

    // Denominator is the frame's own silhouette length, so a small sprite with
    // a real fringe still trips and a large sprite with a few stray pixels does
    // not. countTransparentAdjacentPixels counts every pixel with alpha that
    // borders transparency, fringe pixels included.
    const edgePixels = countTransparentAdjacentPixels(frame);
    const edgeFraction = edgePixels === 0 ? 0 : box.count / edgePixels;
    if (edgeFraction < cfg.minEdgeFraction) continue;

    const region = boxToRegion(box);
    findings.push(
      makeFinding(ctx, {
        rule: RULE,
        message:
          `${box.count} semi-transparent pixels within ${cfg.colourDistance} of the detected ` +
          `background colour rgb(${bg.r}, ${bg.g}, ${bg.b}) ring frame ${index}'s edge ` +
          `(${round(edgeFraction * 100, 1)}% of its ${edgePixels} edge pixels) — likely chroma-key fringe.`,
        frame: index,
        at: first ? sheetPointOf(ctx, index, first.x, first.y) : null,
        region: region ? sheetRegionOf(ctx, index, region) : null,
        data: {
          fringePixels: box.count,
          edgePixels,
          edgeFraction: round(edgeFraction),
          backgroundR: bg.r,
          backgroundG: bg.g,
          backgroundB: bg.b,
          colourDistance: cfg.colourDistance,
          opaqueAlpha: cfg.opaqueAlpha,
        },
      }),
    );
  }

  return ruleResult(findings);
}
