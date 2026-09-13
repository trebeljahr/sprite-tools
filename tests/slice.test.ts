import { describe, expect, it } from "vitest";
import { sliceSheet, stitchSheet } from "../cli/lib/image-io";
import { GridFitError } from "@/lib/pipeline/grid";
import { cellColor, circleSheet, colorKey, filledRect, paddedSheet, uniqueColors } from "./helpers";

/**
 * The old flush slice, rewritten per-pixel from the definition rather than
 * copied from image-io. Independent on purpose: comparing sliceSheet against a
 * row-wise clone of itself would prove nothing.
 */
function referenceFlushSlice(img: ImageData, cols: number, rows: number): ImageData[] {
  const cellW = Math.floor(img.width / cols);
  const cellH = Math.floor(img.height / rows);
  const out: ImageData[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const frame = new ImageData(cellW, cellH);
      for (let y = 0; y < cellH; y++) {
        for (let x = 0; x < cellW; x++) {
          const src = ((r * cellH + y) * img.width + (c * cellW + x)) * 4;
          const dst = (y * cellW + x) * 4;
          frame.data[dst] = img.data[src];
          frame.data[dst + 1] = img.data[src + 1];
          frame.data[dst + 2] = img.data[src + 2];
          frame.data[dst + 3] = img.data[src + 3];
        }
      }
      out.push(frame);
    }
  }
  return out;
}

/** Index of the first differing byte, or -1. Beats expect().toEqual on 160k-byte arrays. */
function firstDiff(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  if (a.length !== b.length) return 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return i;
  return -1;
}

describe("sliceSheet — flush regression guard", () => {
  // Padding support must not disturb a single byte of the flush path. Every
  // existing sheet in the wild goes through it.
  it.each([
    ["divisible 2x2", () => circleSheet(2, 2, 32, 12), 2, 2],
    ["divisible 5x5", () => circleSheet(5, 5, 40, 14), 5, 5],
    ["non-square 3x4", () => circleSheet(3, 4, 32, 12), 3, 4],
    ["opaque content", () => filledRect(96, 64, 10, 10, 40, 30), 3, 2],
    // 208x140 into 6x4 does NOT divide: cells floor to 34x35 and the right/bottom
    // remainder is dropped. Pinned deliberately — that is today's behaviour.
    [
      "non-divisible 6x4",
      () => paddedSheet({ cols: 6, rows: 4, cellW: 32, cellH: 32, margin: 3, spacing: 2 }),
      6,
      4,
    ],
  ])("%s matches a from-scratch flush reference byte for byte", (_name, build, cols, rows) => {
    const img = build();
    const actual = sliceSheet(img, cols, rows);
    const expected = referenceFlushSlice(img, cols, rows);

    expect(actual).toHaveLength(expected.length);
    for (let i = 0; i < expected.length; i++) {
      expect([actual[i].width, actual[i].height]).toEqual([expected[i].width, expected[i].height]);
      const diff = firstDiff(actual[i].data, expected[i].data);
      expect(diff, `frame ${i} differs from the flush reference at byte ${diff}`).toBe(-1);
    }
  });

  it("keeps returning [] for a degenerate grid", () => {
    expect(sliceSheet(circleSheet(2, 2, 32, 12), 0, 2)).toEqual([]);
    expect(sliceSheet(circleSheet(2, 2, 32, 12), 2, -1)).toEqual([]);
  });

  it("still returns [] when the sheet is smaller than the grid", () => {
    expect(sliceSheet(filledRect(4, 4, 0, 0, 4, 4), 8, 8)).toEqual([]);
  });
});

describe("sliceSheet — padded sheets", () => {
  // 6x4 of 32px cells, margin 3, spacing 2 => 208x140. Each cell is a single
  // distinct colour, so "did a neighbour or a gutter leak in" is one assertion.
  const build = () =>
    paddedSheet({ cols: 6, rows: 4, cellW: 32, cellH: 32, margin: 3, spacing: 2 });

  it("the fixture really is the failing shape", () => {
    const img = build();
    expect([img.width, img.height]).toEqual([208, 140]);
    expect(img.width % 6).not.toBe(0);
  });

  it("slicing WITH the padding yields frames that are each exactly one colour", () => {
    const img = build();
    const frames = sliceSheet(img, 6, 4, { margin: 3, spacing: 2 });

    expect(frames).toHaveLength(24);
    frames.forEach((frame, i) => {
      expect([frame.width, frame.height]).toEqual([32, 32]);
      // One colour === zero gutter pixels and zero neighbour pixels.
      expect(uniqueColors(frame)).toEqual([colorKey(cellColor(i))]);
    });
  });

  it("slicing WITHOUT the padding is contaminated (the bug this feature removes)", () => {
    // Locks in that the fixture above actually exercises the failure. If this
    // ever goes green, the fixture stopped being a real test.
    const img = build();
    const frames = sliceSheet(img, 6, 4);

    // Flush cells are 34x35, not 32x32 — already the wrong size.
    expect([frames[0].width, frames[0].height]).toEqual([34, 35]);

    const transparent = "0,0,0,0";
    // Frame 0 drags in the top-left margin.
    expect(uniqueColors(frames[0])).toContain(transparent);
    expect(uniqueColors(frames[0]).length).toBeGreaterThan(1);

    // Frame 1 is the real damage: it contains pixels belonging to cell 0.
    const bleed = uniqueColors(frames[1]);
    expect(bleed).toContain(colorKey(cellColor(0))); // the neighbour
    expect(bleed).toContain(colorKey(cellColor(1))); // its own cell
    expect(bleed).toContain(transparent); // the gutter

    // Not one frame survives clean.
    expect(frames.filter((f) => uniqueColors(f).length === 1)).toHaveLength(0);
  });

  it("handles an asymmetric border", () => {
    const margin = { left: 5, right: 1, top: 3, bottom: 3 };
    const img = paddedSheet({ cols: 6, rows: 4, cellW: 32, cellH: 32, margin, spacing: 2 });
    const frames = sliceSheet(img, 6, 4, { margin, spacing: 2 });
    frames.forEach((frame, i) => {
      expect(uniqueColors(frame)).toEqual([colorKey(cellColor(i))]);
    });
  });

  it("handles spacing with no margin, and margin with no spacing", () => {
    const gutterOnly = paddedSheet({ cols: 4, rows: 2, cellW: 16, cellH: 16, spacing: 3 });
    sliceSheet(gutterOnly, 4, 2, { spacing: 3 }).forEach((f, i) => {
      expect(uniqueColors(f)).toEqual([colorKey(cellColor(i))]);
    });

    const borderOnly = paddedSheet({ cols: 4, rows: 2, cellW: 16, cellH: 16, margin: 5 });
    sliceSheet(borderOnly, 4, 2, { margin: 5 }).forEach((f, i) => {
      expect(uniqueColors(f)).toEqual([colorKey(cellColor(i))]);
    });
  });

  it("zero padding is byte-identical to passing nothing", () => {
    const img = circleSheet(3, 4, 32, 12);
    const withZero = sliceSheet(img, 3, 4, { margin: 0, spacing: 0 });
    const without = sliceSheet(img, 3, 4);
    expect(withZero).toHaveLength(without.length);
    for (let i = 0; i < without.length; i++) {
      expect(firstDiff(withZero[i].data, without[i].data)).toBe(-1);
    }
  });

  it("propagates GridFitError rather than slicing something wrong", () => {
    const img = build();
    // 208 - 3 - 3 - 5*4 = 182, not divisible by 6.
    expect(() => sliceSheet(img, 6, 4, { margin: 3, spacing: 4 })).toThrow(GridFitError);
    expect(() => sliceSheet(img, 6, 4, { margin: 3, spacing: 4 })).toThrow(/208/);
  });
});

describe("stitchSheet", () => {
  it("packs padded frames back flush — the gutters are not restored", () => {
    // Documenting current behaviour, not endorsing it: slice-with-padding then
    // stitch is lossy on geometry. The frames survive intact and each cell of the
    // output is still exactly one colour, but the sheet comes back 192x128
    // instead of 208x140.
    const img = paddedSheet({ cols: 6, rows: 4, cellW: 32, cellH: 32, margin: 3, spacing: 2 });
    const frames = sliceSheet(img, 6, 4, { margin: 3, spacing: 2 });
    const out = stitchSheet(frames, 6, 4);

    expect([out.width, out.height]).toEqual([192, 128]);
    const reframed = sliceSheet(out, 6, 4);
    reframed.forEach((frame, i) => {
      expect(uniqueColors(frame)).toEqual([colorKey(cellColor(i))]);
    });
  });
});
