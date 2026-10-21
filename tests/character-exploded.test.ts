import { describe, expect, it } from "vitest";
import { explodedLayout } from "../src/lib/character/exploded";

describe("exploded part inspection", () => {
  it("separates overlapping parts including the base and unassigned artwork without clipping", () => {
    const layers = [
      { id: "body", x: 0, y: 0, width: 1000, height: 800 },
      { id: "arm", x: 500, y: 200, width: 200, height: 300 },
      { id: "forearm", x: 510, y: 250, width: 200, height: 300 },
      { id: "weapon", x: 700, y: 500, width: 600, height: 100 },
      { id: "unassigned", x: 1, y: 1, width: 50, height: 50 },
      { id: "empty", x: 0, y: 0, width: 0, height: 0 },
    ];
    const layout = explodedLayout(layers, 1300, 900);
    expect(layout.items).toHaveLength(5);
    for (const a of layout.items) {
      expect(a.x + a.dx).toBe(a.left);
      expect(a.y + a.dy).toBe(a.top + layout.labelHeight);
      expect(a.left).toBeGreaterThanOrEqual(0);
      expect(a.top).toBeGreaterThanOrEqual(0);
      expect(a.left + a.width).toBeLessThan(layout.width);
      expect(a.top + a.height + layout.labelHeight).toBeLessThan(layout.height);
      for (const b of layout.items) {
        if (a.id === b.id) continue;
        expect(
          a.left + a.width <= b.left ||
            b.left + b.width <= a.left ||
            a.top + a.height + layout.labelHeight <= b.top ||
            b.top + b.height + layout.labelHeight <= a.top,
        ).toBe(true);
      }
    }
  });
  it("supports no visible generated pixels", () => {
    const layout = explodedLayout([], 800, 600);
    expect(layout.items).toEqual([]);
    expect(layout.width).toBeGreaterThan(0);
    expect(layout.height).toBeGreaterThan(0);
  });
});
