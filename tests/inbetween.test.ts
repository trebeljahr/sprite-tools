import { describe, it, expect } from "vitest";
import { interpolatePoses } from "../src/lib/animation/inbetween";
import { filledRect } from "./helpers";
const recipe = {
  version: 1,
  frames: 1,
  durationMs: 150,
  easing: "linear",
  guides: [
    {
      from: [
        [2, 2],
        [2, 8],
      ],
      to: [
        [8, 2],
        [8, 8],
      ],
    },
  ],
};
describe("guided pose inbetweens", () => {
  it("moves a solid silhouette instead of fading two stationary sprites", () => {
    const a = filledRect(16, 12, 1, 3, 3, 4),
      b = filledRect(16, 12, 7, 3, 3, 4);
    const { frames, durations } = interpolatePoses(a, b, recipe);
    expect(frames).toHaveLength(3);
    expect(frames[0].data).toEqual(a.data);
    expect(frames[2].data).toEqual(b.data);
    const mid = frames[1];
    expect(mid.data[(4 * 16 + 5) * 4 + 3]).toBe(255);
    expect(mid.data[(4 * 16 + 2) * 4 + 3]).toBe(0);
    expect(mid.data[(4 * 16 + 8) * 4 + 3]).toBe(0);
    expect(durations.reduce((a, b) => a + b)).toBe(150);
    expect(a.data).toEqual(frames[0].data);
  });
  it("keeps hidden RGB out of antialiased edge colours", () => {
    const a = filledRect(16, 12, 2, 3, 3, 4, [240, 20, 10, 255]);
    const b = filledRect(16, 12, 7, 3, 3, 4, [240, 20, 10, 255]);
    for (const im of [a, b])
      for (let i = 0; i < im.data.length; i += 4)
        if (!im.data[i + 3]) {
          im.data[i] = 0;
          im.data[i + 1] = 255;
        }
    const frames = interpolatePoses(a, b, {
      ...recipe,
      guides: [
        {
          from: [
            [2, 2],
            [2, 8],
          ],
          to: [
            [7, 2],
            [7, 8],
          ],
        },
      ],
    }).frames;
    let edge = false;
    for (let i = 0; i < frames[1].data.length; i += 4)
      if (frames[1].data[i + 3]) {
        expect(frames[1].data[i + 1]).toBe(20);
        if (frames[1].data[i + 3] < 255) edge = true;
      }
    expect(edge).toBe(true);
  });
  it("preserves identical frames and does not alias input buffers", () => {
    const a = filledRect(16, 12, 2, 3, 3, 4);
    const result = interpolatePoses(a, a, {
      ...recipe,
      guides: [
        {
          from: [
            [2, 2],
            [2, 8],
          ],
          to: [
            [2, 2],
            [2, 8],
          ],
        },
      ],
    });
    expect(result.frames[1].data).toEqual(a.data);
    result.frames[0].data[0] = 99;
    expect(a.data[0]).toBe(0);
  });
  it("rejects mismatched canvases, invalid guides and oversized output", () => {
    const a = filledRect(16, 12, 1, 3, 3, 4);
    expect(() => interpolatePoses(a, new ImageData(15, 12), recipe)).toThrow(/match/);
    for (const guides of [
      [],
      [
        {
          from: [
            [2, 2],
            [2, 2],
          ],
          to: [
            [3, 2],
            [3, 8],
          ],
        },
      ],
      [
        {
          from: [
            [-1, 2],
            [2, 8],
          ],
          to: [
            [3, 2],
            [3, 8],
          ],
        },
      ],
      [
        {
          from: [
            [2, 2],
            [2, 8],
          ],
          to: [
            [2, 8],
            [2, 2],
          ],
        },
      ],
    ])
      expect(() => interpolatePoses(a, a, { ...recipe, guides })).toThrow();
    expect(() => interpolatePoses(a, a, { ...recipe, frames: 1.5 })).toThrow();
    expect(() => interpolatePoses(a, a, { ...recipe, frames: 30, durationMs: 80 })).toThrow(
      /duration/,
    );
    const huge = { width: 2048, height: 2048, data: new Uint8ClampedArray(0) };
    expect(() => interpolatePoses(huge, huge, { ...recipe, frames: 8 })).toThrow(/pixel/);
  });
});
