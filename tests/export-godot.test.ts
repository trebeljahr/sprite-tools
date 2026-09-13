import { describe, expect, it } from "vitest";
import {
  type GodotExportOptions,
  toGodotAtlasTextureFiles,
  toGodotAtlasTextures,
  toGodotSpriteFrames,
} from "@/lib/export/godot";
import { normalizeExportInput } from "@/lib/export/types";

// Fixtures go through `normalizeExportInput` on purpose: these are the exact
// documents `sprite-tools meta` / `sprite-tools atlas --json` emit, so the tests
// exercise the path a real user takes rather than hand-built internals.

/** 4x3 sheet of 32x32 cells with tags, pivots and one collision polygon. */
function gridDoc(overrides: Record<string, unknown> = {}) {
  return normalizeExportInput({
    source: "art/hero.png",
    frameWidth: 32,
    frameHeight: 32,
    grid: { cols: 4, rows: 3, detected: true },
    frameCount: 12,
    tags: [
      { name: "idle", from: 0, to: 3, direction: "forward", fps: 8 },
      { name: "run", from: 4, to: 7, direction: "reverse", fps: 12 },
      { name: "attack", from: 8, to: 11, direction: "pingpong", fps: 10 },
    ],
    pivots: [
      { index: 0, cell: { row: 0, col: 0 }, pivot: { x: 16, y: 32 } },
      { index: 1, cell: { row: 0, col: 1 }, pivot: { x: 16, y: 32 } },
    ],
    collision: [{ index: 0, cell: { row: 0, col: 0 }, polygon: [[2, 2] as [number, number]] }],
    ...overrides,
  });
}

/** Packed manifest with one trimmed frame — the `margin` path. */
function atlasDoc() {
  return normalizeExportInput({
    atlas: "hero.png",
    width: 64,
    height: 32,
    frames: {
      "idle/00": {
        frame: { x: 0, y: 0, w: 32, h: 32 },
        trimmed: false,
        sourceSize: { w: 32, h: 32 },
        spriteSourceSize: { x: 0, y: 0, w: 32, h: 32 },
      },
      "idle/01": {
        frame: { x: 32, y: 1, w: 26, h: 30 },
        trimmed: true,
        sourceSize: { w: 32, h: 32 },
        spriteSourceSize: { x: 3, y: 1, w: 26, h: 30 },
      },
    },
  });
}

/** Pull the `animations` array back apart. The frames array holds only dicts,
 *  so it contains no nested `]` and can be matched non-greedily. */
function parseAnimations(out: string) {
  const ids = [...out.matchAll(/\[sub_resource type="AtlasTexture" id="([^"]+)"\]/g)].map(
    (m) => m[1],
  );
  const re =
    /"frames": (\[[^\]]*\]),\n"loop": ([^,]+),\n"name": &"((?:[^"\\]|\\.)*)",\n"speed": ([\d.]+)/g;
  return [...out.matchAll(re)].map((m) => ({
    name: m[3],
    loop: m[2],
    speed: m[4],
    frames: [...m[1].matchAll(/SubResource\("([^"]+)"\)/g)].map((f) => ids.indexOf(f[1])),
  }));
}

const RES_PATH: GodotExportOptions = { texturePath: "res://art/hero.png" };

describe("toGodotSpriteFrames — file scaffolding", () => {
  it("writes the exact Godot 4 header, with no load_steps and no uid", () => {
    const lines = toGodotSpriteFrames(gridDoc(), RES_PATH).split("\n");
    // format=3 is what every 4.x editor writes; 4.0-4.2 reject format=4 with
    // ERR_FILE_UNRECOGNIZED. A synthesized uid can silently redirect the load.
    expect(lines[0]).toBe('[gd_resource type="SpriteFrames" format=3]');
    expect(lines[1]).toBe("");
    expect(lines[0]).not.toContain("uid=");
    expect(lines[0]).not.toContain("load_steps");
  });

  it("emits load_steps = 1 main + subs + exts when asked", () => {
    const out = toGodotSpriteFrames(gridDoc(), { ...RES_PATH, loadSteps: true });
    const subs = out.match(/^\[sub_resource /gm) ?? [];
    expect(subs).toHaveLength(12);
    expect(out.split("\n")[0]).toBe('[gd_resource type="SpriteFrames" load_steps=14 format=3]');
  });

  it("emits exactly one ext_resource with type, path and id", () => {
    const out = toGodotSpriteFrames(gridDoc(), RES_PATH);
    const ext = out.match(/^\[ext_resource .*\]$/gm);
    expect(ext).toHaveLength(1);
    // type/path/id are all mandatory — omitting any is ERR_FILE_CORRUPT.
    expect(ext?.[0]).toMatch(
      /^\[ext_resource type="Texture2D" path="res:\/\/art\/hero\.png" id="1_[a-z0-9]{5}"\]$/,
    );
  });

  it("defaults the texture path to res:// + the doc's texture filename", () => {
    // `source` was "art/hero.png"; the normalizer keeps only the basename.
    expect(toGodotSpriteFrames(gridDoc())).toContain('path="res://hero.png"');
  });

  it("orders blocks ext_resource -> sub_resource -> [resource]", () => {
    const out = toGodotSpriteFrames(gridDoc(), RES_PATH);
    // A SubResource()/ExtResource() reference above its block is a hard parse
    // error, so the ordering is load-bearing, not cosmetic.
    expect(out.indexOf("[ext_resource")).toBeLessThan(out.indexOf("[sub_resource"));
    expect(out.indexOf("[sub_resource")).toBeLessThan(out.indexOf("[resource]"));
    expect(out.endsWith("\n")).toBe(true);
    expect(out).not.toContain("\r");
  });

  it("rejects texture paths Godot cannot represent or resolve", () => {
    expect(() => toGodotSpriteFrames(gridDoc(), { texturePath: 'res://a"b.png' })).toThrow(
      /quote or newline/,
    );
    expect(() => toGodotSpriteFrames(gridDoc(), { texturePath: "/Users/me/hero.png" })).toThrow(
      /res:\/\//,
    );
    expect(() => toGodotSpriteFrames(gridDoc(), { texturePath: "https://x/hero.png" })).toThrow(
      /res:\/\//,
    );
  });
});

describe("toGodotSpriteFrames — AtlasTexture sub-resources", () => {
  it("maps a grid cell to Rect2(col*w, row*h, w, h) with no Y flip", () => {
    const out = toGodotSpriteFrames(gridDoc(), RES_PATH);
    // Godot 2D is top-left origin, +Y down — the same space as our cells.
    expect(out).toContain("region = Rect2(0, 0, 32, 32)"); // index 0 -> col 0, row 0
    expect(out).toContain("region = Rect2(96, 0, 32, 32)"); // index 3 -> col 3, row 0
    expect(out).toContain("region = Rect2(0, 32, 32, 32)"); // index 4 -> col 0, row 1
    expect(out).toContain("region = Rect2(96, 64, 32, 32)"); // index 11 -> col 3, row 2
    // Rect2 prints via rtos_fix WITHOUT the float fixup: bare integers.
    expect(out).not.toMatch(/region = Rect2\(0\.0/);
  });

  it("gives every sub-resource an id of Godot's own shape and points it at the ext", () => {
    const out = toGodotSpriteFrames(gridDoc(), RES_PATH);
    const extId = out.match(/\[ext_resource .* id="([^"]+)"\]/)?.[1];
    const ids = [...out.matchAll(/\[sub_resource type="AtlasTexture" id="([^"]+)"\]/g)].map(
      (m) => m[1],
    );
    expect(ids).toHaveLength(12);
    for (const id of ids) expect(id).toMatch(/^AtlasTexture_[a-z0-9]{5}$/);
    expect(new Set(ids).size).toBe(12);
    expect(out.match(/atlas = ExtResource\("([^"]+)"\)/g)).toHaveLength(12);
    expect(out).toContain(`atlas = ExtResource("${extId}")`);
  });

  it("omits margin on untrimmed frames and writes it for trimmed ones", () => {
    expect(toGodotSpriteFrames(gridDoc(), RES_PATH)).not.toContain("margin =");

    const out = toGodotSpriteFrames(atlasDoc(), RES_PATH);
    expect(out).toContain("region = Rect2(0, 0, 32, 32)");
    expect(out).toContain("region = Rect2(32, 1, 26, 30)");
    // margin.position = where the trimmed content sits in the original canvas;
    // margin.size = how much was trimmed away in total (32-26, 32-30).
    expect(out).toContain("margin = Rect2(3, 1, 6, 2)");
    expect(out.match(/^margin = /gm)).toHaveLength(1);
  });

  it("reuses one sub-resource for repeated geometry", () => {
    const doc = normalizeExportInput({
      atlas: "hero.png",
      width: 32,
      height: 32,
      frames: {
        a: { frame: { x: 0, y: 0, w: 32, h: 32 } },
        b: { frame: { x: 0, y: 0, w: 32, h: 32 } },
      },
    });
    const out = toGodotSpriteFrames(doc, RES_PATH);
    expect(out.match(/^\[sub_resource /gm)).toHaveLength(1);
    // ...and the animation still references it twice.
    const id = out.match(/id="(AtlasTexture_[a-z0-9]{5})"/)?.[1];
    expect(out.match(new RegExp(`SubResource\\("${id}"\\)`, "g"))).toHaveLength(2);
  });
});

describe("toGodotSpriteFrames — animations", () => {
  it("writes the animations array in the exact shape Godot serializes", () => {
    const doc = normalizeExportInput({
      source: "hero.png",
      frameWidth: 16,
      frameHeight: 16,
      grid: { cols: 2, rows: 1, detected: true },
      frameCount: 2,
      tags: [{ name: "idle", from: 0, to: 1, direction: "forward", fps: 8 }],
    });
    const out = toGodotSpriteFrames(doc, RES_PATH);
    const ids = [...out.matchAll(/\[sub_resource type="AtlasTexture" id="([^"]+)"\]/g)].map(
      (m) => m[1],
    );
    // Dictionary keys sorted, zero indentation, arrays joined with ", ".
    expect(out).toContain(
      [
        "animations = [{",
        '"frames": [{',
        '"duration": 1.0,',
        `"texture": SubResource("${ids[0]}")`,
        "}, {",
        '"duration": 1.0,',
        `"texture": SubResource("${ids[1]}")`,
        "}],",
        '"loop": true,',
        '"name": &"idle",',
        '"speed": 8.0',
        "}]",
      ].join("\n"),
    );
  });

  it("emits all four mandatory animation keys and both frame keys", () => {
    const out = toGodotSpriteFrames(gridDoc(), RES_PATH);
    // _set_animations ERR_CONTINUEs past an entry missing any of these, which
    // drops the animation silently rather than failing the load.
    for (const key of ["frames", "loop", "name", "speed"]) {
      expect(out.match(new RegExp(`"${key}":`, "g"))).toHaveLength(3);
    }
    const frameRefs = out.match(/"texture": SubResource/g) ?? [];
    expect(out.match(/"duration":/g)).toHaveLength(frameRefs.length);
  });

  it("sorts animations alphabetically, as _get_animations does", () => {
    const out = toGodotSpriteFrames(gridDoc(), RES_PATH);
    const names = [...out.matchAll(/"name": &"([^"]+)"/g)].map((m) => m[1]);
    expect(names).toEqual(["attack", "idle", "run"]);
  });

  it("uses tag fps as speed and a relative duration of 1.0, not seconds", () => {
    const out = toGodotSpriteFrames(gridDoc(), RES_PATH);
    // `duration` is a multiplier of 1/speed. 12 fps quantizes to 83 ms in our
    // metadata; the exporter must undo that rather than emit 0.996.
    expect(out).toContain('"speed": 8.0');
    expect(out).toContain('"speed": 12.0');
    expect(out).toContain('"speed": 10.0');
    expect(out).not.toMatch(/"duration": (?!1\.0)/);
  });

  it("plays an overlapping tag at its own fps, not the first covering tag's", () => {
    // A whole-sheet tag listed before a clip: per-frame durations come from the
    // first covering tag (10 fps), but the `run` animation has its own speed.
    const doc = gridDoc({
      tags: [
        { name: "all", from: 0, to: 11, fps: 10 },
        { name: "run", from: 4, to: 7, fps: 20 },
      ],
    });
    const anims = parseAnimations(toGodotSpriteFrames(doc, RES_PATH));
    expect(anims.find((a) => a.name === "run")?.speed).toBe("20.0");
    const out = toGodotSpriteFrames(doc, RES_PATH);
    expect(out).not.toMatch(/"duration": (?!1\.0)/);
  });

  it("bakes reverse and pingpong into the frame order (Godot has no direction)", () => {
    const out = toGodotSpriteFrames(gridDoc(), RES_PATH);
    const anims = parseAnimations(out);
    const refs = (name: string) => anims.find((a) => a.name === name)?.frames;
    expect(refs("idle")).toEqual([0, 1, 2, 3]);
    expect(refs("run")).toEqual([7, 6, 5, 4]);
    // Aseprite-style ping-pong: endpoints are NOT repeated (2n-2 frames).
    expect(refs("attack")).toEqual([8, 9, 10, 11, 10, 9]);
  });

  it("emits a single 'default' animation over all frames when the doc has no tags", () => {
    const doc = gridDoc({ tags: [] });
    const out = toGodotSpriteFrames(doc, RES_PATH);
    expect(out.match(/"name": &"/g)).toHaveLength(1);
    // AnimatedSprite2D.animation defaults to &"default"; without it the node
    // shows nothing, and _set_animations keeps no implicit animation.
    expect(out).toContain('"name": &"default"');
    expect(out.match(/"texture": SubResource/g)).toHaveLength(12);
    // 10 fps default => 100 ms per frame => speed 10.
    expect(out).toContain('"speed": 10.0');
    expect(out).not.toMatch(/"duration": (?!1\.0)/);
  });

  it("recovers an integer fallback speed from a quantized default fps", () => {
    // 12 fps quantizes to 83 ms; 1000 / 83 would print 12.048192771084338.
    const doc = normalizeExportInput(
      {
        source: "hero.png",
        frameWidth: 32,
        frameHeight: 32,
        grid: { cols: 2, rows: 1, detected: true },
      },
      { defaultFps: 12 },
    );
    const out = toGodotSpriteFrames(doc);
    expect(out).toContain('"speed": 12.0');
    expect(out).not.toMatch(/"duration": (?!1\.0)/);
  });

  it("honours defaultAnimationName and defaultAlias", () => {
    expect(toGodotSpriteFrames(gridDoc({ tags: [] }), { defaultAnimationName: "loop" })).toContain(
      '"name": &"loop"',
    );
    const aliased = toGodotSpriteFrames(gridDoc(), { ...RES_PATH, defaultAlias: true });
    const names = [...aliased.matchAll(/"name": &"([^"]+)"/g)].map((m) => m[1]);
    expect(names).toEqual(["attack", "default", "idle", "run"]);
  });

  it("de-duplicates animation names, which Godot would collapse into one", () => {
    const doc = gridDoc({
      tags: [
        { name: "idle", from: 0, to: 1, direction: "forward", fps: 8 },
        { name: "idle", from: 2, to: 3, direction: "forward", fps: 8 },
      ],
    });
    const names = [...toGodotSpriteFrames(doc, RES_PATH).matchAll(/"name": &"([^"]+)"/g)].map(
      (m) => m[1],
    );
    expect(names).toEqual(["idle", "idle_2"]);
  });

  it("writes names as StringNames and escapes them for the .tres text format", () => {
    const doc = gridDoc({
      tags: [{ name: 'we"ird\\name\n', from: 0, to: 1, direction: "forward", fps: 8 }],
    });
    const out = toGodotSpriteFrames(doc, RES_PATH);
    expect(out).toContain('"name": &"we\\"ird\\\\name\\n"');
  });
});

describe("toGodotSpriteFrames — loop and pingpong modes", () => {
  it("defaults loop to the bool true, which every Godot 4.x reads correctly", () => {
    expect(toGodotSpriteFrames(gridDoc(), RES_PATH)).toContain('"loop": true');
  });

  it("closes a baked ping-pong on its first frame when it does not loop", () => {
    // A looping animation wraps back to `from` by itself; a one-shot must not
    // come to rest on from+1.
    const oneShot = parseAnimations(toGodotSpriteFrames(gridDoc(), { ...RES_PATH, loop: false }));
    expect(oneShot.find((a) => a.name === "attack")?.frames).toEqual([8, 9, 10, 11, 10, 9, 8]);
    const looping = parseAnimations(toGodotSpriteFrames(gridDoc(), RES_PATH));
    expect(looping.find((a) => a.name === "attack")?.frames).toEqual([8, 9, 10, 11, 10, 9]);
  });

  it("writes loop: false when looping is off", () => {
    const out = toGodotSpriteFrames(gridDoc(), { ...RES_PATH, loop: false });
    expect(out).toContain('"loop": false');
    expect(out).not.toContain('"loop": true');
  });

  it("writes the 4.7 LoopMode integers in int mode", () => {
    const linear = toGodotSpriteFrames(gridDoc(), { ...RES_PATH, loopMode: "int" });
    expect(linear).toContain('"loop": 1'); // LOOP_LINEAR
    expect(linear).not.toContain('"loop": 2');

    const none = toGodotSpriteFrames(gridDoc(), { ...RES_PATH, loopMode: "int", loop: false });
    expect(none).toContain('"loop": 0'); // LOOP_NONE
  });

  it("uses LOOP_PINGPONG only with pingpong:native AND loopMode:int", () => {
    const native = toGodotSpriteFrames(gridDoc(), {
      ...RES_PATH,
      loopMode: "int",
      pingpong: "native",
    });
    const attack = parseAnimations(native).find((a) => a.name === "attack");
    expect(attack?.loop).toBe("2"); // LOOP_PINGPONG
    // Native mode is NOT frame-equivalent to baking: the engine replays the
    // endpoints, so the frame list stays a plain forward run.
    expect(attack?.frames).toEqual([8, 9, 10, 11]);

    // Without int mode, pingpong:native has nowhere to go and must bake.
    const bool = toGodotSpriteFrames(gridDoc(), { ...RES_PATH, pingpong: "native" });
    expect(bool).not.toContain('"loop": 2');
    expect(bool.match(/"texture": SubResource/g)).toHaveLength(4 + 4 + 6);
  });
});

describe("toGodotSpriteFrames — determinism and edges", () => {
  it("is byte-identical across runs and across separately-normalized inputs", () => {
    expect(toGodotSpriteFrames(gridDoc(), RES_PATH)).toBe(toGodotSpriteFrames(gridDoc(), RES_PATH));
    expect(toGodotSpriteFrames(atlasDoc(), RES_PATH)).toBe(
      toGodotSpriteFrames(atlasDoc(), RES_PATH),
    );
  });

  it("re-seeds ids from the texture path, so a different sheet gets different ids", () => {
    const a = toGodotSpriteFrames(gridDoc(), { texturePath: "res://a.png" });
    const b = toGodotSpriteFrames(gridDoc(), { texturePath: "res://b.png" });
    expect(a).not.toBe(b);
  });

  it("handles a single-frame sheet", () => {
    const doc = normalizeExportInput({
      source: "hero.png",
      frameWidth: 16,
      frameHeight: 16,
      grid: { cols: 1, rows: 1, detected: true },
      frameCount: 1,
    });
    const out = toGodotSpriteFrames(doc, RES_PATH);
    expect(out.match(/^\[sub_resource /gm)).toHaveLength(1);
    expect(out).toContain("region = Rect2(0, 0, 16, 16)");
    expect(out).toContain('"name": &"default"');
  });

  it("ignores pivots and collision, which SpriteFrames cannot represent", () => {
    // Pivot is a node property (AnimatedSprite2D.centered/offset) and collision
    // is a separate CollisionPolygon2D — neither has a field here.
    const out = toGodotSpriteFrames(gridDoc(), RES_PATH);
    expect(out).not.toMatch(/pivot|offset|polygon|centered/i);
  });

  it("keeps working when a frame has no pivot at all", () => {
    expect(() => toGodotSpriteFrames(gridDoc({ pivots: [] }), RES_PATH)).not.toThrow();
  });
});

describe("toGodotAtlasTextureFiles", () => {
  it("writes one importable standalone AtlasTexture per frame", () => {
    const files = toGodotAtlasTextureFiles(atlasDoc(), RES_PATH);
    expect(files.map((f) => f.filename)).toEqual(["00.tres", "01.tres"]);
    expect(files[0].content).toBe(
      [
        '[gd_resource type="AtlasTexture" format=3]',
        "",
        `[ext_resource type="Texture2D" path="res://art/hero.png" id="${
          files[0].content.match(/id="([^"]+)"/)?.[1]
        }"]`,
        "",
        "[resource]",
        `atlas = ExtResource("${files[0].content.match(/id="([^"]+)"/)?.[1]}")`,
        "region = Rect2(0, 0, 32, 32)",
        "",
      ].join("\n"),
    );
    // The trimmed frame carries a margin; the untrimmed one must not.
    expect(files[0].content).not.toContain("margin");
    expect(files[1].content).toContain("margin = Rect2(3, 1, 6, 2)");
  });

  it("derives safe, unique filenames from frame names", () => {
    const doc = normalizeExportInput({
      atlas: "hero.png",
      width: 32,
      height: 32,
      frames: {
        "run/00.png": { frame: { x: 0, y: 0, w: 16, h: 16 } },
        "walk/00.png": { frame: { x: 16, y: 0, w: 16, h: 16 } },
      },
    });
    expect(toGodotAtlasTextureFiles(doc, RES_PATH).map((f) => f.filename)).toEqual([
      "00.tres",
      "00_2.tres",
    ]);
  });

  it("uses the same ext_resource id in every file, deterministically", () => {
    const first = toGodotAtlasTextureFiles(gridDoc(), RES_PATH);
    const second = toGodotAtlasTextureFiles(gridDoc(), RES_PATH);
    expect(first).toEqual(second);
    const ids = new Set(first.map((f) => f.content.match(/id="([^"]+)"/)?.[1]));
    expect(ids.size).toBe(1);
    expect(first).toHaveLength(12);
  });
});

describe("toGodotAtlasTextures", () => {
  it("concatenates the per-frame files with ; comment separators", () => {
    const bundle = toGodotAtlasTextures(atlasDoc(), RES_PATH);
    const files = toGodotAtlasTextureFiles(atlasDoc(), RES_PATH);
    expect(bundle).toBe(files.map((f) => `; ${f.filename}\n${f.content}`).join("\n"));
    expect(bundle.match(/^\[gd_resource /gm)).toHaveLength(2);
    expect(bundle).toBe(toGodotAtlasTextures(atlasDoc(), RES_PATH));
  });
});
