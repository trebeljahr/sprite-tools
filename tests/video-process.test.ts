import { describe, expect, it } from "vitest";
import { buildVideoSheet } from "../src/lib/video/process";
import { normalizeExportInput } from "../src/lib/export/types";
import { toPhaserAtlas } from "../src/lib/export/phaser";

function frame(x: number, y = 2): ImageData {
  const image = new ImageData(16, 12);
  for (let i = 0; i < image.data.length; i += 4) image.data.set([0, 255, 0, 255], i);
  for (let py = y; py < y + 6; py++)
    for (let px = x; px < x + 4; px++) {
      image.data.set([240, 20, 20, 255], (py * image.width + px) * 4);
    }
  return image;
}

describe("video sprite output contract", () => {
  it("keys green, keeps one crop for all frames and emits matching collision and timing", () => {
    const { sheet, metadata } = buildVideoSheet([frame(2), frame(4), frame(6)], {
      fps: 8,
      frameWidth: 32,
      columns: 2,
      padding: 1,
      name: "walk",
      choke: 0,
    });
    expect(metadata.frameCount).toBe(3);
    expect(metadata.grid).toEqual({ cols: 2, rows: 2 });
    expect(sheet.width).toBe(metadata.frameWidth * 2);
    expect(sheet.height).toBe(metadata.frameHeight * 2);
    expect(metadata.processing.crop).toEqual({ x: 1, y: 1, width: 10, height: 8 });
    expect(metadata.frameDurations).toEqual([125, 125, 125]);
    expect(sheet.data[3]).toBe(0);
    expect(metadata.collision.every((item) => item.polygon.length >= 3)).toBe(true);
    expect(metadata.collision[0].bounds!.x).toBeLessThan(metadata.collision[2].bounds!.x);
    expect(metadata.pivots.map((item) => item.pivot)).toEqual(
      Array(3).fill(metadata.pivots[0].pivot),
    );
    expect(metadata.tags).toEqual([{ name: "walk", from: 0, to: 2, fps: 8, direction: "forward" }]);
  });

  it("exports only real frames when the final sheet row has empty cells", () => {
    const { metadata } = buildVideoSheet([frame(2), frame(4), frame(6)], { columns: 2 });
    const normalized = normalizeExportInput(JSON.parse(JSON.stringify(metadata)));
    expect(normalized.frames).toHaveLength(3);
    expect(normalized.frames.map((item) => item.durationMs)).toEqual([125, 125, 125]);
    expect(normalized.frames.every((item) => item.polygon?.length)).toBe(true);
    const phaser = toPhaserAtlas(normalized, { layout: "array" });
    expect(phaser.frames).toHaveLength(3);
    expect(normalized.texture).toBe("sheet.png");
  });

  it("leaves caller pixels untouched", () => {
    const input = frame(2),
      before = new Uint8ClampedArray(input.data);
    buildVideoSheet([input]);
    expect(input.data).toEqual(before);
  });

  it("rejects empty output, mixed frame sizes and unbounded frame counts", () => {
    const green = frame(2);
    for (let i = 0; i < green.data.length; i += 4) green.data.set([0, 255, 0, 255], i);
    expect(() => buildVideoSheet([green])).toThrow(/no visible pixels/);
    expect(() => buildVideoSheet([])).toThrow(/1–120/);
    expect(() => buildVideoSheet(Array(121).fill(frame(2)))).toThrow(/1–120/);
    expect(() => buildVideoSheet([frame(2), new ImageData(3, 3)])).toThrow(/dimensions/);
    expect(() => buildVideoSheet([frame(2)], { frameWidth: 4096 })).toThrow();
  });

  it("keeps a fully transparent sampled frame in the animation", () => {
    const clear = new ImageData(16, 12);
    const { metadata } = buildVideoSheet([frame(2), clear, frame(6)]);
    expect(metadata.frameCount).toBe(3);
    expect(metadata.collision[1].polygon).toEqual([]);
    expect(metadata.collision[1].bounds).toBeNull();
    expect(metadata.hitboxes[1].bounds).toBeNull();
  });

  it("includes detached parts in the bounding hitbox even when the contour ignores them", () => {
    const input = frame(2);
    input.data.set([20, 20, 240, 255], (5 * input.width + 14) * 4);
    const { metadata } = buildVideoSheet([input], { choke: 0, padding: 0, frameWidth: 26 });
    const hitbox = metadata.hitboxes[0].bounds!;
    const polygonBounds = metadata.collision[0].bounds!;
    expect(hitbox.width).toBe(26);
    expect(hitbox.width).toBeGreaterThan(polygonBounds.width);
    expect(metadata.hitboxes[0].type).toBe("aabb");
  });

  it("recomputes crop, hitboxes and tags from only the final selected frames", () => {
    const { metadata } = buildVideoSheet([frame(0), frame(2), frame(4), frame(10)], {
      fps: 10,
      startSeconds: 0.1,
      endSeconds: 0.3,
      choke: 0,
      padding: 0,
      frameWidth: 24,
    });
    expect(metadata.frameCount).toBe(2);
    expect(metadata.sourceFrameIndices).toEqual([1, 2]);
    expect(metadata.processing.crop).toEqual({ x: 2, y: 2, width: 6, height: 6 });
    expect(metadata.frameDurations).toEqual([100, 100]);
    expect(metadata.selection).toMatchObject({
      startSeconds: 0.1,
      endSeconds: 0.3,
      durationSeconds: 0.2,
      inputFrameCount: 2,
      outputFrameCount: 2,
    });
    expect(metadata.hitboxes).toHaveLength(2);
    expect(metadata.collision).toHaveLength(2);
    expect(metadata.tags[0].to).toBe(1);
  });

  it("keeps exact duration after thinning and validates crossfields at the direct entry", () => {
    const input = Array.from({ length: 24 }, (_, index) => frame(2 + (index % 6)));
    const { metadata } = buildVideoSheet(input, { fps: 24, maxFrames: 5 });
    expect(metadata.frameCount).toBe(5);
    expect(metadata.frameDurations.reduce((a, b) => a + b, 0)).toBe(1000);
    expect(metadata.selection.durationSeconds).toBe(1);
    expect(metadata.sourceFrameIndices[0]).toBe(0);
    expect(metadata.sourceFrameIndices.at(-1)).toBe(23);
    expect(() => buildVideoSheet(input, { startSeconds: 1, endSeconds: 0.5 })).toThrow(/later/);
    expect(() => buildVideoSheet(input, { loopMinSeconds: 2, loopMaxSeconds: 1 })).toThrow(
      /Minimum/,
    );
    expect(() => buildVideoSheet(input, { endSeconds: 5 })).toThrow(/within/);
  });
});
