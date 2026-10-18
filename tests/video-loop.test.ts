import { describe, expect, it } from "vitest";
import { selectVideoFrames, resolveVideoTrim } from "../src/lib/video/loop";
import { validateProcessing } from "../src/lib/video/schema";
import type { FrameImageLike } from "../src/lib/pipeline/dedupe-core";

function pose(value: number): FrameImageLike {
  return { width: 1, height: 1, data: new Uint8ClampedArray([value, value, value, 255]) };
}
const sequence = (...values: number[]) => values.map(pose);
const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);

describe("video loop selection", () => {
  it("selects the shortest whole cycle and excludes its matching end boundary", () => {
    const result = selectVideoFrames(sequence(20, 80, 140, 200, 20, 80, 140, 200, 20, 80), {
      fps: 10,
      loopMode: "auto",
      loopMinSeconds: 0.3,
      loopMaxSeconds: 1,
    });
    expect(result.sourceFrameIndices).toEqual([0, 1, 2, 3]);
    expect(result.frameDurations).toEqual([100, 100, 100, 100]);
    expect(result.selection).toMatchObject({
      loopFound: true,
      seamScore: 0,
      durationSeconds: 0.4,
      inputFrameCount: 10,
      outputFrameCount: 4,
    });
  });

  it("uses the following pose to reject a matching still with the wrong motion", () => {
    const result = selectVideoFrames(sequence(20, 80, 140, 20, 200, 80, 20, 80), {
      fps: 10,
      loopMode: "auto",
      loopMinSeconds: 0.3,
      loopMaxSeconds: 0.7,
    });
    expect(result.sourceFrameIndices).toEqual([0, 1, 2, 3, 4, 5]);
    expect(result.selection.seamScore).toBe(0);
  });

  it("skips a static introduction and keeps static-only clips with an honest note", () => {
    const moving = selectVideoFrames(sequence(20, 20, 20, 20, 20, 80, 140, 200, 20, 80), {
      fps: 10,
      loopMode: "auto",
      loopMinSeconds: 0.2,
      loopMaxSeconds: 0.5,
    });
    expect(moving.sourceFrameIndices).toEqual([4, 5, 6, 7]);
    const still = selectVideoFrames(sequence(20, 20, 20, 20, 20, 20), {
      fps: 10,
      loopMode: "auto",
    });
    expect(still.sourceFrameIndices).toEqual([0, 1, 2, 3, 4, 5]);
    expect(still.selection).toMatchObject({ loopFound: false, durationSeconds: 0.6 });
    expect(still.selection.note).toContain("No moving loop found");
    expect(still.selection.seamScore).toBeUndefined();
  });

  it("keeps chronology and sums adjacent holds without globally merging repeated poses", () => {
    const result = selectVideoFrames(sequence(20, 20, 80, 140, 140, 80), {
      fps: 10,
      dedupeThreshold: 0,
    });
    expect(result.sourceFrameIndices).toEqual([0, 2, 3, 5]);
    expect(result.frames.map((frame) => frame.data[0])).toEqual([20, 80, 140, 80]);
    expect(result.frameDurations).toEqual([200, 100, 200, 100]);
    expect(sum(result.frameDurations)).toBe(600);
  });

  it("compares a fuzzy run to its retained pose, avoiding transitive drift", () => {
    const result = selectVideoFrames(sequence(20, 24, 28), { fps: 10, dedupeThreshold: 3 });
    expect(result.sourceFrameIndices).toEqual([0, 2]);
    expect(result.frameDurations).toEqual([200, 100]);
  });

  it("uniformly thins through the whole interval without speeding it up", () => {
    const result = selectVideoFrames(sequence(0, 20, 40, 60, 80, 100, 120, 140, 160, 180), {
      fps: 10,
      maxFrames: 4,
    });
    expect(result.sourceFrameIndices).toEqual([0, 3, 6, 9]);
    expect(result.frameDurations).toEqual([300, 300, 300, 100]);
    expect(sum(result.frameDurations)).toBe(1000);
    expect(result.selection.durationSeconds).toBe(1);
  });

  it("samples by elapsed time after dedupe and preserves long holds", () => {
    const result = selectVideoFrames(sequence(20, 20, 20, 20, 20, 20, 80, 140, 200, 240), {
      fps: 10,
      maxFrames: 3,
      dedupeThreshold: 0,
    });
    expect(result.sourceFrameIndices).toEqual([0, 9]);
    expect(result.frameDurations).toEqual([900, 100]);
    expect(result.selection.outputFrameCount).toBeLessThanOrEqual(3);
  });

  it("uses cumulative millisecond boundaries so 24fps totals exactly one second", () => {
    const result = selectVideoFrames(
      Array.from({ length: 24 }, (_, index) => pose(index * 10)),
      { fps: 24 },
    );
    expect(sum(result.frameDurations)).toBe(1000);
    expect(new Set(result.frameDurations)).toEqual(new Set([41, 42]));
    expect(result.selection.durationSeconds).toBe(1);
  });

  it("trims with partial boundary holds and keeps absolute pose times", () => {
    const result = selectVideoFrames(sequence(20, 80, 140, 200, 240), {
      fps: 10,
      startSeconds: 0.15,
      endSeconds: 0.43,
    });
    expect(result.sourceFrameIndices).toEqual([1, 2, 3, 4]);
    expect(result.sourceFrameTimesSeconds).toEqual([0.1, 0.2, 0.3, 0.4]);
    expect(result.frameDurations).toEqual([50, 100, 100, 30]);
    expect(result.selection).toMatchObject({
      startSeconds: 0.15,
      endSeconds: 0.43,
      durationSeconds: 0.28,
    });
  });

  it("does not apply explicit trim twice to frames already decoded with a seek", () => {
    const result = selectVideoFrames(
      sequence(20, 80, 140),
      { fps: 10, startSeconds: 2, endSeconds: 2.25 },
      { startSeconds: 2, endSeconds: 2.25 },
    );
    expect(result.sourceFrameIndices).toEqual([0, 1, 2]);
    expect(result.sourceFrameTimesSeconds).toEqual([2, 2.1, 2.2]);
    expect(result.frameDurations).toEqual([100, 100, 50]);
    expect(result.selection.durationSeconds).toBe(0.25);
  });

  it("enforces trim and sampling bounds independently of output frame limits", () => {
    expect(() => validateProcessing({ startSeconds: 1, endSeconds: 1 })).toThrow(/later/);
    expect(() => validateProcessing({ loopMinSeconds: 2, loopMaxSeconds: 1 })).toThrow(/Minimum/);
    expect(() => resolveVideoTrim(4, validateProcessing({ endSeconds: 5 }))).toThrow(/within/);
    expect(() => resolveVideoTrim(4, validateProcessing({ startSeconds: 4 }))).toThrow(/within/);
    expect(() => resolveVideoTrim(6, validateProcessing({ fps: 24, maxFrames: 12 }))).toThrow(
      /120/,
    );
    expect(
      resolveVideoTrim(6, validateProcessing({ fps: 24, startSeconds: 1, endSeconds: 5 })),
    ).toEqual({ startSeconds: 1, endSeconds: 5 });
  });

  it("ignores hidden RGB and does not lose tiny foreground motion in a large canvas", () => {
    const tiny = (value: number, hidden: number) => {
      const data = new Uint8ClampedArray(128 * 128 * 4);
      for (let i = 0; i < data.length; i += 4) data[i] = hidden;
      data.set([value, value, value, 255], (64 * 128 + 64) * 4);
      return { width: 128, height: 128, data };
    };
    const result = selectVideoFrames(
      [20, 80, 140, 200, 20, 80].map((value, i) => tiny(value, i * 30)),
      { fps: 10, loopMode: "auto" },
    );
    expect(result.sourceFrameIndices).toEqual([0, 1, 2, 3]);
    expect(result.selection.seamScore).toBe(0);
  });

  it("does not merge tiny moving sprites against a large transparent canvas", () => {
    const frames = [40, 41, 42].map((x) => {
      const data = new Uint8ClampedArray(128 * 128 * 4);
      data.set([255, 255, 255, 255], (64 * 128 + x) * 4);
      return { width: 128, height: 128, data };
    });
    const result = selectVideoFrames(frames, { fps: 10, dedupeThreshold: 1 });
    expect(result.sourceFrameIndices).toEqual([0, 1, 2]);
    expect(result.frameDurations).toEqual([100, 100, 100]);
  });

  it("does not mistake a clipped initial hold for a shorter cycle", () => {
    const result = selectVideoFrames(
      sequence(20, 60, 100, 140, 180, 20, 60, 100, 140, 180, 20, 60),
      {
        fps: 10,
        startSeconds: 0.15,
        loopMode: "auto",
        loopMinSeconds: 0.4,
      },
    );
    expect(result.selection.durationSeconds).toBe(0.5);
    expect(result.sourceFrameIndices).toEqual([2, 3, 4, 5, 6]);
  });
});
