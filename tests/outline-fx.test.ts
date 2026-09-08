import { describe, it, expect } from "vitest";
import {
  applyOutlineFx,
  buildAlphaMask,
  distanceFromMask,
  hexToRgb,
  type Margin,
  type OutlineFxResult,
  requiredMargin,
} from "@/lib/outline/outline-fx";
import { blank, filledRect } from "./helpers";

type Rgba = [number, number, number, number];

const RED: Rgba = [255, 0, 0, 255];
const GREEN = "#00ff00";
const BLUE = "#0000ff";

/** Exact RGBA at (x, y) of an effect result. */
function px(res: OutlineFxResult, x: number, y: number): Rgba {
  const i = (y * res.width + x) * 4;
  return [res.data[i], res.data[i + 1], res.data[i + 2], res.data[i + 3]];
}

function alphaAt(res: OutlineFxResult, x: number, y: number): number {
  return res.data[(y * res.width + x) * 4 + 3];
}

function margin(left: number, top: number, right: number, bottom: number): Margin {
  return { left, top, right, bottom };
}

/** Every coordinate whose RGB matches `color` exactly, ignoring alpha. */
function pixelsWithColor(res: OutlineFxResult, color: Rgba): Array<{ x: number; y: number }> {
  const hits: Array<{ x: number; y: number }> = [];
  for (let y = 0; y < res.height; y++) {
    for (let x = 0; x < res.width; x++) {
      const i = (y * res.width + x) * 4;
      if (
        res.data[i] === color[0] &&
        res.data[i + 1] === color[1] &&
        res.data[i + 2] === color[2] &&
        res.data[i + 3] > 0
      ) {
        hits.push({ x, y });
      }
    }
  }
  return hits;
}

// A 3x3 red block at (6,6) on a 15x15 canvas: six clear pixels on every side,
// so distances up to 6 are testable without the canvas edge interfering.
function block(): ImageData {
  return filledRect(15, 15, 6, 6, 3, 3, RED);
}

describe("hexToRgb", () => {
  it("parses 6-digit hex with or without hash", () => {
    expect(hexToRgb("#ff0000")).toEqual({ r: 255, g: 0, b: 0 });
    expect(hexToRgb("00ff00")).toEqual({ r: 0, g: 255, b: 0 });
  });

  it("expands 3-digit shorthand", () => {
    expect(hexToRgb("#f0a")).toEqual({ r: 255, g: 0, b: 170 });
  });

  it("falls back to black on invalid input", () => {
    expect(hexToRgb("not-hex")).toEqual({ r: 0, g: 0, b: 0 });
  });
});

describe("buildAlphaMask", () => {
  it("treats alpha strictly greater than the threshold as sprite", () => {
    const img = new ImageData(3, 1);
    img.data[3] = 7;
    img.data[7] = 8;
    img.data[11] = 9;
    const mask = buildAlphaMask(img, 8);
    expect(Array.from(mask)).toEqual([0, 0, 1]);
  });

  it("returns one entry per pixel", () => {
    expect(buildAlphaMask(blank(4, 3), 8).length).toBe(12);
  });
});

describe("distanceFromMask", () => {
  it("counts steps out from the seed and marks anything past maxDist", () => {
    const mask = new Uint8Array([1, 0, 0, 0, 0]);
    const dist = distanceFromMask(mask, 5, 1, 2, 4);
    expect(Array.from(dist)).toEqual([0, 1, 2, 0xffff, 0xffff]);
  });

  it("reaches diagonals in one step under 8-connectivity only", () => {
    // Single seed at the centre of a 3x3 grid; (0,0) is the diagonal neighbour.
    const mask = new Uint8Array([0, 0, 0, 0, 1, 0, 0, 0, 0]);
    expect(distanceFromMask(mask, 3, 3, 1, 8)[0]).toBe(1);
    expect(distanceFromMask(mask, 3, 3, 1, 4)[0]).toBe(0xffff);
  });
});

describe("requiredMargin", () => {
  it("is zero when nothing is enabled", () => {
    expect(requiredMargin({})).toEqual(margin(0, 0, 0, 0));
  });

  it("reserves the band width on all four sides for an outer outline", () => {
    expect(requiredMargin({ outline: { style: "outer", width: 3 } })).toEqual(margin(3, 3, 3, 3));
  });

  it("reserves nothing for an inner outline", () => {
    expect(requiredMargin({ outline: { style: "inner", width: 4 } })).toEqual(margin(0, 0, 0, 0));
  });

  it("reserves offset plus blur on the side the shadow moves toward", () => {
    expect(requiredMargin({ shadow: { offsetX: -4, offsetY: 3, blur: 2 } })).toEqual(
      margin(6, 2, 2, 5),
    );
  });

  it("takes the per-side max of the outline and shadow contributions", () => {
    // footprint 2, spread = blur 1 + footprint 2 = 3.
    expect(
      requiredMargin({
        outline: { style: "outer", width: 2 },
        shadow: { offsetX: 5, offsetY: -1, blur: 1 },
      }),
    ).toEqual(margin(3, 4, 8, 3));
  });

  it("adds the outer band to the shadow footprint", () => {
    expect(
      requiredMargin({
        outline: { style: "outer", width: 2 },
        shadow: { offsetX: 4, offsetY: 4, blur: 0 },
      }),
    ).toEqual(margin(2, 2, 6, 6));
  });
});

describe("outer outline distance", () => {
  // clip keeps output coordinates identical to source coordinates, so the
  // asserted pixels are the raw distances from the silhouette.
  for (const connectivity of [4, 8] as const) {
    for (const width of [1, 2, 3]) {
      it(`paints exactly ${width}px out and nothing at ${width + 1}px (conn ${connectivity})`, () => {
        const res = applyOutlineFx(block(), {
          outline: { style: "outer", width, color: GREEN, connectivity },
          overflow: "clip",
        });

        for (let d = 1; d <= width; d++) {
          // Left, right, top and bottom of the block, all at straight distance d.
          expect(px(res, 6 - d, 7)).toEqual([0, 255, 0, 255]);
          expect(px(res, 8 + d, 7)).toEqual([0, 255, 0, 255]);
          expect(px(res, 7, 6 - d)).toEqual([0, 255, 0, 255]);
          expect(px(res, 7, 8 + d)).toEqual([0, 255, 0, 255]);
        }

        expect(alphaAt(res, 6 - (width + 1), 7)).toBe(0);
        expect(alphaAt(res, 8 + (width + 1), 7)).toBe(0);
        expect(alphaAt(res, 7, 6 - (width + 1))).toBe(0);
        expect(alphaAt(res, 7, 8 + (width + 1))).toBe(0);
      });
    }
  }

  it("leaves the sprite itself untouched under the band", () => {
    const res = applyOutlineFx(block(), {
      outline: { style: "outer", width: 2, color: GREEN },
      overflow: "clip",
    });
    expect(px(res, 7, 7)).toEqual([255, 0, 0, 255]);
    expect(px(res, 6, 6)).toEqual([255, 0, 0, 255]);
  });

  it("expands the canvas by the band width and reports the offset", () => {
    const res = applyOutlineFx(block(), { outline: { style: "outer", width: 3, color: GREEN } });
    expect(res.width).toBe(21);
    expect(res.height).toBe(21);
    expect(res.offsetX).toBe(3);
    expect(res.offsetY).toBe(3);
    expect(res.margin).toEqual(margin(3, 3, 3, 3));
    // The sprite moved with the offset; the band still sits 1..3 out from it.
    expect(px(res, 6 + 3, 6 + 3)).toEqual([255, 0, 0, 255]);
    expect(px(res, 6 + 3 - 3, 7 + 3)).toEqual([0, 255, 0, 255]);
    expect(alphaAt(res, 6 + 3 - 4, 7 + 3)).toBe(0);
  });

  it("respects alphaThreshold when deciding what counts as sprite", () => {
    const faint = filledRect(15, 15, 6, 6, 3, 3, [255, 0, 0, 20]);
    const hugged = applyOutlineFx(faint, {
      outline: { style: "outer", width: 1, color: GREEN, alphaThreshold: 8 },
      overflow: "clip",
    });
    const ignored = applyOutlineFx(faint, {
      outline: { style: "outer", width: 1, color: GREEN, alphaThreshold: 50 },
      overflow: "clip",
    });
    expect(px(hugged, 5, 7)).toEqual([0, 255, 0, 255]);
    expect(pixelsWithColor(ignored, [0, 255, 0, 255])).toHaveLength(0);
  });
});

describe("connectivity on a diagonal edge", () => {
  it("fills the corner diagonal under 8 but not under 4", () => {
    const cfg = { style: "outer" as const, width: 1, color: GREEN };
    const eight = applyOutlineFx(block(), {
      outline: { ...cfg, connectivity: 8 },
      overflow: "clip",
    });
    const four = applyOutlineFx(block(), {
      outline: { ...cfg, connectivity: 4 },
      overflow: "clip",
    });

    // (5,5) is the diagonal neighbour of the block's top-left corner (6,6).
    expect(px(eight, 5, 5)).toEqual([0, 255, 0, 255]);
    expect(alphaAt(four, 5, 5)).toBe(0);
    // The straight neighbours are identical under both.
    expect(px(eight, 5, 6)).toEqual([0, 255, 0, 255]);
    expect(px(four, 5, 6)).toEqual([0, 255, 0, 255]);
  });

  it("differs on a stair-stepped edge", () => {
    // A staircase: (4,4), then (4..5,5), then (4..6,6). The hypotenuse runs
    // down-right, so (5,4) and (6,5) sit diagonally off the steps.
    const stair = new ImageData(15, 15);
    const set = (x: number, y: number) => {
      const i = (y * 15 + x) * 4;
      stair.data[i] = 255;
      stair.data[i + 3] = 255;
    };
    set(4, 4);
    set(4, 5);
    set(5, 5);
    set(4, 6);
    set(5, 6);
    set(6, 6);

    const cfg = { style: "outer" as const, width: 1, color: GREEN };
    const eight = applyOutlineFx(stair, { outline: { ...cfg, connectivity: 8 }, overflow: "clip" });
    const four = applyOutlineFx(stair, { outline: { ...cfg, connectivity: 4 }, overflow: "clip" });

    // Diagonally off the step corner (5,5): 1 step under Chebyshev, 2 under Manhattan.
    expect(px(eight, 6, 4)).toEqual([0, 255, 0, 255]);
    expect(alphaAt(four, 6, 4)).toBe(0);
    expect(px(eight, 7, 5)).toEqual([0, 255, 0, 255]);
    expect(alphaAt(four, 7, 5)).toBe(0);

    // Widening the 4-connected band to 2 reaches those same pixels.
    const four2 = applyOutlineFx(stair, {
      outline: { ...cfg, width: 2, connectivity: 4 },
      overflow: "clip",
    });
    expect(px(four2, 6, 4)).toEqual([0, 255, 0, 255]);
  });
});

describe("inner outline", () => {
  const img = filledRect(12, 12, 3, 3, 6, 6, RED);

  it("never grows the bounding box", () => {
    const res = applyOutlineFx(img, { outline: { style: "inner", width: 1, color: GREEN } });
    expect(res.width).toBe(12);
    expect(res.height).toBe(12);
    expect(res.offsetX).toBe(0);
    expect(res.offsetY).toBe(0);
    expect(res.margin).toEqual(margin(0, 0, 0, 0));
    expect(requiredMargin({ outline: { style: "inner", width: 1 } })).toEqual(margin(0, 0, 0, 0));
  });

  it("draws the band inside the silhouette and nowhere else", () => {
    const res = applyOutlineFx(img, { outline: { style: "inner", width: 1, color: GREEN } });
    // Ring on the silhouette edge…
    expect(px(res, 3, 3)).toEqual([0, 255, 0, 255]);
    expect(px(res, 5, 3)).toEqual([0, 255, 0, 255]);
    expect(px(res, 8, 8)).toEqual([0, 255, 0, 255]);
    // …one pixel further in is still the sprite…
    expect(px(res, 4, 4)).toEqual([255, 0, 0, 255]);
    // …and just outside stays transparent.
    expect(alphaAt(res, 2, 3)).toBe(0);
    expect(alphaAt(res, 9, 8)).toBe(0);

    for (const { x, y } of pixelsWithColor(res, [0, 255, 0, 255])) {
      expect(x).toBeGreaterThanOrEqual(3);
      expect(x).toBeLessThanOrEqual(8);
      expect(y).toBeGreaterThanOrEqual(3);
      expect(y).toBeLessThanOrEqual(8);
    }
  });

  it("eats deeper into the silhouette as width grows", () => {
    const res = applyOutlineFx(img, { outline: { style: "inner", width: 2, color: GREEN } });
    expect(px(res, 4, 4)).toEqual([0, 255, 0, 255]);
    // The 6x6 block has a 2x2 core left at width 2.
    expect(px(res, 5, 5)).toEqual([255, 0, 0, 255]);
  });
});

describe("drop shadow", () => {
  it("lands exactly at the requested offset in output coordinates", () => {
    const res = applyOutlineFx(block(), {
      shadow: { offsetX: 3, offsetY: 2, color: BLUE, opacity: 1, blur: 0 },
    });
    expect(res.margin).toEqual(margin(0, 0, 3, 2));

    // Each sprite pixel casts a shadow pixel at (+3, +2) in output space.
    const sx = 6 + res.offsetX;
    const sy = 6 + res.offsetY;
    for (let dy = 0; dy < 3; dy++) {
      for (let dx = 0; dx < 3; dx++) {
        expect(px(res, sx + dx + 3, sy + dy + 2)).toEqual([0, 0, 255, 255]);
      }
    }
    // One pixel past the translated silhouette on each far side.
    expect(alphaAt(res, sx + 3 + 3, sy + 2)).toBe(0);
    expect(alphaAt(res, sx + 3, sy + 3 + 2)).toBe(0);
    // The sprite still wins where the two overlap.
    expect(px(res, sx, sy)).toEqual([255, 0, 0, 255]);
  });

  it("shifts the other way for negative offsets", () => {
    const res = applyOutlineFx(block(), {
      shadow: { offsetX: -2, offsetY: -2, color: BLUE, opacity: 1, blur: 0 },
    });
    expect(res.margin).toEqual(margin(2, 2, 0, 0));
    expect(px(res, 6 + res.offsetX - 2, 6 + res.offsetY - 2)).toEqual([0, 0, 255, 255]);
  });

  it("multiplies the silhouette by opacity", () => {
    const res = applyOutlineFx(block(), {
      shadow: { offsetX: 4, offsetY: 4, color: BLUE, opacity: 0.5, blur: 0 },
      overflow: "clip",
    });
    expect(px(res, 12, 12)).toEqual([0, 0, 255, 128]);
  });

  it("casts from the grown footprint when an outer outline is enabled", () => {
    const shadow = { offsetX: 4, offsetY: 4, color: BLUE, opacity: 1, blur: 0 };
    const withOutline = applyOutlineFx(block(), {
      outline: { style: "outer", width: 2, color: GREEN, connectivity: 8 },
      shadow,
      overflow: "clip",
    });
    const bare = applyOutlineFx(block(), { shadow, overflow: "clip" });

    // Sprite spans 6..8; grown by 2 it spans 4..10, so the shifted silhouette
    // reaches (14,14). The bare sprite's shadow only reaches (12,12).
    expect(px(withOutline, 14, 14)).toEqual([0, 0, 255, 255]);
    expect(alphaAt(bare, 14, 14)).toBe(0);
    expect(px(bare, 12, 12)).toEqual([0, 0, 255, 255]);
  });

  it("softens the edge when blurred", () => {
    const img = filledRect(21, 21, 6, 6, 3, 3, RED);
    const cfg = { offsetX: 0, offsetY: 0, color: "#000000", opacity: 1 };
    const hard = applyOutlineFx(img, { shadow: { ...cfg, blur: 0 }, overflow: "clip" });
    const soft = applyOutlineFx(img, { shadow: { ...cfg, blur: 3 }, overflow: "clip" });

    // Nothing outside the silhouette without blur…
    expect(alphaAt(hard, 5, 7)).toBe(0);
    // …but a falling ramp of partial alpha with it, over exactly 3px.
    const a1 = alphaAt(soft, 5, 7);
    const a2 = alphaAt(soft, 4, 7);
    const a3 = alphaAt(soft, 3, 7);
    expect(a1).toBeGreaterThan(a2);
    expect(a2).toBeGreaterThan(a3);
    expect(a3).toBeGreaterThan(0);
    expect(a1).toBeLessThan(255);
    expect(alphaAt(soft, 2, 7)).toBe(0);
  });
});

describe("composite order and colour", () => {
  it("stacks shadow under outline under sprite", () => {
    const res = applyOutlineFx(block(), {
      outline: { style: "outer", width: 1, color: GREEN, connectivity: 4 },
      shadow: { offsetX: 1, offsetY: 1, color: BLUE, opacity: 1, blur: 0 },
      overflow: "clip",
    });
    // (7,7) sprite, (5,7) outline band, and the shadow only shows past both.
    expect(px(res, 7, 7)).toEqual([255, 0, 0, 255]);
    expect(px(res, 5, 7)).toEqual([0, 255, 0, 255]);
    expect(px(res, 10, 9)).toEqual([0, 0, 255, 255]);
  });

  it("honours outline colour and opacity", () => {
    const res = applyOutlineFx(block(), {
      outline: { style: "outer", width: 1, color: "#123456", opacity: 0.5 },
      overflow: "clip",
    });
    expect(px(res, 5, 7)).toEqual([0x12, 0x34, 0x56, 128]);
  });

  it("skips the band entirely at zero opacity or zero width", () => {
    for (const outline of [
      { style: "outer" as const, width: 1, color: GREEN, opacity: 0 },
      { style: "outer" as const, width: 0, color: GREEN, opacity: 1 },
    ]) {
      const res = applyOutlineFx(block(), { outline, overflow: "clip" });
      expect(alphaAt(res, 5, 7)).toBe(0);
    }
  });
});

describe("overflow and margin control", () => {
  it("clip keeps the original canvas size and drops the overhang", () => {
    // The block touches the left edge, so its outline would run off-canvas.
    const edge = filledRect(10, 10, 0, 4, 3, 3, RED);
    const res = applyOutlineFx(edge, {
      outline: { style: "outer", width: 2, color: GREEN },
      shadow: { offsetX: 4, offsetY: 4, color: BLUE, opacity: 1 },
      overflow: "clip",
    });
    expect(res.width).toBe(10);
    expect(res.height).toBe(10);
    expect(res.offsetX).toBe(0);
    expect(res.offsetY).toBe(0);
    expect(res.margin).toEqual(margin(0, 0, 0, 0));
    // The band that fits is still drawn.
    expect(px(res, 0, 3)).toEqual([0, 255, 0, 255]);
  });

  it("honours a caller-supplied margin so sheet cells stay uniform", () => {
    const supplied = margin(5, 4, 3, 2);
    const frames = [block(), blank(15, 15)];
    for (const frame of frames) {
      const res = applyOutlineFx(frame, {
        outline: { style: "outer", width: 1, color: GREEN },
        margin: supplied,
      });
      expect(res.width).toBe(23);
      expect(res.height).toBe(21);
      expect(res.offsetX).toBe(5);
      expect(res.offsetY).toBe(4);
      expect(res.margin).toEqual(supplied);
    }
  });

  it("ignores a supplied margin under clip", () => {
    const res = applyOutlineFx(block(), {
      outline: { style: "outer", width: 1, color: GREEN },
      margin: margin(5, 5, 5, 5),
      overflow: "clip",
    });
    expect(res.width).toBe(15);
    expect(res.height).toBe(15);
  });
});

describe("applyOutlineFx robustness", () => {
  it("never mutates its input", () => {
    const img = block();
    const before = Uint8ClampedArray.from(img.data);
    applyOutlineFx(img, {
      outline: { style: "outer", width: 3, color: GREEN },
      shadow: { offsetX: 2, offsetY: 2, color: BLUE, blur: 2 },
    });
    expect(img.width).toBe(15);
    expect(img.height).toBe(15);
    expect(img.data).toEqual(before);
  });

  it("handles a fully transparent image without throwing", () => {
    const res = applyOutlineFx(blank(8, 8), {
      outline: { style: "outer", width: 2, color: GREEN },
      shadow: { offsetX: 2, offsetY: 2, color: BLUE, blur: 1, opacity: 1 },
    });
    // footprint 2 on every side, plus offset 2 and blur 1 toward the shadow.
    expect(res.margin).toEqual(margin(3, 3, 5, 5));
    expect(res.width).toBe(16);
    expect(res.height).toBe(16);
    expect(res.data.some((v) => v !== 0)).toBe(false);
  });

  it("copies the sprite through when neither effect is enabled", () => {
    const res = applyOutlineFx(block(), {});
    expect(res.width).toBe(15);
    expect(res.height).toBe(15);
    expect(px(res, 7, 7)).toEqual([255, 0, 0, 255]);
    expect(alphaAt(res, 5, 7)).toBe(0);
  });

  it("returns an empty result for a zero-sized image", () => {
    const res = applyOutlineFx(
      { width: 0, height: 0, data: new Uint8ClampedArray(0) },
      {
        outline: { style: "outer", width: 2 },
      },
    );
    expect(res.width).toBe(0);
    expect(res.height).toBe(0);
    expect(res.data.length).toBe(0);
  });
});
