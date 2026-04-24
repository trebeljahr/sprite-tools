import { describe, it, expect } from "vitest";
import { extractPalette, applyPaletteSwap, rgbToHex, hexToRgb } from "@/lib/palette/extract";
import { filledRect } from "./helpers";

describe("extractPalette", () => {
  it("ignores transparent pixels", () => {
    const img = new ImageData(4, 4); // fully transparent
    expect(extractPalette(img, 4)).toEqual([]);
  });

  it("returns <= requested count", () => {
    const img = filledRect(8, 8, 0, 0, 8, 8, [120, 80, 200, 255]);
    expect(extractPalette(img, 4).length).toBeLessThanOrEqual(4);
  });

  it("extracts distinct colors from a bichrome sprite", () => {
    const img = new ImageData(4, 4);
    // Left half red, right half green, all opaque.
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        const i = (y * 4 + x) * 4;
        if (x < 2) {
          img.data[i] = 255;
        } else {
          img.data[i + 1] = 255;
        }
        img.data[i + 3] = 255;
      }
    }
    const palette = extractPalette(img, 2);
    expect(palette.length).toBe(2);
    // Should have one red-ish and one green-ish.
    const hasRed = palette.some((c) => c.r > c.g && c.r > c.b);
    const hasGreen = palette.some((c) => c.g > c.r && c.g > c.b);
    expect(hasRed).toBe(true);
    expect(hasGreen).toBe(true);
  });
});

describe("applyPaletteSwap", () => {
  it("passes through when swap list is empty", () => {
    const img = filledRect(4, 4, 0, 0, 4, 4, [200, 0, 0, 255]);
    const out = applyPaletteSwap(img, [{ r: 200, g: 0, b: 0 }], []);
    expect(out.data).toEqual(img.data);
  });

  it("remaps pixels matching a swap entry", () => {
    const img = filledRect(2, 2, 0, 0, 2, 2, [255, 0, 0, 255]);
    const palette = [{ r: 255, g: 0, b: 0 }];
    const swaps = [{ from: { r: 255, g: 0, b: 0 }, to: { r: 0, g: 0, b: 255 } }];
    const out = applyPaletteSwap(img, palette, swaps);
    expect(out.data[0]).toBe(0);
    expect(out.data[2]).toBe(255);
    expect(out.data[3]).toBe(255);
  });

  it("keeps transparent pixels transparent", () => {
    const img = new ImageData(2, 2);
    const palette = [{ r: 255, g: 0, b: 0 }];
    const swaps = [{ from: palette[0], to: { r: 0, g: 255, b: 0 } }];
    const out = applyPaletteSwap(img, palette, swaps);
    for (let i = 3; i < out.data.length; i += 4) expect(out.data[i]).toBe(0);
  });
});

describe("rgbToHex / hexToRgb", () => {
  it("round-trips", () => {
    const c = { r: 42, g: 100, b: 200 };
    expect(hexToRgb(rgbToHex(c))).toEqual(c);
  });

  it("rgbToHex pads with zeros", () => {
    expect(rgbToHex({ r: 0, g: 1, b: 15 })).toBe("#00010f");
  });
});
