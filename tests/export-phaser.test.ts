import { describe, expect, it } from "vitest";
import { normalizeExportInput } from "@/lib/export/types";
import { type PhaserFrameData, toPhaserAtlas } from "@/lib/export/phaser";

// Fixtures are real sprite-tools command output pushed through
// normalizeExportInput, so the tests exercise the path a user actually takes
// (`jq -s add` of meta/pivot outputs, or an `atlas --json` manifest) rather
// than hand-built internals.

/** A `meta`-shaped 4x3 sheet of 32px cells with tags and two pivots. */
function gridDoc() {
  return normalizeExportInput({
    source: "sprites/hero.png",
    frameWidth: 32,
    frameHeight: 32,
    grid: { cols: 4, rows: 3, detected: true },
    frameCount: 12,
    pivots: [
      { index: 0, cell: { row: 0, col: 0 }, pivot: { x: 16, y: 32 } },
      { index: 1, cell: { row: 0, col: 1 }, pivot: { x: 8, y: 24 } },
    ],
    tags: [
      { name: "idle", from: 0, to: 3, direction: "forward", fps: 8 },
      { name: "run", from: 4, to: 7, direction: "reverse", fps: 12 },
      { name: "hurt", from: 8, to: 10, direction: "pingpong", fps: 6 },
    ],
  });
}

/** An `atlas --json` manifest jq-merged with a pivot list. */
function atlasDoc() {
  return normalizeExportInput({
    atlas: "packed.png",
    width: 64,
    height: 32,
    frames: {
      hero_idle_0: {
        frame: { x: 0, y: 0, w: 16, h: 16 },
        trimmed: false,
        sourceSize: { w: 16, h: 16 },
        spriteSourceSize: { x: 0, y: 0, w: 16, h: 16 },
      },
      hero_idle_1: {
        frame: { x: 16, y: 0, w: 10, h: 12 },
        trimmed: true,
        sourceSize: { w: 16, h: 16 },
        spriteSourceSize: { x: 3, y: 2, w: 10, h: 12 },
      },
    },
    pivots: [{ index: 1, pivot: { x: 8, y: 16 } }],
    tags: [{ name: "idle", from: 0, to: 1, direction: "forward", fps: 10 }],
  });
}

function hashFrames(atlas: ReturnType<typeof toPhaserAtlas>): Record<string, PhaserFrameData> {
  expect(Array.isArray(atlas.frames)).toBe(false);
  return atlas.frames as Record<string, PhaserFrameData>;
}

function arrayFrames(atlas: ReturnType<typeof toPhaserAtlas>): PhaserFrameData[] {
  expect(Array.isArray(atlas.frames)).toBe(true);
  return atlas.frames as PhaserFrameData[];
}

describe("toPhaserAtlas — frames container", () => {
  it("defaults to the hash layout keyed by frame name", () => {
    const frames = hashFrames(toPhaserAtlas(gridDoc()));
    expect(Object.keys(frames)).toEqual([
      "hero_00",
      "hero_01",
      "hero_02",
      "hero_03",
      "hero_04",
      "hero_05",
      "hero_06",
      "hero_07",
      "hero_08",
      "hero_09",
      "hero_10",
      "hero_11",
    ]);
  });

  it("omits filename in the hash layout — JSONHash reads the object key", () => {
    const frames = hashFrames(toPhaserAtlas(gridDoc(), { layout: "hash" }));
    expect(frames.hero_00).not.toHaveProperty("filename");
  });

  it("writes filename first in the array layout", () => {
    // Without it Phaser registers every frame under the key `undefined` and
    // rejects all but the first as a duplicate.
    const frames = arrayFrames(toPhaserAtlas(gridDoc(), { layout: "array" }));
    expect(frames).toHaveLength(12);
    expect(Object.keys(frames[0])[0]).toBe("filename");
    expect(frames[0].filename).toBe("hero_00");
    expect(frames[11].filename).toBe("hero_11");
  });

  it("carries identical frame geometry in both layouts", () => {
    const hash = hashFrames(toPhaserAtlas(gridDoc(), { layout: "hash" }));
    const array = arrayFrames(toPhaserAtlas(gridDoc(), { layout: "array" }));
    const { filename, ...rest } = array[5];
    expect(filename).toBe("hero_05");
    expect(rest).toEqual(hash.hero_05);
  });

  it("renames frames to bare indices for frameNames: index", () => {
    // The only naming Phaser's createFromAseprite can resolve, since it looks
    // frames up as frames[i.toString()].
    const atlas = toPhaserAtlas(gridDoc(), { frameNames: "index" });
    const frames = hashFrames(atlas);
    expect(Object.keys(frames).slice(0, 3)).toEqual(["0", "1", "2"]);
    expect(atlas.animations?.idle).toEqual(["0", "1", "2", "3"]);
  });
});

describe("toPhaserAtlas — frame rects", () => {
  it("lays a grid out row-major with no Y flip", () => {
    const frames = hashFrames(toPhaserAtlas(gridDoc()));
    // index 5 -> col 1, row 1 on a 4-wide grid of 32px cells.
    expect(frames.hero_05.frame).toEqual({ x: 32, y: 32, w: 32, h: 32 });
    expect(frames.hero_00.frame).toEqual({ x: 0, y: 0, w: 32, h: 32 });
    expect(frames.hero_11.frame).toEqual({ x: 96, y: 64, w: 32, h: 32 });
  });

  it("emits rotated and trimmed explicitly on untrimmed grid frames", () => {
    // Pixi tests `data.trimmed !== false`, so an absent flag means TRIMMED and
    // shifts untrimmed sprites.
    const frames = hashFrames(toPhaserAtlas(gridDoc()));
    expect(frames.hero_00.rotated).toBe(false);
    expect(frames.hero_00.trimmed).toBe(false);
    expect(frames.hero_00.sourceSize).toEqual({ w: 32, h: 32 });
    expect(frames.hero_00.spriteSourceSize).toEqual({ x: 0, y: 0, w: 32, h: 32 });
  });

  it("passes an atlas manifest's trim rects through unchanged", () => {
    const frames = hashFrames(toPhaserAtlas(atlasDoc()));
    const trimmed = frames.hero_idle_1;
    expect(trimmed.trimmed).toBe(true);
    expect(trimmed.frame).toEqual({ x: 16, y: 0, w: 10, h: 12 });
    expect(trimmed.spriteSourceSize).toEqual({ x: 3, y: 2, w: 10, h: 12 });
    expect(trimmed.sourceSize).toEqual({ w: 16, h: 16 });
    expect(frames.hero_idle_0.trimmed).toBe(false);
  });
});

describe("toPhaserAtlas — anchors", () => {
  it("normalizes cell-relative pivot px against sourceSize", () => {
    const frames = hashFrames(toPhaserAtlas(gridDoc()));
    // (16, 32) px on a 32x32 canvas is bottom-centre.
    expect(frames.hero_00.anchor).toEqual({ x: 0.5, y: 1 });
    expect(frames.hero_01.anchor).toEqual({ x: 0.25, y: 0.75 });
  });

  it("omits anchor entirely for frames with no pivot", () => {
    const frames = hashFrames(toPhaserAtlas(gridDoc()));
    expect(frames.hero_02).not.toHaveProperty("anchor");
  });

  it("divides a trimmed frame's pivot by the untrimmed sourceSize", () => {
    // Both runtimes rebuild the untrimmed extent from sourceSize before
    // applying the anchor, so the trimmed 10x12 rect is not the divisor.
    const frames = hashFrames(toPhaserAtlas(atlasDoc()));
    expect(frames.hero_idle_1.anchor).toEqual({ x: 0.5, y: 1 });
  });

  it("never emits a pivot key alongside anchor", () => {
    // Phaser checks `anchor` first, so a second key would be dead weight.
    const frames = hashFrames(toPhaserAtlas(gridDoc()));
    expect(frames.hero_00).not.toHaveProperty("pivot");
  });

  it("suppresses anchors when anchors: false", () => {
    const frames = hashFrames(toPhaserAtlas(gridDoc(), { anchors: false }));
    expect(frames.hero_00).not.toHaveProperty("anchor");
  });
});

describe("toPhaserAtlas — durations", () => {
  it("emits integer milliseconds derived from each tag's fps", () => {
    const frames = hashFrames(toPhaserAtlas(gridDoc()));
    expect(frames.hero_00.duration).toBe(125); // idle, 8 fps
    expect(frames.hero_04.duration).toBe(83); // run, 12 fps
    expect(frames.hero_08.duration).toBe(167); // hurt, 6 fps
  });

  it("gives untagged frames the default-fps duration", () => {
    // Missing durations make createFromAseprite fall back to
    // Number.MAX_SAFE_INTEGER, freezing the animation on frame 1.
    const frames = hashFrames(toPhaserAtlas(gridDoc()));
    expect(frames.hero_11.duration).toBe(100); // 10 fps default
    for (const frame of Object.values(frames)) {
      expect(Number.isInteger(frame.duration)).toBe(true);
    }
  });
});

describe("toPhaserAtlas — meta", () => {
  it("emits the exact keys both parsers read", () => {
    const atlas = toPhaserAtlas(gridDoc());
    expect(Object.keys(atlas.meta)).toEqual([
      "app",
      "version",
      "image",
      "format",
      "size",
      "scale",
      "frameTags",
    ]);
  });

  it('emits scale as the string "1"', () => {
    // Aseprite hardcodes the string and Pixi's loader-facing type declares one.
    const atlas = toPhaserAtlas(gridDoc());
    expect(atlas.meta.scale).toBe("1");
    expect(typeof atlas.meta.scale).toBe("string");
  });

  it("defaults format to RGBA8888 and reports the texture size", () => {
    const atlas = toPhaserAtlas(gridDoc());
    expect(atlas.meta.format).toBe("RGBA8888");
    expect(atlas.meta.size).toEqual({ w: 128, h: 96 });
    expect(atlas.meta.app).toBe("https://sprites.trebeljahr.com");
    expect(atlas.meta.version).toBe("1.0");
  });

  it("reduces meta.image to a bare basename", () => {
    // Both loaders concatenate it onto the JSON's own directory.
    expect(toPhaserAtlas(gridDoc()).meta.image).toBe("hero.png");
    expect(toPhaserAtlas(atlasDoc()).meta.image).toBe("packed.png");
    expect(toPhaserAtlas(gridDoc(), { image: "art/sheets/other.png" }).meta.image).toBe(
      "other.png",
    );
  });

  it("honours app/version/format/scale overrides", () => {
    const atlas = toPhaserAtlas(gridDoc(), {
      app: "https://www.aseprite.org/",
      version: "1.3.18",
      format: "I8",
      scale: 2,
    });
    expect(atlas.meta.app).toBe("https://www.aseprite.org/");
    expect(atlas.meta.version).toBe("1.3.18");
    expect(atlas.meta.format).toBe("I8");
    expect(atlas.meta.scale).toBe(2);
  });
});

describe("toPhaserAtlas — frameTags", () => {
  it("carries inclusive ranges and directions verbatim", () => {
    const atlas = toPhaserAtlas(gridDoc());
    expect(atlas.meta.frameTags).toEqual([
      { name: "idle", from: 0, to: 3, direction: "forward" },
      { name: "run", from: 4, to: 7, direction: "reverse" },
      { name: "hurt", from: 8, to: 10, direction: "pingpong" },
    ]);
  });

  it("drops fps from the tag — it is already baked into every duration", () => {
    const atlas = toPhaserAtlas(gridDoc());
    expect(atlas.meta.frameTags?.[0]).not.toHaveProperty("fps");
  });

  it("omits frameTags when asked or when there are none", () => {
    expect(toPhaserAtlas(gridDoc(), { frameTags: false }).meta).not.toHaveProperty("frameTags");
    const untagged = normalizeExportInput({
      source: "hero.png",
      frameWidth: 16,
      frameHeight: 16,
      grid: { cols: 2, rows: 1, detected: true },
      frameCount: 2,
    });
    expect(toPhaserAtlas(untagged).meta).not.toHaveProperty("frameTags");
  });
});

describe("toPhaserAtlas — animations", () => {
  it("keeps tag names that match Object.prototype members", () => {
    const doc = normalizeExportInput({
      source: "hero.png",
      frameWidth: 16,
      frameHeight: 16,
      grid: { cols: 2, rows: 1 },
      tags: [
        { name: "constructor", from: 0, to: 1 },
        { name: "toString", from: 0, to: 0 },
        { name: "__proto__", from: 1, to: 1 },
      ],
    });
    const out = toPhaserAtlas(doc);
    const animations = out.animations as Record<string, string[]>;
    expect(Object.keys(animations)).toEqual(["constructor", "toString", "__proto__"]);
    expect(Object.hasOwn(animations, "__proto__")).toBe(true);
    expect(animations.constructor).toEqual(["hero_0", "hero_1"]);
    expect(JSON.parse(JSON.stringify(out)).animations.__proto__).toEqual(["hero_1"]);
  });

  it("bakes direction into the Pixi animations map", () => {
    const atlas = toPhaserAtlas(gridDoc());
    expect(atlas.animations).toEqual({
      idle: ["hero_00", "hero_01", "hero_02", "hero_03"],
      // reverse plays the range backwards.
      run: ["hero_07", "hero_06", "hero_05", "hero_04"],
      // pingpong appends the interior frames backwards — endpoints not
      // repeated, matching Aseprite.
      hurt: ["hero_08", "hero_09", "hero_10", "hero_09"],
    });
  });

  it("omits animations when there are no tags or when disabled", () => {
    const untagged = normalizeExportInput({
      source: "hero.png",
      frameWidth: 16,
      frameHeight: 16,
      grid: { cols: 2, rows: 1, detected: true },
      frameCount: 2,
    });
    expect(toPhaserAtlas(untagged)).not.toHaveProperty("animations");
    expect(toPhaserAtlas(gridDoc(), { animations: false })).not.toHaveProperty("animations");
  });

  it("suffixes duplicate tag names instead of letting keys collapse", () => {
    const doc = normalizeExportInput({
      source: "hero.png",
      frameWidth: 16,
      frameHeight: 16,
      grid: { cols: 4, rows: 1, detected: true },
      frameCount: 4,
      tags: [
        { name: "idle", from: 0, to: 1, direction: "forward", fps: 10 },
        { name: "idle", from: 2, to: 3, direction: "forward", fps: 10 },
      ],
    });
    const atlas = toPhaserAtlas(doc);
    expect(Object.keys(atlas.animations ?? {})).toEqual(["idle", "idle_2"]);
    // The frameTags array keeps both names verbatim — only the map dedupes.
    expect(atlas.meta.frameTags?.map((t) => t.name)).toEqual(["idle", "idle"]);
  });
});

describe("toPhaserAtlas — related_multi_packs", () => {
  it("emits bare sibling filenames under the snake_case key", () => {
    const atlas = toPhaserAtlas(gridDoc(), {
      relatedMultiPacks: ["hero-1.json", "hero-2.json"],
    });
    expect(atlas.meta.related_multi_packs).toEqual(["hero-1.json", "hero-2.json"]);
    expect(Object.keys(atlas.meta)).toEqual([
      "app",
      "version",
      "image",
      "format",
      "size",
      "scale",
      "related_multi_packs",
      "frameTags",
    ]);
  });

  it("omits the key when no packs are supplied", () => {
    expect(toPhaserAtlas(gridDoc()).meta).not.toHaveProperty("related_multi_packs");
    expect(toPhaserAtlas(gridDoc(), { relatedMultiPacks: [] }).meta).not.toHaveProperty(
      "related_multi_packs",
    );
  });

  it("rejects paths and URLs — Pixi resolves entries by string concat", () => {
    expect(() => toPhaserAtlas(gridDoc(), { relatedMultiPacks: ["./hero-1.json"] })).toThrow(
      /bare sibling filename/,
    );
    expect(() => toPhaserAtlas(gridDoc(), { relatedMultiPacks: ["packs/hero-1.json"] })).toThrow(
      /bare sibling filename/,
    );
    expect(() =>
      toPhaserAtlas(gridDoc(), { relatedMultiPacks: ["https://cdn.example/hero-1.json"] }),
    ).toThrow(/bare sibling filename/);
    expect(() => toPhaserAtlas(gridDoc(), { relatedMultiPacks: [""] })).toThrow(/non-empty/);
  });

  it("de-duplicates repeated pack names", () => {
    const atlas = toPhaserAtlas(gridDoc(), {
      relatedMultiPacks: ["hero-1.json", "hero-1.json"],
    });
    expect(atlas.meta.related_multi_packs).toEqual(["hero-1.json"]);
  });
});

describe("toPhaserAtlas — edges and determinism", () => {
  it("is deterministic across repeated calls", () => {
    const a = JSON.stringify(toPhaserAtlas(gridDoc(), { layout: "array" }));
    const b = JSON.stringify(toPhaserAtlas(gridDoc(), { layout: "array" }));
    expect(a).toBe(b);
    const h1 = JSON.stringify(toPhaserAtlas(atlasDoc()));
    const h2 = JSON.stringify(toPhaserAtlas(atlasDoc()));
    expect(h1).toBe(h2);
  });

  it("handles a single-frame sheet", () => {
    const doc = normalizeExportInput({
      source: "coin.png",
      frameWidth: 8,
      frameHeight: 8,
      grid: { cols: 1, rows: 1, detected: true },
      frameCount: 1,
      tags: [{ name: "spin", from: 0, to: 0, direction: "pingpong", fps: 4 }],
    });
    const atlas = toPhaserAtlas(doc);
    const frames = hashFrames(atlas);
    expect(Object.keys(frames)).toEqual(["coin_0"]);
    expect(frames.coin_0.frame).toEqual({ x: 0, y: 0, w: 8, h: 8 });
    expect(frames.coin_0.duration).toBe(250);
    expect(atlas.meta.size).toEqual({ w: 8, h: 8 });
    // A one-frame pingpong cannot bounce.
    expect(atlas.animations).toEqual({ spin: ["coin_0"] });
  });

  it("produces a document Pixi's testParse and Phaser's dispatch both accept", () => {
    const atlas = toPhaserAtlas(atlasDoc());
    // Pixi: frames must be an object and meta.image must exist.
    expect(Array.isArray(atlas.frames)).toBe(false);
    expect(atlas.meta.image).toBeTruthy();
    // Phaser JSONHash/JSONArray both require a frame rect on every entry.
    for (const frame of Object.values(hashFrames(atlas))) {
      expect(frame.frame.w).toBeGreaterThan(0);
      expect(frame.frame.h).toBeGreaterThan(0);
    }
    // Round-trips through JSON without losing anything.
    expect(JSON.parse(JSON.stringify(atlas))).toEqual(atlas);
  });
});
