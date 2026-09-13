import { describe, expect, it } from "vitest";
import {
  applyDedupe,
  buildTagPartitions,
  findDuplicateFrames,
  frameHash,
  meanAbsoluteDifference,
  parseTagsDocument,
  remapFrameDurations,
  remapTags,
} from "@/lib/pipeline/dedupe-core";
import { blank, circle, filledRect } from "./helpers";

function clone(img: ImageData): ImageData {
  const copy = new ImageData(img.width, img.height);
  copy.data.set(img.data);
  return copy;
}

/** Add `delta` to a single channel of a single pixel. Channel: 0=R 1=G 2=B 3=A. */
function bump(img: ImageData, x: number, y: number, channel: number, delta: number): ImageData {
  const copy = clone(img);
  const i = (y * img.width + x) * 4 + channel;
  copy.data[i] = copy.data[i] + delta;
  return copy;
}

// A 4x4 frame has 4*4*4 = 64 channels, so bumping one channel by D yields a
// mean absolute difference of exactly D/64. Every threshold assertion below is
// derived from that number by hand, so changing the metric breaks these loudly.
const CHANNELS_4x4 = 64;
// Opaque black: every pixel visible, so a bumped RGB channel really counts
// (RGB under alpha 0 is ignored by design — see "ignores RGB hidden under ...").
const BASE = filledRect(4, 4, 0, 0, 4, 4, [0, 0, 0, 255]);

describe("frameHash", () => {
  it("matches for identical buffers and differs for different pixels", () => {
    const a = filledRect(8, 8, 1, 1, 3, 3);
    const b = clone(a);
    expect(frameHash(a)).toBe(frameHash(b));
    expect(frameHash(a)).not.toBe(frameHash(bump(a, 1, 1, 0, -5)));
  });

  it("separates equal-length buffers with different dimensions", () => {
    // 4x4 and 2x8 are both 64 zero bytes; only the dimensions tell them apart.
    expect(frameHash(blank(4, 4))).not.toBe(frameHash(blank(2, 8)));
  });
});

describe("meanAbsoluteDifference", () => {
  it("is 0 for identical frames and D/channels for a single bumped channel", () => {
    expect(meanAbsoluteDifference(BASE, clone(BASE))).toBe(0);
    expect(meanAbsoluteDifference(BASE, bump(BASE, 0, 0, 0, 32))).toBeCloseTo(
      32 / CHANNELS_4x4,
      10,
    );
  });

  it("is Infinity when the dimensions differ", () => {
    expect(meanAbsoluteDifference(blank(4, 4), blank(2, 8))).toBe(Infinity);
    expect(meanAbsoluteDifference(blank(4, 4), blank(5, 5))).toBe(Infinity);
  });
});

describe("findDuplicateFrames — exact pass", () => {
  it("collapses identical buffers and reports remap, keptIndices and groups", () => {
    const a = filledRect(8, 8, 0, 0, 4, 4);
    const b = circle(8, 8, 4, 4, 3);
    const frames = [a, clone(a), b, clone(a)];

    const result = findDuplicateFrames(frames);

    expect(result.method).toBe("exact");
    expect(result.threshold).toBe(0);
    expect(result.frameCount).toBe(4);
    expect(result.uniqueCount).toBe(2);
    expect(result.removedCount).toBe(2);
    expect(result.keptIndices).toEqual([0, 2]);
    expect(result.remap).toEqual([0, 0, 1, 0]);
    expect(result.groups).toEqual([{ keep: 0, duplicates: [1, 3], distances: [0, 0] }]);
  });

  it("keeps distinct frames separate and never merges different dimensions", () => {
    const frames = [filledRect(8, 8, 0, 0, 4, 4), circle(8, 8, 4, 4, 3), blank(4, 4), blank(2, 8)];

    const result = findDuplicateFrames(frames, { threshold: 4 });

    expect(result.uniqueCount).toBe(4);
    expect(result.keptIndices).toEqual([0, 1, 2, 3]);
    expect(result.groups).toEqual([]);
  });

  it("returns a well-formed empty result for empty input", () => {
    expect(findDuplicateFrames([])).toEqual({
      method: "exact",
      threshold: 0,
      frameCount: 0,
      uniqueCount: 0,
      removedCount: 0,
      keptIndices: [],
      remap: [],
      groups: [],
    });
  });

  it("returns a single frame unchanged", () => {
    const result = findDuplicateFrames([filledRect(4, 4, 0, 0, 2, 2)], { threshold: 2 });
    expect(result.uniqueCount).toBe(1);
    expect(result.keptIndices).toEqual([0]);
    expect(result.remap).toEqual([0]);
    expect(result.groups).toEqual([]);
  });
});

describe("findDuplicateFrames — MAE pass", () => {
  it("merges a near-duplicate just below the threshold", () => {
    // One channel off by 63 => MAE 63/64 = 0.984375, just under 1.
    const near = bump(BASE, 1, 1, 0, 63);
    const result = findDuplicateFrames([BASE, near], { threshold: 1 });

    expect(result.method).toBe("mae");
    expect(result.uniqueCount).toBe(1);
    expect(result.keptIndices).toEqual([0]);
    expect(result.remap).toEqual([0, 0]);
    expect(result.groups[0].keep).toBe(0);
    expect(result.groups[0].duplicates).toEqual([1]);
    expect(result.groups[0].distances[0]).toBeCloseTo(63 / CHANNELS_4x4, 10);
  });

  it("merges a near-duplicate sitting exactly on the threshold", () => {
    // 64/64 === 1.0 exactly: the threshold is inclusive.
    const result = findDuplicateFrames([BASE, bump(BASE, 1, 1, 0, 64)], { threshold: 1 });
    expect(result.uniqueCount).toBe(1);
    expect(result.groups[0].distances[0]).toBeCloseTo(1, 10);
  });

  it("does NOT merge a near-duplicate just above the threshold", () => {
    // One channel off by 65 => MAE 65/64 = 1.015625, just over 1.
    const result = findDuplicateFrames([BASE, bump(BASE, 1, 1, 0, 65)], { threshold: 1 });
    expect(result.uniqueCount).toBe(2);
    expect(result.keptIndices).toEqual([0, 1]);
    expect(result.groups).toEqual([]);
  });

  it("treats an alpha-only difference as a real difference", () => {
    const opaque = filledRect(4, 4, 0, 0, 4, 4, [10, 20, 30, 255]);
    const translucent = filledRect(4, 4, 0, 0, 4, 4, [10, 20, 30, 128]);

    // Identical RGB, different alpha: never byte-equal...
    const exact = findDuplicateFrames([opaque, translucent]);
    expect(exact.uniqueCount).toBe(2);
    expect(exact.groups).toEqual([]);

    // ...and alpha is weighted like any other channel, so the MAE is large.
    expect(meanAbsoluteDifference(opaque, translucent)).toBeCloseTo((127 * 16) / CHANNELS_4x4, 10);
    expect(findDuplicateFrames([opaque, translucent], { threshold: 4 }).uniqueCount).toBe(2);
  });

  it("merges alpha-only differences once the threshold reaches their distance", () => {
    // One pixel's alpha drops 255 -> 127: MAE = 128/64 = 2.
    const opaque = filledRect(4, 4, 0, 0, 4, 4, [10, 20, 30, 255]);
    const faded = bump(opaque, 0, 0, 3, -128);
    expect(meanAbsoluteDifference(opaque, faded)).toBe(2);
    expect(findDuplicateFrames([opaque, faded], { threshold: 1.99 }).uniqueCount).toBe(2);
    expect(findDuplicateFrames([opaque, faded], { threshold: 2 }).uniqueCount).toBe(1);
  });

  it("ignores RGB hidden under fully transparent pixels", () => {
    // Both frames are invisible everywhere; only the RGB under alpha 0 differs.
    const clear = filledRect(4, 4, 0, 0, 4, 4, [0, 0, 0, 0]);
    const garbage = filledRect(4, 4, 0, 0, 4, 4, [200, 200, 200, 0]);
    expect(meanAbsoluteDifference(clear, garbage)).toBe(0);
    expect(frameHash(clear)).toBe(frameHash(garbage));
    const result = findDuplicateFrames([clear, garbage]);
    expect(result.method).toBe("exact");
    expect(result.groups).toEqual([{ keep: 0, duplicates: [1], distances: [0] }]);

    // A visible pixel still counts, RGB included.
    const visible = bump(garbage, 0, 0, 3, 1); // alpha 1 exposes RGB 200,200,200
    expect(meanAbsoluteDifference(clear, visible)).toBe((200 * 3 + 1) / CHANNELS_4x4);
  });

  it("merges a whole exact group into an earlier near-duplicate with aligned distances", () => {
    // [C, A, B, A, C]: A and C are exact pairs; B is 16/64 = 0.25 from C, A is 16/64 from C.
    const c = BASE;
    const a = bump(BASE, 0, 0, 0, 16);
    const b = bump(BASE, 1, 0, 1, 16);
    const result = findDuplicateFrames([c, a, b, clone(a), clone(c)], { threshold: 1 });

    expect(result.method).toBe("mae");
    expect(result.keptIndices).toEqual([0]);
    expect(result.remap).toEqual([0, 0, 0, 0, 0]);
    expect(result.groups).toEqual([
      { keep: 0, duplicates: [1, 2, 3, 4], distances: [0.25, 0.25, 0.25, 0] },
    ]);
  });

  it("keeps near-duplicates in different partitions apart in the MAE pass", () => {
    const a = BASE;
    const near = bump(BASE, 0, 0, 0, 16); // 0.25 away
    expect(findDuplicateFrames([a, near], { threshold: 1 }).uniqueCount).toBe(1);

    const split = findDuplicateFrames([a, near, clone(near)], {
      threshold: 1,
      partitions: [0, 1, 1],
    });
    expect(split.keptIndices).toEqual([0, 1]);
    expect(split.remap).toEqual([0, 1, 1]);
    expect(split.groups).toEqual([{ keep: 1, duplicates: [2], distances: [0] }]);
  });

  it("is greedy first-match and never chains transitively", () => {
    // MAE(a,b) = MAE(b,c) = 60/64 = 0.9375 <= 1, but MAE(a,c) = 120/64 = 1.875 > 1.
    const a = BASE;
    const b = bump(BASE, 1, 1, 0, 60);
    const c = bump(BASE, 1, 1, 0, 120);
    expect(meanAbsoluteDifference(b, c)).toBeCloseTo(60 / CHANNELS_4x4, 10);

    const result = findDuplicateFrames([a, b, c], { threshold: 1 });

    expect(result.uniqueCount).toBe(2);
    expect(result.keptIndices).toEqual([0, 2]);
    expect(result.remap).toEqual([0, 0, 1]);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]).toMatchObject({ keep: 0, duplicates: [1] });
  });

  it("confines merging to a shared partition", () => {
    const a = filledRect(8, 8, 0, 0, 4, 4);
    const frames = [a, clone(a), clone(a)];

    const free = findDuplicateFrames(frames);
    expect(free.keptIndices).toEqual([0]);

    const partitioned = findDuplicateFrames(frames, { partitions: [0, 1, 1] });
    expect(partitioned.keptIndices).toEqual([0, 1]);
    expect(partitioned.remap).toEqual([0, 1, 1]);
    expect(partitioned.groups).toEqual([{ keep: 1, duplicates: [2], distances: [0] }]);
  });

  it("throws when partitions and frames disagree in length", () => {
    expect(() => findDuplicateFrames([BASE, clone(BASE)], { partitions: [0] })).toThrow(
      /partitions\.length/,
    );
  });
});

describe("applyDedupe", () => {
  it("keeps the per-frame items at keptIndices", () => {
    const a = filledRect(4, 4, 0, 0, 2, 2);
    const result = findDuplicateFrames([a, clone(a), blank(4, 4), clone(a)]);
    expect(applyDedupe(["idle-0", "idle-1", "blank", "idle-3"], result)).toEqual([
      "idle-0",
      "blank",
    ]);
  });
});

describe("remapTags", () => {
  // [X, X, Y, Z] — frames 0 and 1 are identical, so everything after shifts down.
  function shiftedSheet() {
    const x = filledRect(4, 4, 0, 0, 2, 2);
    return findDuplicateFrames([x, clone(x), circle(4, 4, 2, 2, 1), blank(4, 4)]);
  }

  it("shifts a later range down after earlier frames were removed", () => {
    const result = shiftedSheet();
    expect(result.remap).toEqual([0, 0, 1, 2]);

    const { tags, warnings } = remapTags([{ name: "run", from: 2, to: 3 }], result);

    expect(tags[0].frames).toEqual([1, 2]);
    expect(tags[0].from).toBe(1);
    expect(tags[0].to).toBe(2);
    expect(tags[0].contiguous).toBe(true);
    expect(warnings).toEqual([]);
  });

  it("shrinks a range whose interior frames were duplicates", () => {
    const result = shiftedSheet();
    const { tags, warnings } = remapTags([{ name: "idle", from: 0, to: 1 }], result);

    expect(tags[0].frames).toEqual([0]);
    expect(tags[0].from).toBe(0);
    expect(tags[0].to).toBe(0);
    expect(tags[0].contiguous).toBe(true);
    expect(warnings.some((w) => w.includes('"idle"') && w.includes("shrank"))).toBe(true);
    expect(warnings.some((w) => w.includes('"idle"') && w.includes("single frame"))).toBe(true);
  });

  it("reports a range that became non-contiguous by merging into an earlier tag", () => {
    // [A, B, C, A] — the pose opening "run" is byte-identical to idle's frame 0.
    const a = filledRect(4, 4, 0, 0, 2, 2);
    const result = findDuplicateFrames([a, circle(4, 4, 2, 2, 1), blank(4, 4), clone(a)]);
    expect(result.remap).toEqual([0, 1, 2, 0]);

    const { tags, warnings } = remapTags(
      [
        { name: "idle", from: 0, to: 1 },
        { name: "run", from: 2, to: 3 },
      ],
      result,
    );

    expect(tags[0]).toMatchObject({ name: "idle", frames: [0, 1], contiguous: true });
    expect(tags[1].frames).toEqual([2, 0]);
    expect(tags[1].from).toBe(0);
    expect(tags[1].to).toBe(2);
    expect(tags[1].contiguous).toBe(false);
    const warning = warnings.find((w) => w.includes('"run"') && w.includes("contiguous"));
    expect(warning).toMatch(/matched frames outside the tag/);
    expect(warning).toMatch(/--respect-tags/);
    expect(warning).not.toMatch(/repeats one of its own poses/);
  });

  it("names an internal repeat, not cross-tag merging, when a partitioned tag loops", () => {
    // [A, B, A, B] inside one partition: partitions cannot restore contiguity.
    const a = filledRect(4, 4, 0, 0, 2, 2);
    const b = circle(4, 4, 2, 2, 1);
    const result = findDuplicateFrames([a, b, clone(a), clone(b)], { partitions: [0, 0, 0, 0] });
    const { tags, warnings } = remapTags([{ name: "walk", from: 0, to: 3 }], result);

    expect(tags[0].frames).toEqual([0, 1, 0, 1]);
    expect(tags[0].contiguous).toBe(false);
    const warning = warnings.find((w) => w.includes("contiguous"));
    expect(warning).toMatch(/repeats one of its own poses/);
    expect(warning).not.toMatch(/outside the tag/);
  });

  it("keeps every tag contiguous when partitions confine merging", () => {
    // Same sheet, but partitioned by tag (CLI --respect-tags).
    const a = filledRect(4, 4, 0, 0, 2, 2);
    const frames = [a, clone(a), blank(4, 4), clone(a)];
    const tags = [
      { name: "idle", from: 0, to: 1 },
      { name: "run", from: 2, to: 3 },
    ];

    const free = remapTags(tags, findDuplicateFrames(frames));
    expect(free.tags[1].contiguous).toBe(false);

    const confined = remapTags(tags, findDuplicateFrames(frames, { partitions: [0, 0, 1, 1] }));
    expect(confined.tags.every((t) => t.contiguous)).toBe(true);
    expect(confined.tags[0]).toMatchObject({ frames: [0], from: 0, to: 0 });
    expect(confined.tags[1]).toMatchObject({ frames: [1, 2], from: 1, to: 2 });
    expect(confined.warnings.some((w) => w.includes("contiguous"))).toBe(false);
  });

  it("carries name, direction and fps through untouched", () => {
    const result = shiftedSheet();
    const { tags } = remapTags(
      [{ name: "attack", from: 2, to: 3, direction: "pingpong", fps: 24 }],
      result,
    );
    expect(tags[0].name).toBe("attack");
    expect(tags[0].direction).toBe("pingpong");
    expect(tags[0].fps).toBe(24);
  });

  it("clamps out-of-range tag indices with a warning instead of throwing", () => {
    const result = shiftedSheet(); // 4 old frames, 3 kept
    const { tags, warnings } = remapTags(
      [
        { name: "late", from: 2, to: 10 },
        { name: "early", from: -3, to: 1 },
      ],
      result,
    );

    expect(tags[0].frames).toEqual([1, 2]);
    expect(tags[1].frames).toEqual([0]);
    expect(warnings.some((w) => w.includes('"late"') && w.includes("clamped"))).toBe(true);
    expect(warnings.some((w) => w.includes('"early"') && w.includes("clamped"))).toBe(true);
  });

  it("returns no frames for a tag that lies entirely outside the sheet", () => {
    const result = shiftedSheet(); // 4 old frames
    const { tags, warnings } = remapTags(
      [
        { name: "late", from: 10, to: 20 },
        { name: "neg", from: -5, to: -1 },
      ],
      result,
    );
    for (const tag of tags) {
      expect(tag.frames).toEqual([]);
      expect(tag.contiguous).toBe(false);
    }
    expect(warnings.some((w) => w.includes('"late"') && w.includes("entirely outside"))).toBe(true);
    expect(warnings.some((w) => w.includes('"neg"') && w.includes("entirely outside"))).toBe(true);
    expect(warnings.some((w) => w.includes("clamped"))).toBe(false);
  });

  it("rejects non-integer tag bounds instead of emitting null frames", () => {
    const result = shiftedSheet();
    expect(() => remapTags([{ name: "frac", from: 0.5, to: 2 }], result)).toThrow(/integer/);
    expect(() => buildTagPartitions([{ name: "frac", from: 0.5, to: 2 }], 4)).toThrow(/integer/);
  });

  it("handles a tag pointing into an empty sheet", () => {
    const { tags, warnings } = remapTags(
      [{ name: "ghost", from: 0, to: 2 }],
      findDuplicateFrames([]),
    );
    expect(tags[0].frames).toEqual([]);
    expect(tags[0].contiguous).toBe(false);
    expect(warnings.some((w) => w.includes('"ghost"'))).toBe(true);
  });
});

describe("buildTagPartitions", () => {
  it("gives each tag its own id, untagged frames a shared one, and warns on overlap", () => {
    const { partitions, warnings } = buildTagPartitions(
      [
        { name: "idle", from: 0, to: 2 },
        { name: "walk", from: 2, to: 3 },
        { name: "late", from: 10, to: 12 },
      ],
      6,
    );
    expect(partitions).toEqual([0, 0, 0, 1, 3, 3]);
    expect(warnings).toEqual([
      'tags "idle" and "walk" overlap; the shared frames only merge within the first of them',
    ]);
  });
});

describe("parseTagsDocument", () => {
  it("accepts a tags document or a bare array and keeps only well-typed metadata", () => {
    const doc = parseTagsDocument({
      tags: [{ name: "idle", from: 0, to: 2, direction: 5, fps: "12" }],
      frameDurations: [100, null],
    });
    expect(doc.tags).toEqual([{ name: "idle", from: 0, to: 2 }]);
    expect(doc.frameDurations).toEqual([100, null]);

    const bare = parseTagsDocument([{ name: "run", from: 3, to: 1, direction: "reverse", fps: 8 }]);
    expect(bare.tags).toEqual([{ name: "run", from: 3, to: 1, direction: "reverse", fps: 8 }]);
    expect(bare.frameDurations).toBeUndefined();
  });

  it("names malformed input precisely", () => {
    expect(() => parseTagsDocument({ nope: true })).toThrow(/bare array/);
    expect(() => parseTagsDocument([42])).toThrow(/tag #0 is not an object/);
    expect(() => parseTagsDocument([{ name: "", from: 0, to: 1 }])).toThrow(/non-empty/);
    expect(() => parseTagsDocument([{ name: "frac", from: 3.5, to: 4.5 }])).toThrow(/integer/);
    expect(() => parseTagsDocument([{ name: "str", from: "0", to: 1 }])).toThrow(/integer/);
  });
});

describe("remapFrameDurations", () => {
  it("keeps authored holds on the renumbered frames through a dedupe round-trip", () => {
    // [X, X, Y, Z, Y]: 1 -> 0, 4 -> 2. Frame 0 has no hold but its duplicate does.
    const x = filledRect(4, 4, 0, 0, 2, 2);
    const y = circle(4, 4, 2, 2, 1);
    const result = findDuplicateFrames([x, clone(x), y, blank(4, 4), clone(y)]);
    expect(result.remap).toEqual([0, 0, 1, 2, 1]);

    const parsed = parseTagsDocument({
      tags: [{ name: "all", from: 0, to: 4 }],
      frameDurations: [null, 250, 120, "bad", 999],
    });
    // Frame 0 takes its duplicate's 250; frame 1 keeps Y's own 120 (not 999, not summed).
    expect(remapFrameDurations(parsed.frameDurations, result)).toEqual([250, 120, null]);
  });

  it("returns undefined when there is nothing to carry", () => {
    const result = findDuplicateFrames([BASE, clone(BASE)]);
    expect(remapFrameDurations(undefined, result)).toBeUndefined();
    expect(remapFrameDurations([null, 0, -5], result)).toBeUndefined();
  });
});
