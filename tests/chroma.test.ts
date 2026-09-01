import { describe, expect, it } from "vitest";
import {
  applyChromaKeyToImageData,
  applySolidFillToImageData,
  type ChromaCoreConfig,
  detectBackgroundColor,
  hexToRgb,
} from "@/lib/pipeline/chroma-core";

type Rgba = [number, number, number, number];

/** Solid-colour canvas; every pixel opaque unless overwritten. */
function solid(w: number, h: number, color: Rgba): ImageData {
  const img = new ImageData(w, h);
  for (let i = 0; i < img.data.length; i += 4) {
    img.data[i] = color[0];
    img.data[i + 1] = color[1];
    img.data[i + 2] = color[2];
    img.data[i + 3] = color[3];
  }
  return img;
}

function setPixel(img: ImageData, x: number, y: number, color: Rgba) {
  const i = (y * img.width + x) * 4;
  img.data[i] = color[0];
  img.data[i + 1] = color[1];
  img.data[i + 2] = color[2];
  img.data[i + 3] = color[3];
}

function alphaAt(img: ImageData, x: number, y: number): number {
  return img.data[(y * img.width + x) * 4 + 3];
}

const baseCfg: ChromaCoreConfig = {
  mode: "chroma-transparent",
  similarity: 30,
  softness: 0,
  spill: 0,
  choke: 0,
};

const GREEN: Rgba = [0, 255, 0, 255];
const RED: Rgba = [255, 0, 0, 255];

describe("hexToRgb", () => {
  it("parses 6-digit hex with or without hash", () => {
    expect(hexToRgb("#ff0000")).toEqual({ r: 255, g: 0, b: 0 });
    expect(hexToRgb("00ff00")).toEqual({ r: 0, g: 255, b: 0 });
  });

  it("falls back to white on invalid input", () => {
    expect(hexToRgb("nope")).toEqual({ r: 255, g: 255, b: 255 });
  });
});

describe("detectBackgroundColor", () => {
  it("picks the colour shared by the majority of corners", () => {
    const img = solid(8, 8, GREEN);
    // Only the top-left corner disagrees, so green must still win.
    setPixel(img, 0, 0, RED);
    expect(detectBackgroundColor(img)).toEqual({ r: 0, g: 255, b: 0 });
  });

  it("falls back to the top-left corner when all four corners differ", () => {
    const img = solid(8, 8, [10, 10, 10, 255]);
    setPixel(img, 0, 0, [1, 2, 3, 255]);
    setPixel(img, 7, 0, [4, 5, 6, 255]);
    setPixel(img, 0, 7, [7, 8, 9, 255]);
    setPixel(img, 7, 7, [11, 12, 13, 255]);
    expect(detectBackgroundColor(img)).toEqual({ r: 1, g: 2, b: 3 });
  });
});

describe("applyChromaKeyToImageData", () => {
  it("zeroes alpha within similarity and keeps distant pixels opaque", () => {
    const img = solid(8, 8, GREEN);
    setPixel(img, 4, 4, RED);
    // Slightly-off green (dist ~17) is still inside the similarity radius.
    setPixel(img, 2, 2, [10, 245, 10, 255]);

    applyChromaKeyToImageData(img, { r: 0, g: 255, b: 0 }, baseCfg);

    expect(alphaAt(img, 0, 0)).toBe(0);
    expect(alphaAt(img, 2, 2)).toBe(0);
    expect(alphaAt(img, 4, 4)).toBe(255);
  });

  it("never raises an already-transparent pixel's alpha", () => {
    const img = solid(4, 4, [255, 0, 0, 0]);
    applyChromaKeyToImageData(img, { r: 0, g: 255, b: 0 }, baseCfg);
    expect(alphaAt(img, 1, 1)).toBe(0);
  });

  it("produces intermediate alpha inside the softness band", () => {
    const img = solid(4, 4, [0, 0, 0, 255]);
    // dist 30 sits halfway through the band [10, 50).
    setPixel(img, 1, 1, [30, 0, 0, 255]);
    // dist 60 is past the band entirely.
    setPixel(img, 2, 2, [60, 0, 0, 255]);

    applyChromaKeyToImageData(
      img,
      { r: 0, g: 0, b: 0 },
      { ...baseCfg, similarity: 10, softness: 40 },
    );

    expect(alphaAt(img, 0, 0)).toBe(0);
    const mid = alphaAt(img, 1, 1);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(255);
    expect(alphaAt(img, 2, 2)).toBe(255);
  });

  it("erodes edge alpha as choke grows", () => {
    const img = solid(8, 8, GREEN);
    for (let y = 3; y <= 4; y++) {
      for (let x = 3; x <= 4; x++) setPixel(img, x, y, RED);
    }
    const choked = solid(8, 8, GREEN);
    for (let y = 3; y <= 4; y++) {
      for (let x = 3; x <= 4; x++) setPixel(choked, x, y, RED);
    }

    applyChromaKeyToImageData(img, { r: 0, g: 255, b: 0 }, baseCfg);
    applyChromaKeyToImageData(choked, { r: 0, g: 255, b: 0 }, { ...baseCfg, choke: 1 });

    expect(alphaAt(img, 3, 3)).toBe(255);
    // Every kept pixel borders the keyed background, so choke=1 clears them.
    expect(alphaAt(choked, 3, 3)).toBe(0);
  });

  it("survives boundary values for spill and choke", () => {
    for (const cfg of [
      { ...baseCfg, spill: 0, choke: 0 },
      { ...baseCfg, spill: 255, choke: 0 },
      { ...baseCfg, spill: 0, choke: 8 },
      { ...baseCfg, spill: 255, choke: 8 },
      { ...baseCfg, similarity: 0, softness: 0, spill: 0, choke: 0 },
    ]) {
      const img = solid(8, 8, GREEN);
      setPixel(img, 4, 4, RED);
      expect(() => applyChromaKeyToImageData(img, { r: 0, g: 255, b: 0 }, cfg)).not.toThrow();
      for (let i = 0; i < img.data.length; i++) {
        expect(Number.isNaN(img.data[i])).toBe(false);
      }
    }
  });
});

describe("applySolidFillToImageData", () => {
  it("replaces the background with the configured colour and stays opaque", () => {
    const img = solid(8, 8, GREEN);
    setPixel(img, 4, 4, RED);

    applySolidFillToImageData(img, {
      ...baseCfg,
      mode: "chroma-solid",
      solidColor: "#0000ff",
    });

    const i = (0 * 8 + 0) * 4;
    expect([img.data[i], img.data[i + 1], img.data[i + 2]]).toEqual([0, 0, 255]);
    expect(img.data[i + 3]).toBe(255);
    expect(alphaAt(img, 4, 4)).toBe(255);
    const j = (4 * 8 + 4) * 4;
    expect(img.data[j]).toBe(255);
  });

  it("defaults to white when no solid colour is given", () => {
    const img = solid(4, 4, GREEN);
    applySolidFillToImageData(img, { ...baseCfg, mode: "chroma-solid" });
    expect([img.data[0], img.data[1], img.data[2]]).toEqual([255, 255, 255]);
  });
});
