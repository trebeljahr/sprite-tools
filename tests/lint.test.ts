import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_LINT_CONFIG,
  type DeepPartial,
  type Finding,
  type LintConfig,
  type LintReport,
  RULE_IDS,
  type RuleId,
  isRuleId,
  lintSheet,
  resolveLintConfig,
  ruleOptionNames,
  validateRuleOption,
} from "@/lib/lint";
import { findDuplicateFrames } from "@/lib/pipeline/dedupe-core";
import { loadPng, sliceSheet } from "../cli/lib/image-io";
import { blank, fillAll, paintRect, setPixel } from "./helpers";

type Rgba = [number, number, number, number];

const CLEAR: Rgba = [0, 0, 0, 0];
const OUTLINE: Rgba = [220, 40, 40, 255];
const MARK: Rgba = [60, 90, 220, 255];

// -----------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------

/**
 * A deliberately healthy sheet: power-of-two 128x128, 4x4 grid of 32px cells,
 * hard binary alpha, two well-separated colours, content inset 6px from every
 * seam. Every cell shares one 20x20 silhouette — so the content-anchored pivot
 * is identical everywhere — while a per-cell interior mark keeps no two frames
 * near-identical. Nothing here should give any rule anything to say.
 */
function cleanSheet(): ImageData {
  const cell = 32;
  const cols = 4;
  const rows = 4;
  const img = blank(cols * cell, rows * cell);
  for (let i = 0; i < cols * rows; i++) {
    const ox = (i % cols) * cell;
    const oy = Math.floor(i / cols) * cell;
    paintRect(img, ox + 6, oy + 6, 20, 20, OUTLINE);
    paintRect(img, ox + 8, oy + 8, 16, 16, CLEAR);
    paintRect(img, ox + 10 + (i % cols) * 3, oy + 10 + Math.floor(i / cols) * 3, 6, 6, MARK);
  }
  return img;
}

/** One healthy 64x64 sprite: power of two, binary alpha, inset content. */
function cleanSprite(): ImageData {
  const img = blank(64, 64);
  paintRect(img, 16, 12, 32, 40, OUTLINE);
  paintRect(img, 20, 16, 24, 20, MARK);
  paintRect(img, 28, 40, 8, 8, CLEAR);
  return img;
}

/** A square with a 1px ring of half-transparent background colour around it. */
function alphaFringeSprite(): ImageData {
  const img = blank(64, 64);
  // Fully transparent pixels keep the background's RGB, so the corner-based
  // detectBackgroundColor still reports green after the key.
  fillAll(img, [0, 255, 0, 0]);
  paintRect(img, 19, 19, 26, 26, [0, 255, 0, 128]);
  paintRect(img, 20, 20, 24, 24, [255, 0, 0, 255]);
  return img;
}

/** A horizontal bar running straight through the seam of a 2x1 grid. */
function frameBleedSheet(barHeight: number): ImageData {
  const img = blank(64, 32);
  paintRect(img, 20, 10, 26, barHeight, OUTLINE);
  return img;
}

/** Four cells whose content sits at the same height, except frame 2. */
function pivotDriftSheet(): ImageData {
  const img = blank(128, 32);
  for (let i = 0; i < 4; i++) {
    const ox = i * 32;
    const oy = i === 2 ? 2 : 16;
    paintRect(img, ox + 8, oy, 8, 8, OUTLINE);
  }
  return img;
}

/** Two cells holding pixel-identical content. */
function duplicateFramesSheet(): ImageData {
  const img = blank(64, 32);
  paintRect(img, 8, 8, 16, 16, OUTLINE);
  paintRect(img, 40, 8, 16, 16, OUTLINE);
  return img;
}

/** A 2x2 grid where the last cell was never drawn. */
function emptyCellSheet(): ImageData {
  const img = blank(64, 64);
  for (const [ox, oy] of [
    [0, 0],
    [32, 0],
    [0, 32],
  ]) {
    paintRect(img, ox + 8, oy + 8, 16, 16, OUTLINE);
  }
  return img;
}

/** Frame 0 was never keyed; frame 1 was. */
function opaqueFrameSheet(): ImageData {
  const img = blank(64, 32);
  paintRect(img, 0, 0, 32, 32, MARK);
  paintRect(img, 40, 8, 16, 16, OUTLINE);
  return img;
}

/** 100x100 — neither dimension is a power of two. */
function nonPowerOfTwoSprite(): ImageData {
  const img = blank(100, 100);
  paintRect(img, 20, 20, 60, 60, OUTLINE);
  return img;
}

/**
 * 256 distinct opaque colours drawn from 8 well-separated bases with a ±3
 * jitter — exactly the shape palette-bloat is after: far more colours than the
 * sheet really uses, all collapsing onto a tiny palette with near-zero error.
 */
function paletteBloatSheet(): ImageData {
  const bases: [number, number, number][] = [
    [20, 30, 40],
    [200, 40, 40],
    [40, 200, 40],
    [40, 40, 200],
    [200, 200, 40],
    [200, 40, 200],
    [40, 200, 200],
    [180, 180, 180],
  ];
  const img = blank(64, 64);
  for (let p = 0; p < img.width * img.height; p++) {
    const base = bases[p % bases.length];
    const variant = Math.floor(p / bases.length) % 32;
    setPixel(img, p % img.width, Math.floor(p / img.width), [
      base[0] + (variant % 4),
      base[1] + (Math.floor(variant / 4) % 4),
      base[2] + (variant >= 16 ? 1 : 0),
      255,
    ]);
  }
  return img;
}

/** Two colours one value apart; the second is the rarer of the pair. */
function nearDuplicateSprite(): ImageData {
  const img = blank(32, 32);
  paintRect(img, 0, 0, 24, 32, [100, 100, 100, 255]);
  paintRect(img, 24, 0, 8, 32, [101, 100, 100, 255]);
  return img;
}

// -----------------------------------------------------------------
// Utilities
// -----------------------------------------------------------------

function findingsFor(report: LintReport, rule: RuleId): Finding[] {
  return report.findings.filter((f) => f.rule === rule);
}

function skipReason(report: LintReport, rule: RuleId): string | undefined {
  return report.summary.rulesSkipped.find((s) => s.rule === rule)?.reason;
}

/** Renders findings compactly so a failing assertion says what actually fired. */
function describeFindings(findings: Finding[]): string {
  if (findings.length === 0) return "none";
  return findings.map((f) => `${f.severity} ${f.rule}@frame ${f.frame}: ${f.message}`).join("\n");
}

const SAMPLES = ["character.png", "sheet.png", "pterodactyl.png"] as const;

function loadSample(name: string): ImageData {
  return loadPng(fileURLToPath(new URL(`../public/samples/${name}`, import.meta.url)));
}

// -----------------------------------------------------------------
// 1. Healthy art must stay silent
// -----------------------------------------------------------------

describe("lintSheet on clean synthetic art", () => {
  it("reports nothing at all on a healthy 4x4 sheet with an explicit grid", () => {
    const report = lintSheet({ source: "clean.png", image: cleanSheet(), cols: 4, rows: 4 });
    expect(describeFindings(report.findings)).toBe("none");
    expect(report.summary).toMatchObject({ errors: 0, warnings: 0, infos: 0, frameCount: 16 });
  });

  it("reports nothing when the same sheet's grid is auto-detected", () => {
    const report = lintSheet({ source: "clean.png", image: cleanSheet() });
    expect(report.grid).toMatchObject({ cols: 4, rows: 4, detected: true });
    expect(describeFindings(report.findings)).toBe("none");
  });

  it("reports nothing on a clean single 64x64 sprite", () => {
    const report = lintSheet({ source: "sprite.png", image: cleanSprite(), cols: 1, rows: 1 });
    expect(describeFindings(report.findings)).toBe("none");
    expect(report.summary.frameCount).toBe(1);
  });

  it("reports nothing on a clean single sprite with an auto-detected grid", () => {
    const report = lintSheet({ source: "sprite.png", image: cleanSprite() });
    expect(describeFindings(report.findings)).toBe("none");
  });
});

// -----------------------------------------------------------------
// 2. The bundled samples
// -----------------------------------------------------------------

describe("lintSheet on the bundled samples", () => {
  for (const name of SAMPLES) {
    it(`raises no error or warning on ${name}`, () => {
      const report = lintSheet({ source: name, image: loadSample(name) });
      const loud = report.findings.filter((f) => f.severity !== "info");
      expect(describeFindings(loud)).toBe("none");
      expect(report.summary.errors).toBe(0);
      expect(report.summary.warnings).toBe(0);
      // Info findings are fine, but say which ones so a future change is legible.
      expect(
        report.summary.infos,
        `info findings on ${name}:\n${describeFindings(report.findings)}`,
      ).toBe(report.findings.length);
    });
  }

  it("skips alpha-fringe on every sample, because pixel-art alpha is binary", () => {
    for (const name of SAMPLES) {
      const report = lintSheet({ source: name, image: loadSample(name) });
      expect(skipReason(report, "alpha-fringe")).toMatch(/binary/);
    }
  });
});

// -----------------------------------------------------------------
// 3. One positive per rule
// -----------------------------------------------------------------

describe("alpha-fringe", () => {
  it("fires on a half-transparent ring of background colour", () => {
    const report = lintSheet({
      source: "fringe.png",
      image: alphaFringeSprite(),
      cols: 1,
      rows: 1,
    });
    const found = findingsFor(report, "alpha-fringe");
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe("warning");
    expect(found[0].frame).toBe(0);
    // Row-major scan hits the ring's top-left corner first.
    expect(found[0].at).toEqual({ x: 19, y: 19 });
    expect(found[0].region).toEqual({ x: 19, y: 19, width: 26, height: 26 });
    expect(found[0].data.fringePixels).toBe(100);
    expect(found[0].data).toMatchObject({ backgroundR: 0, backgroundG: 255, backgroundB: 0 });
  });

  it("skips a keyed sheet whose invisible pixels had their colour zeroed", () => {
    // Same geometry and alpha ramp as the fixture above, but the transparent
    // pixels carry rgb(0,0,0) — what canvas, `new ImageData` and every
    // optimizer that zeroes invisible pixels leave behind. Reading that as "the
    // background was black" would flag every dark anti-aliased edge.
    const img = blank(64, 64);
    paintRect(img, 19, 19, 26, 26, [26, 26, 46, 128]);
    paintRect(img, 20, 20, 24, 24, [26, 26, 46, 255]);
    const report = lintSheet({ source: "zeroed.png", image: img, cols: 1, rows: 1 });
    expect(findingsFor(report, "alpha-fringe")).toHaveLength(0);
    expect(skipReason(report, "alpha-fringe")).toMatch(/no background colour/);
  });

  it("stays quiet on the same shape with hard edges", () => {
    const img = alphaFringeSprite();
    // Promote the ring to fully opaque: binary alpha, so the rule bails.
    for (let i = 3; i < img.data.length; i += 4) {
      if (img.data[i] > 0) img.data[i] = 255;
    }
    const report = lintSheet({ source: "hard.png", image: img, cols: 1, rows: 1 });
    expect(findingsFor(report, "alpha-fringe")).toHaveLength(0);
    expect(skipReason(report, "alpha-fringe")).toMatch(/binary/);
  });
});

describe("frame-bleed", () => {
  it("fires on content running through an internal seam", () => {
    const report = lintSheet({
      source: "bleed.png",
      image: frameBleedSheet(11),
      cols: 2,
      rows: 1,
    });
    const found = findingsFor(report, "frame-bleed");
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe("error");
    // Reported on the lower-index frame, with the crossing run in sheet coords.
    expect(found[0].frame).toBe(0);
    expect(found[0].cell).toEqual({ row: 0, col: 0 });
    expect(found[0].at).toEqual({ x: 31, y: 10 });
    expect(found[0].region).toEqual({ x: 31, y: 10, width: 2, height: 11 });
    expect(found[0].data).toMatchObject({ seam: "vertical", neighbourFrame: 1, runLength: 11 });
    expect(report.summary.errors).toBe(1);
  });

  it("does not treat content on the outer sheet edge as bleed", () => {
    const img = blank(64, 32);
    // Full-height bars hugging the left and right sheet edges, both well clear
    // of the seam at x=32.
    paintRect(img, 0, 0, 6, 32, OUTLINE);
    paintRect(img, 58, 0, 6, 32, OUTLINE);
    const report = lintSheet({ source: "edge.png", image: img, cols: 2, rows: 1 });
    expect(findingsFor(report, "frame-bleed")).toHaveLength(0);
  });

  it("skips rather than guesses when the detected grid is not trustworthy", () => {
    const report = lintSheet({ source: "blank.png", image: blank(64, 64) });
    expect(skipReason(report, "frame-bleed")).toBeDefined();
    expect(findingsFor(report, "frame-bleed")).toHaveLength(0);
  });

  it("skips a sheet with no transparency at all, which is contiguous art", () => {
    // A gutterless terrain tileset: every cell wall-to-wall opaque, so every
    // seam is opaque on both sides by construction rather than by mistake.
    const img = blank(64, 64);
    fillAll(img, MARK);
    paintRect(img, 32, 0, 32, 32, OUTLINE);
    const report = lintSheet({ source: "tiles.png", image: img, cols: 4, rows: 4 });
    expect(findingsFor(report, "frame-bleed")).toHaveLength(0);
    expect(skipReason(report, "frame-bleed")).toMatch(/contiguous art/);
  });

  it("passes over a seam between two opaque cells while still judging keyed ones", () => {
    // Cells 0 and 1 are full-cell art; cell 2 is keyed and its bar runs back
    // across the 1|2 seam. Only that seam can mean anything.
    const img = blank(96, 32);
    paintRect(img, 0, 0, 64, 32, MARK);
    paintRect(img, 60, 10, 20, 11, OUTLINE);
    const report = lintSheet({ source: "mixed.png", image: img, cols: 3, rows: 1 });
    const found = findingsFor(report, "frame-bleed");
    expect(describeFindings(found)).toMatch(/between frames 1 and 2/);
    expect(found).toHaveLength(1);
  });

  it("ignores invisible alpha noise across a seam by default, and can be tuned to see it", () => {
    // A 10px band of alpha=1 straddling the seam: nobody can see it, and it
    // must not fail a build. Lowering alphaThreshold brings it back.
    const img = blank(64, 32);
    paintRect(img, 6, 8, 18, 16, OUTLINE);
    paintRect(img, 38, 8, 18, 16, OUTLINE);
    paintRect(img, 31, 10, 2, 10, [10, 10, 10, 1]);
    const defaults = lintSheet({ source: "faint.png", image: img, cols: 2, rows: 1 });
    expect(findingsFor(defaults, "frame-bleed")).toHaveLength(0);

    const strict = lintSheet({
      source: "faint.png",
      image: img,
      cols: 2,
      rows: 1,
      config: { rules: { "frame-bleed": { alphaThreshold: 0 } } },
    });
    expect(findingsFor(strict, "frame-bleed")).toHaveLength(1);
    expect(findingsFor(strict, "frame-bleed")[0].data).toMatchObject({ alphaThreshold: 0 });
  });

  it("still reports a visible half-transparent crossing at the default threshold", () => {
    const img = blank(64, 32);
    paintRect(img, 6, 8, 18, 16, OUTLINE);
    paintRect(img, 38, 8, 18, 16, OUTLINE);
    paintRect(img, 31, 10, 2, 10, [10, 10, 10, 128]);
    const report = lintSheet({ source: "half.png", image: img, cols: 2, rows: 1 });
    expect(findingsFor(report, "frame-bleed")).toHaveLength(1);
  });
});

describe("pivot-drift", () => {
  it("fires on the one frame whose content pivot jumps", () => {
    const report = lintSheet({
      source: "pivot.png",
      image: pivotDriftSheet(),
      cols: 4,
      rows: 1,
    });
    const found = findingsFor(report, "pivot-drift");
    expect(found).toHaveLength(1);
    // Info, not a warning: an airborne jump frame is indistinguishable from a
    // mis-anchored one, so the rule reports and leaves the call to the caller.
    expect(found[0].severity).toBe("info");
    expect(found[0].frame).toBe(2);
    expect(found[0].cell).toEqual({ row: 0, col: 2 });
    // bottom-center of the content bounds, in sheet coords: cell 2 starts at
    // x=64, and bottom-center of an 8x8 box at (8, 2) is (8 + 4, 2 + 7).
    expect(found[0].at).toEqual({ x: 64 + 12, y: 9 });
    expect(found[0].region).toEqual({ x: 64 + 8, y: 2, width: 8, height: 8 });
    expect(found[0].data).toMatchObject({ preset: "bottom-center", axis: "y", medianY: 23 });
  });

  it("stays quiet when every frame anchors the same way", () => {
    const img = blank(128, 32);
    for (let i = 0; i < 4; i++) paintRect(img, i * 32 + 8, 16, 8, 8, OUTLINE);
    const report = lintSheet({ source: "steady.png", image: img, cols: 4, rows: 1 });
    expect(findingsFor(report, "pivot-drift")).toHaveLength(0);
  });

  it("skips when there are too few non-empty frames to judge", () => {
    const report = lintSheet({
      source: "pair.png",
      image: duplicateFramesSheet(),
      cols: 2,
      rows: 1,
    });
    expect(skipReason(report, "pivot-drift")).toMatch(/at least 3/);
  });

  it("promotes to a warning when the caller says the sheet holds no excursions", () => {
    const report = lintSheet({
      source: "pivot.png",
      image: pivotDriftSheet(),
      cols: 4,
      rows: 1,
      config: { rules: { "pivot-drift": { severity: "warning" } } },
    });
    expect(findingsFor(report, "pivot-drift")[0].severity).toBe("warning");
    expect(report.summary.warnings).toBe(1);
  });

  it("names an unrecognised preset instead of throwing inside the preset table", () => {
    const report = lintSheet({
      source: "pivot.png",
      image: pivotDriftSheet(),
      cols: 4,
      rows: 1,
      // Deliberately outside PivotPresetId: this is what an unchecked caller can send.
      config: {
        rules: { "pivot-drift": { preset: "middle" } },
      } as unknown as DeepPartial<LintConfig>,
    });
    expect(skipReason(report, "pivot-drift")).toMatch(/unknown preset "middle"/);
    expect(skipReason(report, "pivot-drift")).not.toMatch(/threw/);
  });

  it("survives a minFrames low enough to leave a frame with no neighbour", () => {
    const report = lintSheet({
      source: "single.png",
      image: cleanSprite(),
      cols: 1,
      rows: 1,
      config: { rules: { "pivot-drift": { minFrames: 1 } } },
    });
    expect(skipReason(report, "pivot-drift")).toBeUndefined();
    expect(findingsFor(report, "pivot-drift")).toHaveLength(0);
  });
});

describe("duplicate-frames", () => {
  it("fires once on an identical pair, anchored on the earlier frame", () => {
    const report = lintSheet({
      source: "dupes.png",
      image: duplicateFramesSheet(),
      cols: 2,
      rows: 1,
    });
    const found = findingsFor(report, "duplicate-frames");
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe("info");
    // The group's representative is its lowest member, so the region is cell 0.
    expect(found[0].frame).toBe(0);
    expect(found[0].region).toEqual({ x: 0, y: 0, width: 32, height: 32 });
    expect(found[0].message).toMatch(/^Frame 1 duplicates frame 0:/);
    expect(found[0].message).toContain("`sprite-tools dedupe`");
    expect(found[0].data).toMatchObject({
      duplicateOf: 0,
      memberFrames: [0, 1],
      duplicateFrames: [1],
      groupSize: 2,
      maxDistance: 0,
      threshold: 0,
      method: "exact",
      totalGroups: 1,
      reportedGroups: 1,
    });
  });

  it("agrees exactly with the dedupe core it delegates to", () => {
    const img = blank(32 * 6, 32);
    for (const i of [0, 2, 5]) paintRect(img, i * 32 + 8, 8, 16, 16, OUTLINE);
    for (const i of [1, 4]) paintRect(img, i * 32 + 4, 4, 20, 8, MARK);
    paintRect(img, 3 * 32 + 2, 2, 6, 6, MARK); // frame 3 is unique
    const report = lintSheet({ source: "mix.png", image: img, cols: 6, rows: 1 });
    const expected = findDuplicateFrames(sliceSheet(img, 6, 1), { threshold: 0 }).groups;
    const found = findingsFor(report, "duplicate-frames");
    expect(found.map((f) => [f.data.duplicateOf, f.data.duplicateFrames]).sort()).toEqual(
      expected.map((g) => [g.keep, g.duplicates]).sort(),
    );
  });

  it("reports n identical frames as one group, not n-1 pairs", () => {
    const img = blank(32 * 5, 32);
    for (let i = 0; i < 5; i++) paintRect(img, i * 32 + 8, 8, 16, 16, OUTLINE);
    const report = lintSheet({ source: "held.png", image: img, cols: 5, rows: 1 });
    const found = findingsFor(report, "duplicate-frames");
    expect(found).toHaveLength(1);
    expect(found[0].frame).toBe(0);
    expect(found[0].message).toContain("Frames 1-4 duplicate frame 0");
    expect(found[0].data).toMatchObject({
      duplicateOf: 0,
      memberFrames: [0, 1, 2, 3, 4],
      duplicateFrames: [1, 2, 3, 4],
      groupSize: 5,
      totalGroups: 1,
    });
  });

  it("keeps two separate duplicate groups separate", () => {
    const img = blank(32 * 4, 32);
    // Frames 0 and 2 share one silhouette, frames 1 and 3 another.
    for (const i of [0, 2]) paintRect(img, i * 32 + 8, 8, 16, 16, OUTLINE);
    for (const i of [1, 3]) paintRect(img, i * 32 + 4, 4, 20, 8, MARK);
    const report = lintSheet({ source: "two-groups.png", image: img, cols: 4, rows: 1 });
    const found = findingsFor(report, "duplicate-frames");
    expect(found).toHaveLength(2);
    expect(found.map((f) => f.frame)).toEqual([0, 1]);
    expect(found[0].data).toMatchObject({ memberFrames: [0, 2], groupSize: 2, totalGroups: 2 });
    expect(found[1].data).toMatchObject({ memberFrames: [1, 3], groupSize: 2, totalGroups: 2 });
  });

  it("stays exact by default and matches near-duplicates only once threshold is raised", () => {
    const img = blank(32 * 2, 32);
    paintRect(img, 8, 8, 16, 16, OUTLINE);
    paintRect(img, 32 + 8, 8, 16, 16, OUTLINE);
    setPixel(img, 32 + 12, 12, [OUTLINE[0] - 40, OUTLINE[1], OUTLINE[2], 255]); // one pixel off
    const exact = lintSheet({ source: "near.png", image: img, cols: 2, rows: 1 });
    expect(findingsFor(exact, "duplicate-frames")).toEqual([]);

    const fuzzy = lintSheet({
      source: "near.png",
      image: img,
      cols: 2,
      rows: 1,
      config: { rules: { "duplicate-frames": { threshold: 1 } } },
    });
    const found = findingsFor(fuzzy, "duplicate-frames");
    expect(found).toHaveLength(1);
    expect(found[0].data).toMatchObject({ method: "mae", threshold: 1 });
    expect(found[0].data.maxDistance as number).toBeGreaterThan(0);
    expect(found[0].message).toContain("`sprite-tools dedupe --threshold 1`");
  });

  it("never groups empty cells as duplicates of each other", () => {
    const img = blank(32 * 4, 32);
    paintRect(img, 8, 8, 16, 16, OUTLINE);
    paintRect(img, 32 + 4, 4, 20, 8, MARK);
    const report = lintSheet({ source: "padding.png", image: img, cols: 4, rows: 1 });
    expect(findingsFor(report, "duplicate-frames")).toEqual([]);
  });

  it("caps the reported groups but keeps the true total in the data", () => {
    const img = blank(32 * 4, 32);
    for (const i of [0, 2]) paintRect(img, i * 32 + 8, 8, 16, 16, OUTLINE);
    for (const i of [1, 3]) paintRect(img, i * 32 + 4, 4, 20, 8, MARK);
    const report = lintSheet({
      source: "capped.png",
      image: img,
      cols: 4,
      rows: 1,
      config: { rules: { "duplicate-frames": { maxGroupsReported: 1 } } },
    });
    const found = findingsFor(report, "duplicate-frames");
    expect(found).toHaveLength(1);
    expect(found[0].data).toMatchObject({ totalGroups: 2, reportedGroups: 1 });
  });

  it("budgets the fuzzy pass but never the exact one", () => {
    const budget = { maxComparisonPixels: 1000 };
    const exact = lintSheet({
      source: "pair.png",
      image: duplicateFramesSheet(),
      cols: 2,
      rows: 1,
      config: { rules: { "duplicate-frames": budget } },
    });
    expect(findingsFor(exact, "duplicate-frames")).toHaveLength(1);

    const fuzzy = lintSheet({
      source: "pair.png",
      image: duplicateFramesSheet(),
      cols: 2,
      rows: 1,
      config: { rules: { "duplicate-frames": { ...budget, threshold: 1 } } },
    });
    expect(findingsFor(fuzzy, "duplicate-frames")).toHaveLength(0);
    expect(skipReason(fuzzy, "duplicate-frames")).toMatch(/maxComparisonPixels budget of 1000/);
  });
});

describe("empty-cell", () => {
  it("reports the undrawn last cell of a 2x2 grid as trailing padding", () => {
    const report = lintSheet({
      source: "empty.png",
      image: emptyCellSheet(),
      cols: 2,
      rows: 2,
    });
    const found = findingsFor(report, "empty-cell");
    expect(found).toHaveLength(1);
    // Nothing follows it, so it is three frames laid into four cells, not a
    // hole: reported at paddingSeverity rather than as a warning.
    expect(found[0].severity).toBe("info");
    expect(found[0].frame).toBe(3);
    expect(found[0].cell).toEqual({ row: 1, col: 1 });
    expect(found[0].region).toEqual({ x: 32, y: 32, width: 32, height: 32 });
    expect(found[0].data).toMatchObject({
      coverage: 0,
      opaquePixels: 0,
      trailingPadding: true,
      lastDrawnFrame: 2,
    });
  });

  it("keeps an empty cell with content after it a warning", () => {
    // A 10-frame walk would be padding; a hole in the middle of the strip is a
    // slicing mistake, and the two must not read the same.
    const img = blank(128, 32);
    for (const i of [0, 2, 3]) paintRect(img, i * 32 + 8, 8, 16, 16, OUTLINE);
    const report = lintSheet({ source: "hole.png", image: img, cols: 4, rows: 1 });
    const found = findingsFor(report, "empty-cell");
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe("warning");
    expect(found[0].frame).toBe(1);
    expect(found[0].data).toMatchObject({ trailingPadding: false, lastDrawnFrame: 3 });
    expect(report.summary.warnings).toBe(1);
  });

  it("reports a run of packer padding once per cell, all at info", () => {
    // 10 frames laid into a 4x3 grid: the last two cells are unused by
    // construction, which is the universal packer layout, not a defect.
    const img = blank(128, 96);
    for (let i = 0; i < 10; i++) {
      paintRect(img, (i % 4) * 32 + 8, Math.floor(i / 4) * 32 + 8, 16, 16, OUTLINE);
    }
    const report = lintSheet({ source: "walk.png", image: img, cols: 4, rows: 3 });
    const found = findingsFor(report, "empty-cell");
    expect(found.map((f) => f.frame)).toEqual([10, 11]);
    expect(found.every((f) => f.severity === "info")).toBe(true);
    expect(report.summary.warnings).toBe(0);
    expect(found[0].message).toMatch(/trailing padding/);
  });

  it("reports a wholly blank sheet once, not once per cell", () => {
    const report = lintSheet({ source: "blank.png", image: blank(64, 64), cols: 4, rows: 4 });
    const found = findingsFor(report, "empty-cell");
    expect(found).toHaveLength(1);
    expect(found[0].frame).toBeNull();
    expect(found[0].cell).toBeNull();
    expect(found[0].region).toEqual({ x: 0, y: 0, width: 64, height: 64 });
  });

  it("reports a near-empty cell at the softer nearEmptySeverity", () => {
    const img = blank(64, 32);
    // Frame 0 is dense; frame 1 holds a single 2x2 speck (4/1024 = 0.4%).
    paintRect(img, 2, 2, 28, 28, OUTLINE);
    paintRect(img, 40, 10, 2, 2, OUTLINE);
    const report = lintSheet({ source: "sparse.png", image: img, cols: 2, rows: 1 });
    const found = findingsFor(report, "empty-cell");
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe("info");
    expect(found[0].frame).toBe(1);
    expect(found[0].data.opaquePixels).toBe(4);
  });
});

describe("opaque-frame", () => {
  it("fires on the un-keyed frame of a mixed sheet", () => {
    const report = lintSheet({
      source: "opaque.png",
      image: opaqueFrameSheet(),
      cols: 2,
      rows: 1,
    });
    const found = findingsFor(report, "opaque-frame");
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe("warning");
    expect(found[0].frame).toBe(0);
    expect(found[0].region).toEqual({ x: 0, y: 0, width: 32, height: 32 });
    expect(found[0].data).toMatchObject({ frameCount: 2, transparentFrames: 1, opaqueFrames: 1 });
  });

  it("leaves a fully opaque tileset alone", () => {
    const img = blank(64, 32);
    fillAll(img, MARK);
    paintRect(img, 32, 0, 32, 32, OUTLINE);
    const report = lintSheet({ source: "tiles.png", image: img, cols: 2, rows: 1 });
    expect(findingsFor(report, "opaque-frame")).toHaveLength(0);
    expect(skipReason(report, "opaque-frame")).toMatch(/tileset/);
  });

  it("still reads a mostly opaque tileset with one keyed decal tile as a tileset", () => {
    // 15 solid terrain tiles plus one transparent decal — the ordinary tileset,
    // and the case an absolute one-frame minimum turned into 15 warnings.
    const img = blank(64, 64);
    fillAll(img, MARK);
    paintRect(img, 48, 48, 16, 16, CLEAR);
    paintRect(img, 54, 54, 4, 4, OUTLINE);
    const report = lintSheet({ source: "decal.png", image: img, cols: 4, rows: 4 });
    expect(findingsFor(report, "opaque-frame")).toHaveLength(0);
    expect(skipReason(report, "opaque-frame")).toMatch(
      /mostly opaque sheet is a legitimate tileset/,
    );
  });
});

describe("non-power-of-two", () => {
  it("reports the sheet size as info and names the next power of two", () => {
    const report = lintSheet({
      source: "npot.png",
      image: nonPowerOfTwoSprite(),
      cols: 1,
      rows: 1,
    });
    const found = findingsFor(report, "non-power-of-two");
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe("info");
    expect(found[0].frame).toBeNull();
    expect(found[0].data).toMatchObject({
      width: 100,
      height: 100,
      nextPowerOfTwoWidth: 128,
      nextPowerOfTwoHeight: 128,
      scope: "sheet",
    });
    expect(found[0].message).toMatch(/WebGL/);
    expect(report.summary.errors).toBe(0);
  });

  it("adds a frame-scoped finding only when checkFrames is on", () => {
    const img = blank(128, 128);
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) paintRect(img, c * 42 + 8, r * 42 + 8, 20, 20, OUTLINE);
    }
    const base = { source: "frames.png", image: img, cols: 3, rows: 3 };
    const off = lintSheet(base);
    expect(findingsFor(off, "non-power-of-two")).toHaveLength(0);
    const on = lintSheet({
      ...base,
      config: { rules: { "non-power-of-two": { checkFrames: true } } },
    });
    const found = findingsFor(on, "non-power-of-two");
    expect(found).toHaveLength(1);
    expect(found[0].data).toMatchObject({ scope: "frame", frameWidth: 42, frameHeight: 42 });
  });
});

describe("palette-bloat", () => {
  it("fires when hundreds of colours collapse onto a tiny palette", () => {
    const report = lintSheet({
      source: "bloat.png",
      image: paletteBloatSheet(),
      cols: 1,
      rows: 1,
    });
    const found = findingsFor(report, "palette-bloat");
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe("info");
    expect(found[0].frame).toBeNull();
    expect(found[0].data.distinctColors).toBe(256);
    expect(found[0].data.meanQuantizationError as number).toBeLessThan(4);
  });

  it("skips a sheet with too few colours to be bloated", () => {
    const report = lintSheet({ source: "clean.png", image: cleanSheet(), cols: 4, rows: 4 });
    expect(skipReason(report, "palette-bloat")).toMatch(/below the 256 minimum/);
  });
});

describe("palette-near-duplicates", () => {
  it("fires on two colours a single value apart", () => {
    const report = lintSheet({
      source: "dupes.png",
      image: nearDuplicateSprite(),
      cols: 1,
      rows: 1,
    });
    const found = findingsFor(report, "palette-near-duplicates");
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe("info");
    expect(found[0].frame).toBeNull();
    // `at` points at the rarer of the two colours — the one to go looking for.
    expect(found[0].at).toEqual({ x: 24, y: 0 });
    expect(found[0].data).toMatchObject({
      colorA: "#646464",
      colorB: "#656464",
      pixelsA: 768,
      pixelsB: 256,
      distance: 1,
      totalPairs: 1,
    });
    expect(found[0].data).toMatchObject({
      pairColorsA: ["#646464"],
      pairColorsB: ["#656464"],
      pairDistances: [1],
    });
    expect(found[0].message).toMatch(/encoding noise/);
  });

  it("reports one sheet-wide finding however many pairs there are", () => {
    const report = lintSheet({
      source: "bloat.png",
      image: paletteBloatSheet(),
      cols: 1,
      rows: 1,
    });
    const found = findingsFor(report, "palette-near-duplicates");
    expect(found).toHaveLength(1);
    const data = found[0].data;
    const total = data.totalPairs as number;
    const listed = data.pairColorsA as string[];
    // The fixture has more pairs than the default cap, so the cap is exercised.
    expect(total).toBeGreaterThan(20);
    expect(listed).toHaveLength(20);
    expect(data.reportedPairs).toBe(20);
    for (const column of ["pairColorsB", "pairDistances", "pairPixelsA", "pairPixelsB"]) {
      expect(data[column]).toHaveLength(20);
    }
  });

  it("skips a single-colour sheet", () => {
    const img = blank(32, 32);
    paintRect(img, 4, 4, 24, 24, OUTLINE);
    const report = lintSheet({ source: "mono.png", image: img, cols: 1, rows: 1 });
    expect(skipReason(report, "palette-near-duplicates")).toMatch(/nothing to pair up/);
  });
});

// -----------------------------------------------------------------
// 4. Config
// -----------------------------------------------------------------

describe("lint config", () => {
  it("suppresses a rule entirely when it is disabled", () => {
    const base = { source: "bleed.png", image: frameBleedSheet(11), cols: 2, rows: 1 };
    expect(findingsFor(lintSheet(base), "frame-bleed")).toHaveLength(1);

    const report = lintSheet({
      ...base,
      config: { rules: { "frame-bleed": { enabled: false } } },
    });
    expect(findingsFor(report, "frame-bleed")).toHaveLength(0);
    // A disabled rule was never asked to judge, so it appears in neither list.
    expect(report.summary.rulesRun).not.toContain("frame-bleed");
    expect(report.summary.rulesSkipped.map((s) => s.rule)).not.toContain("frame-bleed");
    expect(report.summary.errors).toBe(0);
  });

  it("emits the overridden severity and counts it there", () => {
    const report = lintSheet({
      source: "bleed.png",
      image: frameBleedSheet(11),
      cols: 2,
      rows: 1,
      config: { rules: { "frame-bleed": { severity: "warning" } } },
    });
    const found = findingsFor(report, "frame-bleed");
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe("warning");
    expect(report.summary.errors).toBe(0);
    expect(report.summary.warnings).toBeGreaterThanOrEqual(1);
  });

  it("changes whether a borderline case fires when a threshold moves", () => {
    // A 3px run is exactly minRunLength, and 3/32 clears minRunFraction.
    const borderline = { source: "bleed.png", image: frameBleedSheet(3), cols: 2, rows: 1 };
    expect(findingsFor(lintSheet(borderline), "frame-bleed")).toHaveLength(1);

    const stricter = lintSheet({
      ...borderline,
      config: { rules: { "frame-bleed": { minRunLength: 4 } } },
    });
    expect(findingsFor(stricter, "frame-bleed")).toHaveLength(0);

    const looser = lintSheet({
      source: "bleed.png",
      image: frameBleedSheet(2),
      cols: 2,
      rows: 1,
      config: { rules: { "frame-bleed": { minRunLength: 2 } } },
    });
    expect(findingsFor(looser, "frame-bleed")).toHaveLength(1);
  });

  it("merges per field, leaving the rule's other thresholds at their defaults", () => {
    const config = resolveLintConfig({ rules: { "frame-bleed": { minRunLength: 9 } } });
    expect(config.rules["frame-bleed"].minRunLength).toBe(9);
    expect(config.rules["frame-bleed"].minRunFraction).toBe(
      DEFAULT_LINT_CONFIG.rules["frame-bleed"].minRunFraction,
    );
    expect(config.rules["empty-cell"]).toEqual(DEFAULT_LINT_CONFIG.rules["empty-cell"]);
  });

  it("never mutates the frozen defaults", () => {
    const config = resolveLintConfig({ rules: { "empty-cell": { enabled: false } } });
    config.rules["empty-cell"].enabled = true;
    expect(DEFAULT_LINT_CONFIG.rules["empty-cell"].enabled).toBe(true);
    expect(Object.isFrozen(DEFAULT_LINT_CONFIG.rules)).toBe(true);
  });

  it("ignores unknown rule ids, unknown options and undefined values", () => {
    const junk = {
      rules: {
        "no-such-rule": { enabled: false },
        "empty-cell": { thresholdFromTheFuture: 42, severity: undefined },
        "frame-bleed": null,
      },
    } as unknown as DeepPartial<LintConfig>;

    const image = emptyCellSheet();
    const plain = lintSheet({ source: "empty.png", image, cols: 2, rows: 2 });
    const patched = lintSheet({ source: "empty.png", image, cols: 2, rows: 2, config: junk });
    expect(patched.findings).toEqual(plain.findings);
    expect(patched.summary.rulesRun).toEqual(plain.summary.rulesRun);
    expect(resolveLintConfig(junk).rules["empty-cell"].severity).toBe("warning");
  });

  it("maps a --disable style id list through isRuleId", () => {
    expect(RULE_IDS.every(isRuleId)).toBe(true);
    expect(isRuleId("frame-bleed")).toBe(true);
    expect(isRuleId("frame-bleeed")).toBe(false);
  });
});

describe("validateRuleOption", () => {
  it("accepts every rule's own defaults", () => {
    for (const id of RULE_IDS) {
      const defaults = DEFAULT_LINT_CONFIG.rules[id] as Record<string, unknown>;
      for (const option of ruleOptionNames(id)) {
        expect(validateRuleOption(id, option, defaults[option])).toBeNull();
      }
    }
  });

  it("rejects an unknown option name and lists the valid ones", () => {
    const problem = validateRuleOption("alpha-fringe", "minPixel", 40);
    expect(problem).toMatch(/unknown option "minPixel"/);
    expect(problem).toMatch(/minPixels/);
  });

  it("rejects a value of the wrong type, which would invert a gate", () => {
    // `contrastRatio < "ten"` is false for every ratio, so an unchecked string
    // does not disable the threshold — it turns it inside out.
    expect(validateRuleOption("empty-cell", "contrastFactor", "ten")).toMatch(/expects a number/);
    expect(validateRuleOption("non-power-of-two", "checkFrames", 1)).toMatch(/expects a boolean/);
    expect(validateRuleOption("empty-cell", "contrastFactor", Number.NaN)).toMatch(/finite/);
  });

  it("holds severities and pivot presets to their closed sets", () => {
    expect(validateRuleOption("non-power-of-two", "severity", "Error")).toMatch(
      /error\|warning\|info/,
    );
    expect(validateRuleOption("empty-cell", "nearEmptySeverity", "quiet")).toBeTruthy();
    expect(validateRuleOption("empty-cell", "paddingSeverity", "info")).toBeNull();
    expect(validateRuleOption("pivot-drift", "preset", "middle")).toMatch(/bottom-center/);
    expect(validateRuleOption("pivot-drift", "preset", "top-left")).toBeNull();
  });
});

describe("grid provenance", () => {
  it("reports a detected grid with its confidence", () => {
    const report = lintSheet({ source: "clean", image: cleanSheet() });
    expect(report.grid.detected).toBe(true);
    expect(report.grid.confidence).toBeGreaterThan(0);
  });

  it("reports a caller-supplied grid as not detected", () => {
    const report = lintSheet({ source: "clean", image: cleanSheet(), cols: 4, rows: 4 });
    expect(report.grid).toEqual({
      cols: 4,
      rows: 4,
      detected: false,
      confidence: null,
      margin: { left: 0, top: 0, right: 0, bottom: 0 },
      spacing: { x: 0, y: 0 },
    });
  });

  it("reports a half-explicit grid as the caller's, not as a detection", () => {
    // Detection still fills the missing rows, but the confidence it produced
    // describes the grid the caller just overrode — frame-bleed gates its
    // error-severity findings on that number, so it must not be reported here.
    const report = lintSheet({ source: "clean", image: cleanSheet(), cols: 2 });
    expect(report.grid.cols).toBe(2);
    expect(report.grid.rows).toBeGreaterThan(0);
    expect(report.grid.detected).toBe(false);
    expect(report.grid.confidence).toBeNull();
  });
});

// -----------------------------------------------------------------
// 5. Report invariants
// -----------------------------------------------------------------

/**
 * A 4x4 tileset cut with a 1px margin and 2px gutters: 30px cells on a 128px
 * sheet, each cell a different healthy sprite well inside its own bounds.
 */
const PAD = { margin: 1, spacing: 2 };
const PAD_CELL = 30;
function paddedCleanSheet(): ImageData {
  const img = blank(128, 128);
  for (let i = 0; i < 16; i++) {
    const ox = 1 + (i % 4) * (PAD_CELL + 2);
    const oy = 1 + Math.floor(i / 4) * (PAD_CELL + 2);
    paintRect(img, ox + 5, oy + 5, 20, 20, OUTLINE);
    paintRect(img, ox + 7, oy + 7, 16, 16, CLEAR);
    paintRect(img, ox + 9 + (i % 4) * 3, oy + 9 + Math.floor(i / 4) * 3, 5, 5, MARK);
  }
  return img;
}

describe("margin and spacing", () => {
  it("lints a clean padded tileset to zero findings and reports the padding it used", () => {
    const report = lintSheet({
      source: "tiles.png",
      image: paddedCleanSheet(),
      cols: 4,
      rows: 4,
      padding: PAD,
    });
    expect(report.findings, JSON.stringify(report.findings, null, 2)).toEqual([]);
    expect(report.frameWidth).toBe(PAD_CELL);
    expect(report.frameHeight).toBe(PAD_CELL);
    expect(report.grid).toMatchObject({
      margin: { left: 1, top: 1, right: 1, bottom: 1 },
      spacing: { x: 2, y: 2 },
    });
  });

  it("reports zero padding on a flush sheet", () => {
    const report = lintSheet({ source: "clean.png", image: cleanSheet(), cols: 4, rows: 4 });
    expect(report.grid.margin).toEqual({ left: 0, top: 0, right: 0, bottom: 0 });
    expect(report.grid.spacing).toEqual({ x: 0, y: 0 });
  });

  it("places sheet-absolute coordinates on the padded cut lines", () => {
    const img = paddedCleanSheet();
    // Wipe frame 5 (row 1, col 1) so empty-cell reports exactly that cell.
    paintRect(img, 1 + 32, 1 + 32, PAD_CELL, PAD_CELL, [0, 0, 0, 0]);
    const report = lintSheet({ source: "hole.png", image: img, cols: 4, rows: 4, padding: PAD });
    const found = report.findings.filter((f) => f.rule === "empty-cell");
    expect(found).toHaveLength(1);
    expect(found[0].frame).toBe(5);
    expect(found[0].region).toEqual({ x: 33, y: 33, width: PAD_CELL, height: PAD_CELL });
  });

  it("counts a bar that crosses the gutter from one cell into the next as bleed", () => {
    const img = paddedCleanSheet();
    // Frame 0 spans x 1..30, the gutter x 31..32, frame 1 starts at x 33.
    paintRect(img, 20, 12, 20, 6, OUTLINE);
    const report = lintSheet({ source: "bleed.png", image: img, cols: 4, rows: 4, padding: PAD });
    const found = report.findings.filter((f) => f.rule === "frame-bleed");
    expect(found).toHaveLength(1);
    expect(found[0].frame).toBe(0);
    expect(found[0].region).toEqual({ x: 30, y: 12, width: 4, height: 6 });
  });

  it("judges seams on an all-opaque tileset once there is a gutter to cross", () => {
    // Solid 30px tiles: the no-gutter tileset guard would skip this sheet, but
    // the transparent gutter makes a crossing unambiguous.
    const img = blank(128, 128);
    for (let i = 0; i < 16; i++) {
      paintRect(img, 1 + (i % 4) * 32, 1 + Math.floor(i / 4) * 32, PAD_CELL, PAD_CELL, MARK);
    }
    const healthy = lintSheet({ source: "tiles.png", image: img, cols: 4, rows: 4, padding: PAD });
    expect(healthy.findings.filter((f) => f.rule === "frame-bleed")).toEqual([]);
    expect(healthy.summary.rulesSkipped.map((s) => s.rule)).not.toContain("frame-bleed");

    paintRect(img, 28, 12, 8, 6, OUTLINE);
    const bled = lintSheet({ source: "tiles.png", image: img, cols: 4, rows: 4, padding: PAD });
    expect(bled.findings.filter((f) => f.rule === "frame-bleed")).toHaveLength(1);
  });

  it("does not count content that stops inside the gutter", () => {
    const img = paddedCleanSheet();
    paintRect(img, 20, 12, 12, 6, OUTLINE); // reaches x 31, never x 33
    const report = lintSheet({ source: "gutter.png", image: img, cols: 4, rows: 4, padding: PAD });
    expect(report.findings.filter((f) => f.rule === "frame-bleed")).toEqual([]);
  });

  it("throws the pipeline's fit error when stated padding does not tile the sheet", () => {
    expect(() =>
      lintSheet({
        source: "tiles.png",
        image: paddedCleanSheet(),
        cols: 4,
        rows: 4,
        padding: { margin: 1, spacing: 3 },
      }),
    ).toThrow(/grid does not fit/);
  });
});

describe("report invariants", () => {
  const reports: Array<{ label: string; report: LintReport }> = [
    { label: "clean sheet", report: lintSheet({ source: "clean", image: cleanSheet() }) },
    {
      label: "fringe",
      report: lintSheet({ source: "fringe", image: alphaFringeSprite(), cols: 1, rows: 1 }),
    },
    {
      label: "bleed",
      report: lintSheet({ source: "bleed", image: frameBleedSheet(11), cols: 2, rows: 1 }),
    },
    {
      label: "pivot",
      report: lintSheet({ source: "pivot", image: pivotDriftSheet(), cols: 4, rows: 1 }),
    },
    {
      label: "empty",
      report: lintSheet({ source: "empty", image: emptyCellSheet(), cols: 2, rows: 2 }),
    },
    {
      label: "opaque",
      report: lintSheet({ source: "opaque", image: opaqueFrameSheet(), cols: 2, rows: 1 }),
    },
    {
      label: "npot",
      report: lintSheet({ source: "npot", image: nonPowerOfTwoSprite(), cols: 1, rows: 1 }),
    },
    {
      label: "bloat",
      report: lintSheet({ source: "bloat", image: paletteBloatSheet(), cols: 1, rows: 1 }),
    },
    ...SAMPLES.map((name) => ({
      label: name,
      report: lintSheet({ source: name, image: loadSample(name) }),
    })),
  ];

  for (const { label, report } of reports) {
    describe(label, () => {
      it("sorts findings by severity, then rule id, then frame", () => {
        const key = (f: Finding) => [
          { error: 0, warning: 1, info: 2 }[f.severity],
          f.rule,
          f.frame ?? -1,
        ];
        for (let i = 1; i < report.findings.length; i++) {
          const [ps, pr, pf] = key(report.findings[i - 1]);
          const [cs, cr, cf] = key(report.findings[i]);
          const ordered = ps < cs || (ps === cs && (pr < cr || (pr === cr && pf <= cf)));
          expect(ordered, `${describeFindings(report.findings.slice(i - 1, i + 1))}`).toBe(true);
        }
      });

      it("has summary counts matching the findings array", () => {
        const count = (s: string) => report.findings.filter((f) => f.severity === s).length;
        expect(report.summary.errors).toBe(count("error"));
        expect(report.summary.warnings).toBe(count("warning"));
        expect(report.summary.infos).toBe(count("info"));
        expect(report.summary.errors + report.summary.warnings + report.summary.infos).toBe(
          report.findings.length,
        );
        expect(report.summary.frameCount).toBe(report.grid.cols * report.grid.rows);
      });

      it("keeps every at/region inside the sheet", () => {
        for (const f of report.findings) {
          if (f.at) {
            expect(f.at.x).toBeGreaterThanOrEqual(0);
            expect(f.at.y).toBeGreaterThanOrEqual(0);
            expect(f.at.x).toBeLessThan(report.width);
            expect(f.at.y).toBeLessThan(report.height);
          }
          if (f.region) {
            expect(f.region.width).toBeGreaterThan(0);
            expect(f.region.height).toBeGreaterThan(0);
            expect(f.region.x).toBeGreaterThanOrEqual(0);
            expect(f.region.y).toBeGreaterThanOrEqual(0);
            expect(f.region.x + f.region.width).toBeLessThanOrEqual(report.width);
            expect(f.region.y + f.region.height).toBeLessThanOrEqual(report.height);
          }
          if (f.frame !== null) {
            expect(f.frame).toBeLessThan(report.summary.frameCount);
            expect(f.cell).toEqual({
              row: Math.floor(f.frame / report.grid.cols),
              col: f.frame % report.grid.cols,
            });
          }
        }
      });

      it("runs every rule id exactly once, and skips only rules that ran", () => {
        // rulesSkipped is a subset of rulesRun: a rule runs, evaluates its
        // preconditions, and records why it had nothing to say.
        expect([...report.summary.rulesRun].sort()).toEqual([...RULE_IDS].sort());
        const skipped = report.summary.rulesSkipped.map((s) => s.rule);
        expect(new Set(skipped).size).toBe(skipped.length);
        for (const s of report.summary.rulesSkipped) {
          expect(report.summary.rulesRun).toContain(s.rule);
          expect(s.reason.length).toBeGreaterThan(0);
        }
      });

      it("never emits a finding for a rule that skipped", () => {
        for (const s of report.summary.rulesSkipped) {
          expect(findingsFor(report, s.rule)).toHaveLength(0);
        }
      });

      it("describes the sheet it was given", () => {
        expect(report.frameWidth).toBe(Math.floor(report.width / report.grid.cols));
        expect(report.frameHeight).toBe(Math.floor(report.height / report.grid.rows));
      });
    });
  }
});
