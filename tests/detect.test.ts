import { describe, it, expect } from "vitest";
import { detectGridFromImageData } from "@/lib/pipeline/detect";
import { circleSheet, filledRect, blank } from "./helpers";

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
