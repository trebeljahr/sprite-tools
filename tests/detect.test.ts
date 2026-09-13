import { describe, it, expect } from "vitest";
import { detectGridFromImageData } from "@/lib/pipeline/detect";
import { cellRect, computeCellGeometry } from "@/lib/pipeline/grid";
import { blank, circleSheet, filledRect, paddedSheet } from "./helpers";

describe("detectGridFromImageData", () => {
  it("returns low confidence on a blank image", () => {
    const det = detectGridFromImageData(blank(64, 64));
    // Blank images have no real periodic structure; we don't care what
    // grid the fallback heuristic picks, only that confidence is low
    // enough to flag it as a guess.
    expect(det.confidence).toBeLessThanOrEqual(0.5);
  });

  it("detects a clean 2x2 sheet", () => {
    const img = circleSheet(2, 2, 32, 12);
    const det = detectGridFromImageData(img);
    expect(det.cols).toBe(2);
    expect(det.rows).toBe(2);
  });

  it("detects a 5x5 sheet", () => {
    const img = circleSheet(5, 5, 40, 14);
    const det = detectGridFromImageData(img);
    expect(det.cols).toBe(5);
    expect(det.rows).toBe(5);
  });

  it("detects a non-square 3x4 sheet", () => {
    const img = circleSheet(3, 4, 32, 12);
    const det = detectGridFromImageData(img);
    expect(det.cols).toBe(3);
    expect(det.rows).toBe(4);
  });

  it("handles a sprite with multi-part content (pterodactyl-style internal gaps)", () => {
    // 5x5 of 40px cells, each with three horizontally-separated blobs and a
    // narrow body — this is the class of sheet that broke the old detector.
    const W = 200;
    const H = 200;
    const img = new ImageData(W, H);
    const paint = (x: number, y: number, w: number, h: number) => {
      for (let yy = 0; yy < h; yy++) {
        for (let xx = 0; xx < w; xx++) {
          const i = ((y + yy) * W + (x + xx)) * 4;
          img.data[i] = 255;
          img.data[i + 3] = 255;
        }
      }
    };
    for (let r = 0; r < 5; r++) {
      for (let c = 0; c < 5; c++) {
        const cx = c * 40 + 20;
        const cy = r * 40 + 20;
        paint(cx - 18, cy - 2, 6, 4); // left wing tip
        paint(cx + 12, cy - 2, 6, 4); // right wing tip
        paint(cx - 2, cy - 4, 4, 8); // body
      }
    }
    const det = detectGridFromImageData(img);
    expect(det.cols).toBe(5);
    expect(det.rows).toBe(5);
  });

  it("never returns cells > 32", () => {
    // Near-empty image with one corner opaque.
    const img = filledRect(256, 256, 0, 0, 8, 8);
    const det = detectGridFromImageData(img);
    expect(det.cols).toBeLessThanOrEqual(32);
    expect(det.rows).toBeLessThanOrEqual(32);
  });
});

describe("detectGridFromImageData — margin and spacing", () => {
  it("recovers exact margin and spacing from a padded sheet", () => {
    // 6x4 of 32px cells, margin 3, spacing 2 => 208x140. 208 % 6 !== 0, so a
    // flush slice of this sheet genuinely bleeds neighbours — this is the shape
    // the whole padding feature exists for.
    const img = paddedSheet({ cols: 6, rows: 4, cellW: 32, cellH: 32, margin: 3, spacing: 2 });
    expect([img.width, img.height]).toEqual([208, 140]);

    const det = detectGridFromImageData(img);
    expect(det.cols).toBe(6);
    expect(det.rows).toBe(4);
    expect(det.margin).toEqual({ left: 3, right: 3, top: 3, bottom: 3 });
    expect(det.spacing).toEqual({ x: 2, y: 2 });
  });

  it("reports an asymmetric border per-side", () => {
    // left 5 + 6*32 + 5*2 + right 1 = 208. A symmetric marginX model cannot
    // express this sheet; the four-sided one can.
    const img = paddedSheet({
      cols: 6,
      rows: 4,
      cellW: 32,
      cellH: 32,
      margin: { left: 5, right: 1, top: 3, bottom: 3 },
      spacing: 2,
    });
    const det = detectGridFromImageData(img);
    expect(det.cols).toBe(6);
    expect(det.rows).toBe(4);
    expect(det.margin.left).toBe(5);
    expect(det.margin.right).toBe(1);
    expect(det.margin.top).toBe(3);
    expect(det.margin.bottom).toBe(3);
  });

  it("detected padding always closes back to the sheet dimensions", () => {
    const img = paddedSheet({ cols: 6, rows: 4, cellW: 32, cellH: 32, margin: 3, spacing: 2 });
    const det = detectGridFromImageData(img);
    const geom = computeCellGeometry(img.width, img.height, det.cols, det.rows, {
      margin: det.margin,
      spacing: det.spacing,
    });
    // The detector must never hand computeCellGeometry a geometry it rejects.
    expect(geom.cellW).toBe(32);
    expect(geom.cellH).toBe(32);
  });
});

describe("detectGridFromImageData — flush sheets stay flush", () => {
  // The single most likely regression in the padding change: reading the empty
  // runs between sprites as gutters. A circle of radius 12 in a 32px cell leaves
  // a 4px lead and 7px interior runs — that is sprite whitespace, not spacing,
  // and reporting it as spacing would re-slice every existing sheet.
  it.each([
    ["2x2 / 32px cells / r12", 2, 2, 32, 12],
    ["5x5 / 40px cells / r14", 5, 5, 40, 14],
    ["3x4 / 32px cells / r12", 3, 4, 32, 12],
  ])("circleSheet %s reports zero margin and zero spacing", (_name, cols, rows, cell, radius) => {
    const det = detectGridFromImageData(circleSheet(cols, rows, cell, radius));
    expect(det.cols).toBe(cols);
    expect(det.rows).toBe(rows);
    expect(det.margin).toEqual({ left: 0, right: 0, top: 0, bottom: 0 });
    expect(det.spacing).toEqual({ x: 0, y: 0 });
  });

  it("a flush sheet whose sprites are inset reports flush, not a fake gutter", () => {
    // 4x4 of 24px cells with a 4px inset: blocks of 16 separated by 8px runs.
    // 16 + 8 === 24 === the flush cell period, so the sheet is indistinguishable
    // from a flush one and must be read as flush.
    const img = paddedSheet({ cols: 4, rows: 4, cellW: 24, cellH: 24, inset: 4 });
    expect([img.width, img.height]).toEqual([96, 96]);
    const det = detectGridFromImageData(img);
    expect(det.margin).toEqual({ left: 0, right: 0, top: 0, bottom: 0 });
    expect(det.spacing).toEqual({ x: 0, y: 0 });
  });

  it("prefers flush when a real gutter is indistinguishable from inset sprites", () => {
    // margin 2 / spacing 4 / 24px cells => 112x112, and 112 / 4 === 28 === 24 + 4.
    // The detector reports flush here. That is the deliberate tiebreak, and it is
    // SAFE: the flush cell strictly contains the true cell, so no neighbour leaks.
    const img = paddedSheet({ cols: 4, rows: 4, cellW: 24, cellH: 24, margin: 2, spacing: 4 });
    expect([img.width, img.height]).toEqual([112, 112]);
    const det = detectGridFromImageData(img);
    expect(det.cols).toBe(4);
    expect(det.rows).toBe(4);
    expect(det.margin).toEqual({ left: 0, right: 0, top: 0, bottom: 0 });
    expect(det.spacing).toEqual({ x: 0, y: 0 });

    // The safety claim, asserted rather than argued: the flush cell for column c
    // covers the true cell for column c and never touches column c±1.
    const flushCell = img.width / det.cols;
    for (let c = 0; c < 4; c++) {
      const trueStart = 2 + c * 28;
      expect(c * flushCell).toBeLessThanOrEqual(trueStart);
      expect((c + 1) * flushCell).toBeGreaterThanOrEqual(trueStart + 24);
    }
  });

  it("every existing fixture keeps its confidence unchanged", () => {
    // Padding inference is a refinement pass; it must not move the numbers the
    // existing tests and the CLI's "detected (low confidence)" warning rely on.
    expect(detectGridFromImageData(blank(64, 64)).confidence).toBeCloseTo(0.4, 10);
    expect(detectGridFromImageData(circleSheet(2, 2, 32, 12)).confidence).toBeCloseTo(0.6, 10);
    expect(detectGridFromImageData(circleSheet(5, 5, 40, 14)).confidence).toBeCloseTo(0.9, 10);
    expect(detectGridFromImageData(circleSheet(3, 4, 32, 12)).confidence).toBeCloseTo(0.9, 10);
    expect(detectGridFromImageData(filledRect(256, 256, 0, 0, 8, 8)).confidence).toBeCloseTo(
      0.6,
      10,
    );
  });
});

describe("detectGridFromImageData — padded sheets with inset sprites", () => {
  it("reads the tight sprite bounds rather than the true grid, and stays self-consistent", () => {
    // Sprites 24px inside 32px cells, on top of margin 3 / spacing 2. The gutter
    // the detector can SEE is 2 + 4 + 4 = 10, and the border it can see is 3 + 4 = 7.
    // There is no way to recover the true 32px cell from pixels alone, so this
    // documents what actually happens: it slices tighter than the true grid,
    // which loses transparent padding but never bleeds a neighbour.
    const img = paddedSheet({
      cols: 6,
      rows: 4,
      cellW: 32,
      cellH: 32,
      margin: 3,
      spacing: 2,
      inset: 4,
    });
    const det = detectGridFromImageData(img);
    expect(det.cols).toBe(6);
    expect(det.rows).toBe(4);
    expect(det.margin).toEqual({ left: 7, right: 7, top: 7, bottom: 7 });
    expect(det.spacing).toEqual({ x: 10, y: 10 });

    // Self-consistency is the property that actually matters: whatever it
    // reports must divide the sheet exactly, and every cell must land on sprite.
    const geom = computeCellGeometry(img.width, img.height, det.cols, det.rows, {
      margin: det.margin,
      spacing: det.spacing,
    });
    expect(geom.cellW).toBe(24);
    expect(geom.cellH).toBe(24);
    for (let r = 0; r < det.rows; r++) {
      for (let c = 0; c < det.cols; c++) {
        const rect = cellRect(geom, c, r);
        // True sprite for this cell starts at margin + inset + c*(cell+spacing).
        expect(rect.x).toBe(3 + 4 + c * 34);
        expect(rect.y).toBe(3 + 4 + r * 34);
      }
    }
  });
});

describe("detectGridFromImageData — axes with a single cell", () => {
  // Found by slicing public/samples/character.png: a lone 64x64 sprite came back
  // as a 1x1 grid with its bounding box reported as margin, which cropped the
  // frame to 49x52. With one cell on an axis there is no gutter to corroborate a
  // border, so that axis must stay flush.
  it("a single sprite with whitespace around it reports no margin", () => {
    const img = filledRect(64, 64, 8, 6, 49, 52);
    const det = detectGridFromImageData(img);
    expect(det.cols).toBe(1);
    expect(det.rows).toBe(1);
    expect(det.margin).toEqual({ left: 0, right: 0, top: 0, bottom: 0 });
    expect(det.spacing).toEqual({ x: 0, y: 0 });
  });

  it("a one-row padded strip infers padding on x only", () => {
    // 6x1 of 32px cells, margin 3, spacing 2 => 208x38. The 3px above and below
    // the strip cannot be told apart from sprite whitespace, so y stays zero.
    const img = paddedSheet({ cols: 6, rows: 1, cellW: 32, cellH: 32, margin: 3, spacing: 2 });
    const det = detectGridFromImageData(img);
    expect(det.cols).toBe(6);
    expect(det.rows).toBe(1);
    expect(det.margin).toEqual({ left: 3, right: 3, top: 0, bottom: 0 });
    expect(det.spacing).toEqual({ x: 2, y: 0 });
  });
});

describe("detectGridFromImageData — tilesets with no outer margin", () => {
  // Solid tiles from edge to edge with transparent gutters put all four corners on
  // tiles, so the corner background reference matched nothing and detection fell
  // back to 1x1. It must now fall back to transparency and find the grid.
  it.each([
    ["8x4 / 32px / spacing 2", 8, 4, 32, 2],
    ["10x6 / 16px / spacing 1", 10, 6, 16, 1],
  ])("finds grid and gutter on %s", (_name, cols, rows, cell, spacing) => {
    const img = paddedSheet({ cols, rows, cellW: cell, cellH: cell, spacing });
    const det = detectGridFromImageData(img);
    expect(det.cols).toBe(cols);
    expect(det.rows).toBe(rows);
    expect(det.margin).toEqual({ left: 0, right: 0, top: 0, bottom: 0 });
    expect(det.spacing).toEqual({ x: spacing, y: spacing });
  });

  it("leaves a fully opaque sheet on the corner reference", () => {
    // No transparent pixels at all: the fallback must not engage.
    const img = paddedSheet({
      cols: 4,
      rows: 4,
      cellW: 16,
      cellH: 16,
      margin: 2,
      spacing: 2,
      background: [255, 0, 255, 255],
    });
    const det = detectGridFromImageData(img);
    expect(det.cols).toBe(4);
    expect(det.rows).toBe(4);
  });
});
