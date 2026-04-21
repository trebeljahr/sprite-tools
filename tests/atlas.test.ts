import { describe, it, expect } from "vitest";
import {
  packAtlas,
  computeTrimRect,
  type PackInput,
} from "@/lib/atlas/pack";
import { filledRect, blank, circle } from "./helpers";

describe("computeTrimRect", () => {
  it("returns null for fully-transparent images", () => {
    expect(computeTrimRect(blank(8, 8))).toBeNull();
  });

  it("finds the tight opaque box", () => {
    const img = filledRect(16, 16, 4, 3, 5, 6);
    const rect = computeTrimRect(img);
    expect(rect).toEqual({ x: 4, y: 3, w: 5, h: 6 });
  });

  it("works for circles", () => {
    const img = circle(32, 32, 16, 16, 10);
    const rect = computeTrimRect(img)!;
    expect(rect.x).toBe(6);
    expect(rect.y).toBe(6);
    expect(rect.w).toBe(21);
    expect(rect.h).toBe(21);
  });
});

describe("packAtlas", () => {
  it("returns zero-sized atlas for empty input", () => {
    const result = packAtlas([], new Map(), { padding: 0, powerOfTwo: false });
    expect(result.width).toBe(0);
    expect(result.height).toBe(0);
    expect(result.frames).toEqual([]);
  });

  it("places a single sprite at (pad, pad) with padding", () => {
    const inputs: PackInput[] = [{ id: "a", width: 10, height: 10 }];
    const result = packAtlas(inputs, new Map(), { padding: 2, powerOfTwo: false });
    expect(result.frames).toHaveLength(1);
    expect(result.frames[0].x).toBe(2);
    expect(result.frames[0].y).toBe(2);
    expect(result.frames[0].width).toBe(10);
    expect(result.frames[0].height).toBe(10);
    expect(result.width).toBeGreaterThanOrEqual(14);
    expect(result.height).toBeGreaterThanOrEqual(14);
  });

  it("packs multiple sprites with no overlaps", () => {
    const inputs: PackInput[] = [
      { id: "a", width: 20, height: 20 },
      { id: "b", width: 30, height: 15 },
      { id: "c", width: 10, height: 25 },
      { id: "d", width: 15, height: 15 },
      { id: "e", width: 40, height: 10 },
    ];
    const result = packAtlas(inputs, new Map(), { padding: 1, powerOfTwo: false });
    // Every frame fits within atlas bounds.
    for (const f of result.frames) {
      expect(f.x).toBeGreaterThanOrEqual(0);
      expect(f.y).toBeGreaterThanOrEqual(0);
      expect(f.x + f.width).toBeLessThanOrEqual(result.width);
      expect(f.y + f.height).toBeLessThanOrEqual(result.height);
    }
    // Pairwise non-overlap.
    for (let i = 0; i < result.frames.length; i++) {
      for (let j = i + 1; j < result.frames.length; j++) {
        const a = result.frames[i];
        const b = result.frames[j];
        const overlap =
          a.x < b.x + b.width &&
          a.x + a.width > b.x &&
          a.y < b.y + b.height &&
          a.y + a.height > b.y;
        expect(overlap).toBe(false);
      }
    }
  });

  it("rounds to power-of-two when requested", () => {
    const inputs: PackInput[] = [{ id: "a", width: 10, height: 10 }];
    const result = packAtlas(inputs, new Map(), { padding: 0, powerOfTwo: true });
    expect(isPow2(result.width)).toBe(true);
    expect(isPow2(result.height)).toBe(true);
  });

  it("carries trim metadata through", () => {
    const inputs: PackInput[] = [{ id: "a", width: 10, height: 10 }];
    const trim = new Map([
      ["a", { sourceWidth: 40, sourceHeight: 40, offsetX: 5, offsetY: 5 }],
    ]);
    const result = packAtlas(inputs, trim, { padding: 0, powerOfTwo: false });
    expect(result.frames[0].trimmed).toEqual({
      sourceWidth: 40,
      sourceHeight: 40,
      offsetX: 5,
      offsetY: 5,
    });
  });
});

function isPow2(n: number): boolean {
  return n > 0 && (n & (n - 1)) === 0;
}
