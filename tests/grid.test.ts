import { describe, expect, it } from "vitest";
import {
  cellRect,
  computeCellGeometry,
  GridFitError,
  isZeroPadding,
  normalizeGridPadding,
  ZERO_PADDING,
} from "@/lib/pipeline/grid";

describe("normalizeGridPadding", () => {
  it("defaults to zeros for undefined / null", () => {
    expect(normalizeGridPadding()).toEqual(ZERO_PADDING);
    expect(normalizeGridPadding(null)).toEqual(ZERO_PADDING);
    expect(isZeroPadding(normalizeGridPadding())).toBe(true);
  });

  it("expands a uniform margin to all four sides", () => {
    const p = normalizeGridPadding({ margin: 4 });
    expect(p.margin).toEqual({ left: 4, top: 4, right: 4, bottom: 4 });
    expect(p.spacing).toEqual({ x: 0, y: 0 });
  });

  it("marginX fills left+right, marginY fills top+bottom", () => {
    const p = normalizeGridPadding({ marginX: 5, marginY: 2 });
    expect(p.margin).toEqual({ left: 5, top: 2, right: 5, bottom: 2 });
  });

  it("axis beats uniform", () => {
    const p = normalizeGridPadding({ margin: 9, marginX: 1 });
    expect(p.margin).toEqual({ left: 1, top: 9, right: 1, bottom: 9 });
  });

  it("per-side wins over axis and uniform", () => {
    const p = normalizeGridPadding({ marginX: 4, marginY: 7, margin: { left: 1, bottom: 0 } });
    // margin as an object supplies left/bottom; the axis shorthands fill the rest.
    expect(p.margin).toEqual({ left: 1, top: 7, right: 4, bottom: 0 });
  });

  it("spacing: number sets both axes, spacingX/spacingY override", () => {
    expect(normalizeGridPadding({ spacing: 2 }).spacing).toEqual({ x: 2, y: 2 });
    expect(normalizeGridPadding({ spacing: 2, spacingX: 5 }).spacing).toEqual({ x: 5, y: 2 });
    expect(normalizeGridPadding({ spacingX: 1, spacingY: 3 }).spacing).toEqual({ x: 1, y: 3 });
  });

  it("spacing object beats the spacingX shorthand", () => {
    expect(normalizeGridPadding({ spacing: { x: 1 }, spacingX: 5 }).spacing).toEqual({
      x: 1,
      y: 0,
    });
  });

  it("round-trips a GridPadding, defensively copied", () => {
    const src = { margin: { left: 1, top: 2, right: 3, bottom: 4 }, spacing: { x: 5, y: 6 } };
    const out = normalizeGridPadding(src);
    expect(out).toEqual(src);
    expect(out.margin).not.toBe(src.margin);
    expect(out.spacing).not.toBe(src.spacing);
    src.margin.left = 99;
    expect(out.margin.left).toBe(1);
  });

  it("normalizing ZERO_PADDING does not mutate the frozen singleton", () => {
    const out = normalizeGridPadding(ZERO_PADDING);
    expect(out).toEqual(ZERO_PADDING);
    expect(out.margin).not.toBe(ZERO_PADDING.margin);
  });

  it("rejects negatives, non-integers and non-finite values", () => {
    expect(() => normalizeGridPadding({ margin: -1 })).toThrow(GridFitError);
    expect(() => normalizeGridPadding({ marginX: -2 })).toThrow(GridFitError);
    expect(() => normalizeGridPadding({ margin: { top: -3 } })).toThrow(GridFitError);
    expect(() => normalizeGridPadding({ spacing: -1 })).toThrow(GridFitError);
    expect(() => normalizeGridPadding({ spacingY: -1 })).toThrow(GridFitError);

    expect(() => normalizeGridPadding({ margin: 1.5 })).toThrow(GridFitError);
    expect(() => normalizeGridPadding({ spacingX: 0.5 })).toThrow(GridFitError);
    expect(() => normalizeGridPadding({ margin: { right: 2.25 } })).toThrow(GridFitError);

    expect(() => normalizeGridPadding({ margin: Number.NaN })).toThrow(GridFitError);
    expect(() => normalizeGridPadding({ spacing: Number.POSITIVE_INFINITY })).toThrow(GridFitError);
  });

  it("names the offending field in the error", () => {
    expect(() => normalizeGridPadding({ spacingY: -4 })).toThrow(/spacingY/);
    expect(() => normalizeGridPadding({ margin: { left: 1.5 } })).toThrow(/margin\.left/);
  });
});

describe("isZeroPadding", () => {
  it("is true only when every component is zero", () => {
    expect(isZeroPadding(ZERO_PADDING)).toBe(true);
    expect(isZeroPadding(normalizeGridPadding({ margin: { bottom: 1 } }))).toBe(false);
    expect(isZeroPadding(normalizeGridPadding({ spacingY: 1 }))).toBe(false);
  });
});

describe("computeCellGeometry — zero-padding legacy path", () => {
  // These pin TODAY's flush behaviour. Every existing sheet slices through this
  // path, so a future "cleanup" that turns non-divisible sheets into an error
  // would be a regression, not an improvement. Deliberately explicit.
  it("divides evenly when it can", () => {
    const g = computeCellGeometry(64, 96, 2, 3);
    expect(g).toEqual({ cellW: 32, cellH: 32, padding: ZERO_PADDING });
  });

  it("FLOORS a non-divisible sheet and does NOT throw", () => {
    const g = computeCellGeometry(208, 140, 6, 4);
    expect(g.cellW).toBe(Math.floor(208 / 6)); // 34
    expect(g.cellH).toBe(Math.floor(140 / 4)); // 35
  });

  it("matches Math.floor(w/cols) across a spread of awkward sheets", () => {
    for (const [w, h, cols, rows] of [
      [100, 100, 3, 7],
      [255, 129, 8, 5],
      [1, 1, 1, 1],
      [33, 65, 32, 32],
      [7, 7, 8, 8], // undersized: floors to 0, still no throw
    ] as const) {
      const g = computeCellGeometry(w, h, cols, rows);
      expect([g.cellW, g.cellH]).toEqual([Math.floor(w / cols), Math.floor(h / rows)]);
    }
  });

  it("explicit ZERO_PADDING takes the same legacy path", () => {
    expect(computeCellGeometry(208, 140, 6, 4, ZERO_PADDING).cellW).toBe(34);
    expect(computeCellGeometry(208, 140, 6, 4, { margin: 0, spacing: 0 }).cellW).toBe(34);
  });

  it("rejects non-positive / non-integer cols and rows", () => {
    expect(() => computeCellGeometry(64, 64, 0, 2)).toThrow(GridFitError);
    expect(() => computeCellGeometry(64, 64, 2, -1)).toThrow(GridFitError);
    expect(() => computeCellGeometry(64, 64, 2.5, 2)).toThrow(GridFitError);
  });
});

describe("computeCellGeometry — strict padded path", () => {
  it("resolves an exact fit (Kenney-style margin 3 / spacing 2)", () => {
    // 6x4 of 32px cells => 208x140, and 208 % 6 !== 0, so flush slicing fails here.
    const g = computeCellGeometry(208, 140, 6, 4, { margin: 3, spacing: 2 });
    expect(g.cellW).toBe(32);
    expect(g.cellH).toBe(32);
    expect(g.padding.margin).toEqual({ left: 3, top: 3, right: 3, bottom: 3 });
    expect(g.padding.spacing).toEqual({ x: 2, y: 2 });
  });

  it("resolves an asymmetric margin", () => {
    // left 5 + 6*32 + 5*2 + right 1 = 208
    const g = computeCellGeometry(208, 140, 6, 4, {
      margin: { left: 5, right: 1, top: 3, bottom: 3 },
      spacing: 2,
    });
    expect(g.cellW).toBe(32);
    expect(g.cellH).toBe(32);
  });

  it("spacing alone, no margin", () => {
    // 8*32 + 7*2 = 270
    expect(computeCellGeometry(270, 270, 8, 8, { spacing: 2 }).cellW).toBe(32);
  });

  it("throws GridFitError when the stated geometry does not divide", () => {
    expect(() => computeCellGeometry(270, 270, 8, 8, { spacingX: 3, spacingY: 3 })).toThrow(
      GridFitError,
    );
  });

  it("the error message carries the offending numbers, not just a type", () => {
    let msg = "";
    try {
      computeCellGeometry(270, 270, 8, 8, { spacingX: 3, spacingY: 3 });
    } catch (e) {
      msg = (e as Error).message;
    }
    // 270 - 7*3 = 249, which is not divisible by 8 (31.125).
    expect(msg).toContain("270"); // the actual width
    expect(msg).toContain("249"); // the inner span it computed
    expect(msg).toContain("8"); // the column count
    expect(msg).toContain("spacingX 3"); // the padding it was told to use
    expect(msg).toMatch(/columns/);
    expect(msg).toMatch(/not a whole number/i);
    // and it must suggest something actionable rather than just complaining
    expect(msg).toMatch(/Try /);
  });

  it("throws when margins and spacing eat the whole sheet", () => {
    expect(() => computeCellGeometry(32, 32, 4, 4, { margin: 20 })).toThrow(GridFitError);
    expect(() => computeCellGeometry(32, 32, 4, 4, { margin: 20 })).toThrow(/whole sheet/);
  });

  it("reports the failing axis by name", () => {
    // x fits (208), y does not (140 - 6 - 3*5 = 119, 119 % 4 !== 0).
    expect(() =>
      computeCellGeometry(208, 140, 6, 4, { margin: 3, spacingX: 2, spacingY: 5 }),
    ).toThrow(/height 140/);
  });
});

describe("cellRect", () => {
  it("with zero padding is exactly col*cellW / row*cellH", () => {
    const g = computeCellGeometry(208, 140, 6, 4);
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 6; c++) {
        expect(cellRect(g, c, r)).toEqual({
          x: c * g.cellW,
          y: r * g.cellH,
          w: g.cellW,
          h: g.cellH,
        });
      }
    }
  });

  it("steps by cellW + spacing.x from the margin", () => {
    const g = computeCellGeometry(208, 140, 6, 4, { margin: 3, spacing: 2 });
    expect(cellRect(g, 0, 0)).toEqual({ x: 3, y: 3, w: 32, h: 32 });
    expect(cellRect(g, 1, 0)).toEqual({ x: 37, y: 3, w: 32, h: 32 });
    expect(cellRect(g, 5, 3)).toEqual({ x: 3 + 5 * 34, y: 3 + 3 * 34, w: 32, h: 32 });
    // The last cell must land exactly on the trailing margin.
    const last = cellRect(g, 5, 3);
    expect(last.x + last.w).toBe(208 - 3);
    expect(last.y + last.h).toBe(140 - 3);
  });

  it("honours an asymmetric margin's leading side only", () => {
    const g = computeCellGeometry(208, 140, 6, 4, {
      margin: { left: 5, right: 1, top: 3, bottom: 3 },
      spacing: 2,
    });
    expect(cellRect(g, 0, 0).x).toBe(5);
    const last = cellRect(g, 5, 0);
    expect(last.x + last.w).toBe(208 - 1);
  });
});
