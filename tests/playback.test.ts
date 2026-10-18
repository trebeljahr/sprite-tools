import { describe, expect, it } from "vitest";
import { frameAtTime } from "../src/lib/animation/playback";

describe("variable-hold playback", () => {
  it("honors long holds and exact frame boundaries", () => {
    expect(
      [0, 99, 100, 399, 400, 499, 500].map((time) => frameAtTime([100, 300, 100], time)),
    ).toEqual([0, 0, 1, 1, 2, 2, 0]);
  });
  it("wraps after missed animation ticks and at negative offsets", () => {
    expect(frameAtTime([100, 300, 100], 1650)).toBe(1);
    expect(frameAtTime([100, 300, 100], -1)).toBe(2);
    expect(frameAtTime([], 100)).toBe(0);
  });
});
