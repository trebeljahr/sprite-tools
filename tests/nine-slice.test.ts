import { describe, expect, it } from "vitest";
import {
  clampInsets,
  detectNineSlice,
  nineSliceRegions,
  stretchNineSlice,
} from "@/lib/nine-slice/nine-slice";
import { decodeNinePatch, encodeNinePatch, isNinePatchCandidate } from "@/lib/nine-slice/ninepatch";
import { filledRect } from "./helpers";

type Rgba = [number, number, number, number];

function setPixel(img: ImageData, x: number, y: number, c: Rgba): void {
  const i = (y * img.width + x) * 4;
  img.data[i] = c[0];
  img.data[i + 1] = c[1];
  img.data[i + 2] = c[2];
  img.data[i + 3] = c[3];
}

function getPixel(img: ImageData, x: number, y: number): Rgba {
  const i = (y * img.width + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]];
}

/**
 * A panel shaped the way real nine-slice art is: corners carry per-axis
 * detail (a checkerboard, so the difference profile actually spikes there —
 * a uniform ring has zero variance and reads as "middle"), the top/bottom
 * edges are uniform along x, the left/right edges are uniform along y, and
 * the interior is one flat fill.
 */
function panel(size = 48, border = 8): ImageData {
  const img = new ImageData(size, size);
  const EDGE_H: Rgba = [200, 60, 60, 255];
  const EDGE_V: Rgba = [60, 200, 60, 255];
  const FILL: Rgba = [40, 40, 90, 255];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const horizEdge = y < border || y >= size - border;
      const vertEdge = x < border || x >= size - border;
      if (horizEdge && vertEdge) {
        setPixel(img, x, y, [x % 2 ? 255 : 0, y % 2 ? 255 : 0, 128, 255]);
      } else if (horizEdge) {
        setPixel(img, x, y, EDGE_H);
      } else if (vertEdge) {
        setPixel(img, x, y, EDGE_V);
      } else {
        setPixel(img, x, y, FILL);
      }
    }
  }
  return img;
}

function flat(w: number, h: number, c: Rgba = [30, 120, 200, 255]): ImageData {
  const img = new ImageData(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) setPixel(img, x, y, c);
  return img;
}

/** Deterministic LCG so the noise fixture is stable across runs. */
function noise(w: number, h: number): ImageData {
  const img = new ImageData(w, h);
  let seed = 0x2f6e2b1;
  const next = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed >>> 24;
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) setPixel(img, x, y, [next(), next(), next(), 255]);
  }
  return img;
}

describe("detectNineSlice", () => {
  it("lands on the border width of a panel with an obviously flat middle", () => {
    const det = detectNineSlice(panel(48, 8));
    // The flat run over profile indices s..e covers lines s..e+1, so an 8px
    // border comes back exactly; anything off by one would still be a usable
    // starting guess.
    expect(det.insets).toEqual({ left: 8, right: 8, top: 8, bottom: 8 });
    expect(det.confidence).toBeGreaterThan(0.5);
    expect(det.columnProfile).toHaveLength(47);
    expect(det.rowProfile).toHaveLength(47);
  });

  it("detects nothing to slice on a fully flat image", () => {
    const det = detectNineSlice(flat(16, 16));
    expect(det.insets).toEqual({ left: 0, right: 0, top: 0, bottom: 0 });
    expect(det.confidence).toBe(1);
  });

  it("returns low confidence and valid insets on pure noise", () => {
    const det = detectNineSlice(noise(32, 32));
    expect(det.confidence).toBeLessThan(0.2);
    expect(det.insets.left + det.insets.right).toBeLessThanOrEqual(31);
    expect(det.insets.top + det.insets.bottom).toBeLessThanOrEqual(31);
    for (const v of Object.values(det.insets)) expect(v).toBeGreaterThanOrEqual(0);
  });

  it("treats sub-threshold alpha as equal regardless of RGB", () => {
    // Two transparent columns with wildly different garbage RGB must not read
    // as an edge.
    const img = new ImageData(4, 4);
    for (let y = 0; y < 4; y++) {
      setPixel(img, 0, y, [255, 0, 0, 0]);
      setPixel(img, 1, y, [0, 255, 0, 0]);
      setPixel(img, 2, y, [0, 0, 255, 0]);
      setPixel(img, 3, y, [9, 9, 9, 0]);
    }
    const det = detectNineSlice(img);
    expect(det.columnProfile.every((v) => v === 0)).toBe(true);
    expect(det.insets).toEqual({ left: 0, right: 0, top: 0, bottom: 0 });
  });
});

describe("clampInsets", () => {
  it("never returns negatives and never overlaps the middle", () => {
    const c = clampInsets({ left: -50, right: 999, top: -1, bottom: 4 }, 20, 20);
    expect(c.left).toBeGreaterThanOrEqual(0);
    expect(c.right).toBeGreaterThanOrEqual(0);
    expect(c.left + c.right).toBeLessThanOrEqual(19);
    expect(c.top + c.bottom).toBeLessThanOrEqual(19);
  });

  it("handles insets far larger than the image", () => {
    const c = clampInsets({ left: 100, right: 100, top: 100, bottom: 100 }, 10, 10);
    expect(c.left + c.right).toBe(9);
    expect(c.top + c.bottom).toBe(9);
    for (const v of Object.values(c)) expect(v).toBeGreaterThanOrEqual(0);
  });

  it("shrinks the larger of an opposing pair first", () => {
    const c = clampInsets({ left: 10, right: 2 }, 10, 10);
    expect(c.right).toBe(2);
    expect(c.left).toBe(7);
  });

  it("defaults NaN / undefined / non-finite fields to 0 and never returns NaN", () => {
    const c = clampInsets(
      { left: Number.NaN, right: undefined as unknown as number, top: Number.POSITIVE_INFINITY },
      16,
      16,
    );
    expect(c).toEqual({ left: 0, right: 0, top: 0, bottom: 0 });
    for (const v of Object.values(c)) expect(Number.isNaN(v)).toBe(false);
  });

  it("collapses to zero on a 1x1 image", () => {
    expect(clampInsets({ left: 5, right: 5, top: 5, bottom: 5 }, 1, 1)).toEqual({
      left: 0,
      right: 0,
      top: 0,
      bottom: 0,
    });
  });

  it("honours a larger minMiddle", () => {
    const c = clampInsets({ left: 8, right: 8, top: 8, bottom: 8 }, 20, 20, 8);
    expect(c.left + c.right).toBeLessThanOrEqual(12);
  });
});

describe("nineSliceRegions", () => {
  it("returns nine rects that tile the image exactly", () => {
    const W = 48;
    const H = 32;
    const regions = nineSliceRegions({ left: 8, right: 6, top: 5, bottom: 7 }, W, H);
    expect(regions).toHaveLength(9);
    expect(regions.map((r) => r.name)).toEqual([
      "top-left",
      "top-center",
      "top-right",
      "middle-left",
      "center",
      "middle-right",
      "bottom-left",
      "bottom-center",
      "bottom-right",
    ]);

    const area = regions.reduce((sum, r) => sum + r.width * r.height, 0);
    expect(area).toBe(W * H);

    for (let i = 0; i < regions.length; i++) {
      for (let j = i + 1; j < regions.length; j++) {
        const a = regions[i];
        const b = regions[j];
        const overlapX = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
        const overlapY = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
        expect(Math.max(0, overlapX) * Math.max(0, overlapY)).toBe(0);
      }
    }

    // Every pixel is covered exactly once.
    const hits = new Uint8Array(W * H);
    for (const r of regions) {
      for (let y = r.y; y < r.y + r.height; y++) {
        for (let x = r.x; x < r.x + r.width; x++) hits[y * W + x]++;
      }
    }
    expect(hits.every((n) => n === 1)).toBe(true);
  });

  it("flags only the middle band as stretchable", () => {
    const regions = nineSliceRegions({ left: 4, right: 4, top: 4, bottom: 4 }, 16, 16);
    expect(regions.filter((r) => r.stretchX && r.stretchY).map((r) => r.name)).toEqual(["center"]);
    expect(regions.filter((r) => r.stretchX).map((r) => r.name)).toEqual([
      "top-center",
      "center",
      "bottom-center",
    ]);
    expect(regions.filter((r) => r.stretchY).map((r) => r.name)).toEqual([
      "middle-left",
      "center",
      "middle-right",
    ]);
  });
});

describe("stretchNineSlice", () => {
  const insets = { left: 8, right: 8, top: 8, bottom: 8 };

  it("is a pixel-exact identity at the source size", () => {
    const src = panel(48, 8);
    const out = stretchNineSlice(src, insets, 48, 48);
    expect(out.width).toBe(48);
    expect(out.height).toBe(48);
    expect(Array.from(out.data)).toEqual(Array.from(src.data));
  });

  it("keeps the corners byte-identical when stretched larger", () => {
    const src = panel(48, 8);
    const out = stretchNineSlice(src, insets, 96, 72);
    expect(out.width).toBe(96);
    expect(out.height).toBe(72);
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        expect(getPixel(out, x, y)).toEqual(getPixel(src, x, y));
        expect(getPixel(out, out.width - 1 - x, y)).toEqual(getPixel(src, src.width - 1 - x, y));
        expect(getPixel(out, x, out.height - 1 - y)).toEqual(getPixel(src, x, src.height - 1 - y));
        expect(getPixel(out, out.width - 1 - x, out.height - 1 - y)).toEqual(
          getPixel(src, src.width - 1 - x, src.height - 1 - y),
        );
      }
    }
    // The stretched center still samples the flat interior fill.
    expect(getPixel(out, 48, 36)).toEqual(getPixel(src, 24, 24));
  });

  it("throws when the target is smaller than the corner budget", () => {
    const src = panel(48, 8);
    expect(() => stretchNineSlice(src, insets, 10, 96)).toThrow(/corner budget/);
    expect(() => stretchNineSlice(src, insets, 96, 10)).toThrow(/corner budget/);
  });
});

describe("nine-patch encode/decode", () => {
  const content = panel(24, 6);
  const insets = { left: 6, right: 6, top: 6, bottom: 6 };

  it("round-trips insets and content pixels exactly", () => {
    const encoded = encodeNinePatch(content, insets);
    expect(encoded.width).toBe(26);
    expect(encoded.height).toBe(26);

    const decoded = decodeNinePatch(encoded);
    expect(decoded.insets).toEqual(insets);
    expect(decoded.padding).toBeNull();
    expect(decoded.content.width).toBe(24);
    expect(decoded.content.height).toBe(24);
    expect(Array.from(decoded.content.data)).toEqual(Array.from(content.data));
  });

  it("round-trips optional padding", () => {
    const padding = { left: 2, right: 3, top: 4, bottom: 5 };
    const decoded = decodeNinePatch(encodeNinePatch(content, insets, padding));
    expect(decoded.padding).toEqual(padding);
  });

  it("recognises its own output but not an ordinary sprite", () => {
    expect(isNinePatchCandidate(encodeNinePatch(content, insets))).toBe(true);
    // Opaque artwork running to the edge: the border is neither black nor clear.
    expect(isNinePatchCandidate(filledRect(16, 16, 0, 0, 16, 16))).toBe(false);
    // Transparent padding around a sprite is not a marker border either.
    expect(isNinePatchCandidate(filledRect(16, 16, 4, 4, 8, 8))).toBe(false);
    expect(isNinePatchCandidate(filledRect(2, 2, 0, 0, 1, 1))).toBe(false);
  });

  it("throws a descriptive error on a coloured border pixel", () => {
    const bad = encodeNinePatch(content, insets);
    setPixel(bad, 3, 0, [255, 0, 0, 255]);
    expect(() => decodeNinePatch(bad)).toThrow(/neither fully transparent nor opaque black/);
  });

  it("throws when an edge carries more than one stretch run", () => {
    const bad = encodeNinePatch(content, insets);
    // Punch a hole in the top run, splitting it in two.
    setPixel(bad, 12, 0, [0, 0, 0, 0]);
    expect(() => decodeNinePatch(bad)).toThrow(/only a single contiguous run is supported/);
  });

  it("throws when a required stretch run is missing", () => {
    const bad = encodeNinePatch(content, insets);
    for (let x = 1; x < bad.width - 1; x++) setPixel(bad, x, 0, [0, 0, 0, 0]);
    expect(() => decodeNinePatch(bad)).toThrow(/top border has no black stretch run/);
  });

  it("throws on an image too small to carry a border", () => {
    expect(() => decodeNinePatch(new ImageData(2, 2))).toThrow(/at least 3x3/);
  });

  it("feeds decoded insets straight back into the region layout", () => {
    const decoded = decodeNinePatch(encodeNinePatch(content, insets));
    const regions = nineSliceRegions(decoded.insets, decoded.content.width, decoded.content.height);
    expect(regions.reduce((sum, r) => sum + r.width * r.height, 0)).toBe(24 * 24);
  });
});

describe("JSON output header merge", () => {
  it("merges with another metadata section without collisions", () => {
    const header = {
      source: "panel.png",
      frameWidth: 48,
      frameHeight: 48,
      grid: { cols: 1, rows: 1, detected: false },
    };
    // Stand-in for the pivots command's output — same header, own payload key.
    const pivotLikeOutput = {
      ...header,
      pivots: [{ index: 0, cell: { row: 0, col: 0 }, x: 24, y: 47 }],
    };

    const det = detectNineSlice(panel(48, 8));
    const nineSliceOutput = {
      ...header,
      options: {
        auto: true,
        explicit: null,
        alphaThreshold: 8,
        tolerance: 0.02,
        minMiddle: 1,
      },
      nineSlice: [
        {
          index: 0,
          cell: { row: 0, col: 0 },
          insets: det.insets,
          detected: true,
          confidence: det.confidence,
          regions: nineSliceRegions(det.insets, 48, 48),
        },
      ],
    };

    const merged = Object.assign({}, pivotLikeOutput, nineSliceOutput);
    expect(Object.keys(merged).sort()).toEqual([
      "frameHeight",
      "frameWidth",
      "grid",
      "nineSlice",
      "options",
      "pivots",
      "source",
    ]);
    expect(merged.source).toBe("panel.png");
    expect(merged.grid).toEqual(header.grid);
    expect(merged.pivots).toHaveLength(1);
    expect(merged.nineSlice).toHaveLength(1);
    expect(merged.nineSlice[0].regions).toHaveLength(9);
    expect(merged.nineSlice[0].insets).toEqual({ left: 8, right: 8, top: 8, bottom: 8 });
  });
});
