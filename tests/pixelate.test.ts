import { describe, it, expect } from "vitest";
import {
  pixelate,
  downscale,
  medianCut,
  applyPalette,
  upscaleNearest,
  hexToRgb,
} from "@/lib/pixel-art/pixelate";
import { filledRect, circle } from "./helpers";

describe("downscale", () => {
  it("halves dimensions at pixelSize=2", () => {
    const img = filledRect(16, 16, 0, 0, 16, 16, [255, 0, 0, 255]);
    const small = downscale(img, 2);
    expect(small.width).toBe(8);
    expect(small.height).toBe(8);
    // Average of 4 identical pixels is itself.
    expect(small.data[0]).toBe(255);
    expect(small.data[3]).toBe(255);
  });

  it("no-op when pixelSize is 1", () => {
    const img = filledRect(8, 8, 0, 0, 8, 8);
    const same = downscale(img, 1);
    expect(same.data).toEqual(img.data);
  });

  it("premultiplies alpha so transparent pixels don't pollute color", () => {
    // 2x2 block: one fully opaque red, three fully transparent.
    const img = new ImageData(2, 2);
    img.data.set([255, 0, 0, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const small = downscale(img, 2);
    expect(small.width).toBe(1);
    // Output should be pure red at 1/4 alpha, not a muddy average.
    expect(small.data[0]).toBe(255);
    expect(small.data[1]).toBe(0);
    expect(small.data[2]).toBe(0);
    expect(small.data[3]).toBeGreaterThan(0);
    expect(small.data[3]).toBeLessThan(255);
  });
});

describe("medianCut", () => {
  it("returns the input colors when count <= target", () => {
    const pixels = [
      { r: 255, g: 0, b: 0 },
      { r: 0, g: 255, b: 0 },
    ];
    expect(medianCut(pixels, 4).length).toBe(2);
  });

  it("splits along the widest channel", () => {
    const pixels = [
      { r: 0, g: 100, b: 100 },
      { r: 255, g: 100, b: 100 },
      { r: 50, g: 100, b: 100 },
      { r: 200, g: 100, b: 100 },
    ];
    const palette = medianCut(pixels, 2);
    expect(palette.length).toBe(2);
    // R span was widest, so the two palette entries should differ on R.
    expect(palette[0].r).not.toBe(palette[1].r);
  });
});

describe("applyPalette", () => {
  it("snaps every opaque pixel to the nearest palette entry", () => {
    const img = filledRect(2, 2, 0, 0, 2, 2, [120, 200, 50, 255]);
    const palette = [
      { r: 0, g: 0, b: 0 },
      { r: 255, g: 255, b: 255 },
      { r: 128, g: 200, b: 50 },
    ];
    const out = applyPalette(img, palette, false);
    expect(out.data[0]).toBe(128);
    expect(out.data[1]).toBe(200);
    expect(out.data[2]).toBe(50);
  });

  it("leaves transparent pixels transparent", () => {
    const img = new ImageData(2, 2);
    const palette = [{ r: 255, g: 0, b: 0 }];
    const out = applyPalette(img, palette, false);
    expect(out.data[3]).toBe(0);
  });
});

describe("pixelate end-to-end", () => {
  it("downscales by factor pixelSize", () => {
    const img = circle(64, 64, 32, 32, 24);
    const out = pixelate(img, { pixelSize: 4, colorCount: 0 });
    expect(out.width).toBe(16);
    expect(out.height).toBe(16);
  });

  it("applies a fixed palette when provided", () => {
    const img = circle(16, 16, 8, 8, 6, [200, 100, 50, 255]);
    const out = pixelate(img, {
      pixelSize: 1,
      colorCount: 0,
      palette: [
        { r: 0, g: 0, b: 0 },
        { r: 255, g: 255, b: 255 },
      ],
    });
    // Every opaque pixel should be black or white now.
    const colors = new Set<string>();
    for (let i = 0; i < out.data.length; i += 4) {
      if (out.data[i + 3] > 0) {
        colors.add(`${out.data[i]},${out.data[i + 1]},${out.data[i + 2]}`);
      }
    }
    for (const c of colors) {
      expect(["0,0,0", "255,255,255"]).toContain(c);
    }
  });
});

describe("upscaleNearest", () => {
  it("multiplies dimensions by factor", () => {
    const img = filledRect(2, 2, 0, 0, 2, 2);
    const up = upscaleNearest(img, 3);
    expect(up.width).toBe(6);
    expect(up.height).toBe(6);
  });

  it("factor 1 is a clone", () => {
    const img = filledRect(4, 4, 0, 0, 4, 4);
    const up = upscaleNearest(img, 1);
    expect(up.width).toBe(4);
    expect(up.data).toEqual(img.data);
  });
});

describe("hexToRgb", () => {
  it("parses 6-digit hex with or without hash", () => {
    expect(hexToRgb("#ff0000")).toEqual({ r: 255, g: 0, b: 0 });
    expect(hexToRgb("00ff00")).toEqual({ r: 0, g: 255, b: 0 });
  });

  it("returns black on invalid input", () => {
    expect(hexToRgb("not-hex")).toEqual({ r: 0, g: 0, b: 0 });
  });
});
