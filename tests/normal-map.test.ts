import { describe, it, expect } from "vitest";
import { generateNormalMap, alphaDistance, luminance } from "@/lib/normal-map/normal-map";
import { circle, filledRect, blank } from "./helpers";

describe("alphaDistance", () => {
  it("is 0 outside the sprite", () => {
    const img = circle(16, 16, 8, 8, 4);
    const d = alphaDistance(img);
    expect(d[0]).toBe(0); // corner
  });

  it("is maximal at the center of a convex sprite", () => {
    const img = circle(32, 32, 16, 16, 12);
    const d = alphaDistance(img);
    const center = d[16 * 32 + 16];
    const edge = d[16 * 32 + 4]; // ~12 pixels into the interior from edge
    expect(center).toBeGreaterThan(edge);
    expect(center).toBeCloseTo(1, 1);
  });
});

describe("luminance", () => {
  it("is 0 for fully-transparent images", () => {
    const img = blank(8, 8);
    const l = luminance(img);
    for (const v of l) expect(v).toBe(0);
  });

  it("is premultiplied by alpha", () => {
    const img = filledRect(4, 4, 0, 0, 4, 4, [255, 255, 255, 128]);
    const l = luminance(img);
    // white at 50% alpha → luminance ~= 0.5
    expect(l[0]).toBeGreaterThan(0.4);
    expect(l[0]).toBeLessThan(0.6);
  });
});

describe("generateNormalMap", () => {
  it("encodes flat areas as 0x8080ff-ish (straight-up normal)", () => {
    const img = filledRect(16, 16, 0, 0, 16, 16, [255, 0, 0, 255]);
    const nm = generateNormalMap(img, { source: "alpha", strength: 1, blur: 0 });
    // Interior pixel (far from edge) should be near (128, 128, 255)
    const i = (8 * 16 + 8) * 4;
    // Flat interior may drift slightly — just check Z is strongly positive.
    expect(nm.data[i + 2]).toBeGreaterThan(200);
    expect(nm.data[i + 3]).toBe(255);
  });

  it("preserves alpha from source", () => {
    const img = circle(16, 16, 8, 8, 5);
    const nm = generateNormalMap(img);
    // Corner pixel is transparent in source and should be transparent in output.
    expect(nm.data[3]).toBe(0);
  });

  it("fully transparent image → all-transparent output", () => {
    const img = blank(8, 8);
    const nm = generateNormalMap(img);
    for (let i = 3; i < nm.data.length; i += 4) {
      expect(nm.data[i]).toBe(0);
    }
  });
});
