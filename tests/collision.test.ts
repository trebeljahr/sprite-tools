import { describe, it, expect } from "vitest";
import {
  generateOutline,
  traceContour,
  simplifyPolygon,
  convexHull,
} from "@/lib/collision/outline";
import { circle, filledRect, blank } from "./helpers";

describe("traceContour", () => {
  it("returns empty on a blank image", () => {
    expect(traceContour(blank(8, 8))).toEqual([]);
  });

  it("returns a single point for a single-pixel sprite", () => {
    const img = filledRect(4, 4, 2, 2, 1, 1);
    const contour = traceContour(img);
    expect(contour.length).toBe(1);
    expect(contour[0]).toEqual({ x: 2, y: 2 });
  });

  it("traces the full boundary of a 3x3 square", () => {
    const img = filledRect(5, 5, 1, 1, 3, 3);
    const contour = traceContour(img);
    // 8-pixel outer ring
    expect(contour.length).toBe(8);
    expect(contour[0]).toEqual({ x: 1, y: 1 });
  });

  it("starts at the topmost-leftmost opaque pixel", () => {
    const img = filledRect(10, 10, 3, 2, 4, 5);
    const contour = traceContour(img);
    expect(contour[0]).toEqual({ x: 3, y: 2 });
  });

  it("respects alphaThreshold", () => {
    const soft = new ImageData(4, 4);
    // Put alpha=20 pixels in the middle — should be classified as "outside"
    // at threshold 50, "inside" at threshold 10.
    for (let i = 3; i < soft.data.length; i += 4) soft.data[i] = 20;
    expect(traceContour(soft, 50)).toEqual([]);
    expect(traceContour(soft, 10).length).toBeGreaterThan(0);
  });
});

describe("simplifyPolygon (RDP)", () => {
  it("keeps a 3-point polygon unchanged at tolerance 0", () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 5, y: 10 },
      { x: 10, y: 0 },
    ];
    expect(simplifyPolygon(pts, 0)).toHaveLength(3);
  });

  it("removes collinear intermediate points", () => {
    const line = [
      { x: 0, y: 0 },
      { x: 2, y: 2 },
      { x: 4, y: 4 },
      { x: 6, y: 6 },
      { x: 10, y: 10 },
    ];
    const simplified = simplifyPolygon(line, 0.5);
    // All intermediate points are colinear, so only endpoints survive.
    expect(simplified).toHaveLength(2);
    expect(simplified[0]).toEqual({ x: 0, y: 0 });
    expect(simplified[1]).toEqual({ x: 10, y: 10 });
  });

  it("preserves a point beyond the tolerance", () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 5, y: 3 }, // 3px off the 0→10 axis
      { x: 10, y: 0 },
    ];
    expect(simplifyPolygon(pts, 1).length).toBe(3);
    expect(simplifyPolygon(pts, 5).length).toBe(2);
  });
});

describe("convexHull", () => {
  it("returns the original 3 points of a triangle", () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 5, y: 10 },
    ];
    const hull = convexHull(pts);
    expect(hull).toHaveLength(3);
  });

  it("drops interior points", () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
      { x: 5, y: 5 }, // interior
    ];
    const hull = convexHull(pts);
    expect(hull).toHaveLength(4);
    expect(hull.every((p) => !(p.x === 5 && p.y === 5))).toBe(true);
  });
});

describe("generateOutline end-to-end", () => {
  it("returns an outline for a filled circle", () => {
    const img = circle(32, 32, 16, 16, 12);
    const out = generateOutline(img, { simplifyTolerance: 1, alphaThreshold: 10 });
    expect(out.polygon.length).toBeGreaterThan(4);
    expect(out.polygon.length).toBeLessThan(60); // simplification capped it
    expect(out.rawContourLength).toBeGreaterThan(out.polygon.length);
    expect(out.bounds).not.toBeNull();
    expect(out.bounds!.width).toBeGreaterThan(10);
  });

  it("collapses to ~4 vertices on a rectangle", () => {
    const img = filledRect(32, 32, 8, 8, 16, 16);
    const out = generateOutline(img, { simplifyTolerance: 1, alphaThreshold: 10 });
    // 4 corners + maybe a seam duplicate => 4 or 5 points
    expect(out.polygon.length).toBeGreaterThanOrEqual(4);
    expect(out.polygon.length).toBeLessThanOrEqual(5);
  });

  it("convex-hull mode fills in concave notches", () => {
    // L-shape: a concave sprite. Hull of L is a rectangle (4 pts).
    const img = new ImageData(16, 16);
    for (let y = 2; y <= 12; y++) {
      for (let x = 2; x <= 6; x++) {
        const i = (y * 16 + x) * 4;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
        img.data[i + 3] = 255;
      }
    }
    for (let y = 8; y <= 12; y++) {
      for (let x = 2; x <= 12; x++) {
        const i = (y * 16 + x) * 4;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
        img.data[i + 3] = 255;
      }
    }
    const concave = generateOutline(img, {
      simplifyTolerance: 1,
      alphaThreshold: 10,
      convexHull: false,
    });
    const convex = generateOutline(img, {
      simplifyTolerance: 1,
      alphaThreshold: 10,
      convexHull: true,
    });
    expect(convex.polygon.length).toBeLessThan(concave.polygon.length);
    expect(convex.polygon.length).toBeLessThanOrEqual(5); // rect + optional seam
  });

  it("empty input → empty polygon", () => {
    const out = generateOutline(blank(8, 8));
    expect(out.polygon).toEqual([]);
    expect(out.bounds).toBeNull();
  });
});
