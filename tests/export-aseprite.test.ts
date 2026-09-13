import { describe, expect, it } from "vitest";
import {
  type AsepriteArrayDocument,
  type AsepriteHashDocument,
  DEFAULT_APP,
  DEFAULT_VERSION,
  toAsepriteJson,
} from "@/lib/export/aseprite";
import { normalizeExportInput } from "@/lib/export/types";

// Fixtures are the JSON a user actually pipes in — a `jq -s add` merge of
// `tags` + `pivot` + `collision` output, and an `atlas --json` manifest — run
// through the real normalizer, so these tests exercise the whole path.

function gridDoc() {
  return normalizeExportInput({
    source: "assets/hero.png",
    frameWidth: 32,
    frameHeight: 32,
    grid: { cols: 4, rows: 3, detected: true },
    frameCount: 12,
    tags: [
      { name: "idle", from: 0, to: 3, direction: "forward", fps: 10 },
      { name: "run", from: 4, to: 7, direction: "pingpong", fps: 12 },
      { name: "die", from: 8, to: 9, direction: "reverse", fps: 5 },
    ],
    pivots: [
      { index: 0, cell: { row: 0, col: 0 }, pivot: { x: 16, y: 32 } },
      { index: 1, cell: { row: 0, col: 1 }, pivot: { x: 15, y: 30 } },
    ],
    collision: [{ index: 0, cell: { row: 0, col: 0 }, polygon: [[2, 2] as [number, number]] }],
  });
}

function atlasDoc() {
  return normalizeExportInput({
    atlas: "hero.png",
    width: 64,
    height: 32,
    frames: {
      idle_0: {
        frame: { x: 0, y: 0, w: 16, h: 16 },
        trimmed: false,
        sourceSize: { w: 16, h: 16 },
        spriteSourceSize: { x: 0, y: 0, w: 16, h: 16 },
      },
      idle_1: {
        frame: { x: 16, y: 0, w: 12, h: 10 },
        trimmed: true,
        sourceSize: { w: 16, h: 16 },
        spriteSourceSize: { x: 2, y: 3, w: 12, h: 10 },
      },
    },
  });
}

describe("toAsepriteJson — hash variant", () => {
  it("keys frames by bare index so createFromAseprite can resolve them", () => {
    const out = toAsepriteJson(gridDoc()) as AsepriteHashDocument;
    expect(Array.isArray(out.frames)).toBe(false);
    expect(Object.keys(out.frames)).toEqual([
      "0",
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
      "8",
      "9",
      "10",
      "11",
    ]);
  });

  it("emits exactly Aseprite's per-frame keys, in Aseprite's order", () => {
    const out = toAsepriteJson(gridDoc()) as AsepriteHashDocument;
    expect(Object.keys(out.frames["0"])).toEqual([
      "frame",
      "rotated",
      "trimmed",
      "spriteSourceSize",
      "sourceSize",
      "duration",
    ]);
  });

  it("lays grid cells out row-major", () => {
    const out = toAsepriteJson(gridDoc()) as AsepriteHashDocument;
    expect(out.frames["0"].frame).toEqual({ x: 0, y: 0, w: 32, h: 32 });
    // index 5 -> col 1, row 1.
    expect(out.frames["5"].frame).toEqual({ x: 32, y: 32, w: 32, h: 32 });
    expect(out.frames["11"].frame).toEqual({ x: 96, y: 64, w: 32, h: 32 });
  });

  it("writes rotated as a hardcoded false on every frame", () => {
    const out = toAsepriteJson(gridDoc()) as AsepriteHashDocument;
    for (const entry of Object.values(out.frames)) {
      expect(entry.rotated).toBe(false);
    }
  });

  it("writes untrimmed grid frames with a full-canvas spriteSourceSize", () => {
    const out = toAsepriteJson(gridDoc()) as AsepriteHashDocument;
    expect(out.frames["0"].trimmed).toBe(false);
    expect(out.frames["0"].spriteSourceSize).toEqual({ x: 0, y: 0, w: 32, h: 32 });
    expect(out.frames["0"].sourceSize).toEqual({ w: 32, h: 32 });
  });

  it("derives per-frame duration in integer milliseconds from each tag's fps", () => {
    const out = toAsepriteJson(gridDoc()) as AsepriteHashDocument;
    expect(out.frames["0"].duration).toBe(100); // idle, 10 fps
    expect(out.frames["4"].duration).toBe(83); // run, 12 fps -> round(1000/12)
    expect(out.frames["8"].duration).toBe(200); // die, 5 fps
    expect(out.frames["10"].duration).toBe(100); // no tag -> default 10 fps
    for (const entry of Object.values(out.frames)) {
      expect(Number.isInteger(entry.duration)).toBe(true);
      expect(entry.duration).toBeGreaterThan(0);
    }
  });
});

describe("toAsepriteJson — array variant", () => {
  it("emits an array whose entries lead with filename", () => {
    const out = toAsepriteJson(gridDoc(), { format: "array" }) as AsepriteArrayDocument;
    expect(Array.isArray(out.frames)).toBe(true);
    expect(out.frames).toHaveLength(12);
    expect(Object.keys(out.frames[0])).toEqual([
      "filename",
      "frame",
      "rotated",
      "trimmed",
      "spriteSourceSize",
      "sourceSize",
      "duration",
    ]);
    expect(out.frames[0].filename).toBe("0");
    expect(out.frames[11].filename).toBe("11");
  });

  it("carries identical frame bodies to the hash variant", () => {
    const doc = gridDoc();
    const hash = toAsepriteJson(doc) as AsepriteHashDocument;
    const array = toAsepriteJson(doc, { format: "array" }) as AsepriteArrayDocument;
    const { filename, ...body } = array.frames[5];
    expect(filename).toBe("5");
    expect(body).toEqual(hash.frames["5"]);
    expect(array.meta).toEqual(hash.meta);
  });
});

describe("toAsepriteJson — meta", () => {
  it("emits Aseprite's meta keys in order, with scale as a string", () => {
    const out = toAsepriteJson(gridDoc());
    expect(Object.keys(out.meta)).toEqual([
      "app",
      "version",
      "image",
      "format",
      "size",
      "scale",
      "frameTags",
    ]);
    expect(out.meta.scale).toBe("1");
    expect(typeof out.meta.scale).toBe("string");
    expect(out.meta.format).toBe("RGBA8888");
  });

  it("does not claim to be Aseprite", () => {
    const out = toAsepriteJson(gridDoc());
    expect(out.meta.app).toBe(DEFAULT_APP);
    expect(out.meta.version).toBe(DEFAULT_VERSION);
    expect(out.meta.app).not.toMatch(/aseprite/i);
  });

  it("sizes meta.size to the whole sheet", () => {
    expect(toAsepriteJson(gridDoc()).meta.size).toEqual({ w: 128, h: 96 });
    expect(toAsepriteJson(atlasDoc()).meta.size).toEqual({ w: 64, h: 32 });
  });

  it("reduces meta.image to a basename, since loaders resolve it against the JSON", () => {
    expect(toAsepriteJson(gridDoc()).meta.image).toBe("hero.png");
    expect(toAsepriteJson(gridDoc(), { image: "res/sheets/other.png" }).meta.image).toBe(
      "other.png",
    );
  });

  it("keeps tag ranges inclusive and maps our three directions verbatim", () => {
    const out = toAsepriteJson(gridDoc());
    expect(out.meta.frameTags).toEqual([
      { name: "idle", from: 0, to: 3, direction: "forward" },
      { name: "run", from: 4, to: 7, direction: "pingpong" },
      { name: "die", from: 8, to: 9, direction: "reverse" },
    ]);
    // "idle" covers 4 frames: to - from + 1.
    const idle = out.meta.frameTags?.[0];
    expect((idle?.to ?? 0) - (idle?.from ?? 0) + 1).toBe(4);
  });

  it("never emits pingpong_reverse, which our Direction union cannot produce", () => {
    const serialized = JSON.stringify(toAsepriteJson(gridDoc()));
    expect(serialized).not.toContain("pingpong_reverse");
    expect(serialized).toContain('"direction":"pingpong"');
  });

  it("omits frameTags entirely when the input carries no tags", () => {
    const doc = normalizeExportInput({
      source: "hero.png",
      frameWidth: 8,
      frameHeight: 8,
      grid: { cols: 2, rows: 1, detected: true },
      frameCount: 2,
    });
    const out = toAsepriteJson(doc);
    expect(out.meta.frameTags).toBeUndefined();
    expect(Object.keys(out.meta)).not.toContain("frameTags");
  });
});

describe("toAsepriteJson — frame naming", () => {
  it("reproduces Aseprite's default item filename", () => {
    const out = toAsepriteJson(gridDoc(), { frameNames: "aseprite" }) as AsepriteHashDocument;
    expect(Object.keys(out.frames)[0]).toBe("hero 0.png");
    expect(Object.keys(out.frames)[11]).toBe("hero 11.png");
  });

  it("drops the frame counter for a single-frame sprite, like Aseprite does", () => {
    const doc = normalizeExportInput({
      source: "assets/hero.png",
      frameWidth: 16,
      frameHeight: 16,
      grid: { cols: 1, rows: 1, detected: true },
      frameCount: 1,
    });
    const out = toAsepriteJson(doc, { frameNames: "aseprite" }) as AsepriteHashDocument;
    expect(Object.keys(out.frames)).toEqual(["hero.png"]);
    // The index naming stays index naming even at one frame.
    const indexed = toAsepriteJson(doc) as AsepriteHashDocument;
    expect(Object.keys(indexed.frames)).toEqual(["0"]);
  });

  it("keeps the normalizer's names when asked", () => {
    const out = toAsepriteJson(atlasDoc(), { frameNames: "normalized" }) as AsepriteHashDocument;
    expect(Object.keys(out.frames)).toEqual(["idle_0", "idle_1"]);
  });
});

describe("toAsepriteJson — atlas manifest input", () => {
  it("passes trim geometry straight through", () => {
    const out = toAsepriteJson(atlasDoc()) as AsepriteHashDocument;
    expect(out.frames["0"].trimmed).toBe(false);
    expect(out.frames["1"]).toMatchObject({
      frame: { x: 16, y: 0, w: 12, h: 10 },
      rotated: false,
      trimmed: true,
      spriteSourceSize: { x: 2, y: 3, w: 12, h: 10 },
      sourceSize: { w: 16, h: 16 },
    });
  });
});

describe("toAsepriteJson — pivots", () => {
  it("omits pivots by default, since Aseprite has no per-frame pivot key", () => {
    const out = toAsepriteJson(gridDoc());
    expect(out.meta.slices).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain("pivot");
  });

  it("emits one slice key per pivoted frame, in sprite-canvas coordinates", () => {
    const out = toAsepriteJson(gridDoc(), { pivots: "slices" });
    expect(out.meta.slices).toEqual([
      {
        name: "pivot",
        keys: [
          { frame: 0, bounds: { x: 0, y: 0, w: 32, h: 32 }, pivot: { x: 16, y: 32 } },
          { frame: 1, bounds: { x: 0, y: 0, w: 32, h: 32 }, pivot: { x: 15, y: 30 } },
        ],
      },
    ]);
    // Frames 2..11 have no pivot and therefore no key.
    expect(out.meta.slices?.[0].keys).toHaveLength(2);
  });

  it("emits no slice at all when no frame has a pivot", () => {
    const out = toAsepriteJson(atlasDoc(), { pivots: "slices" });
    expect(out.meta.slices).toBeUndefined();
  });

  it("honours a custom slice name", () => {
    const out = toAsepriteJson(gridDoc(), { pivots: "slices", pivotSliceName: "anchor" });
    expect(out.meta.slices?.[0].name).toBe("anchor");
  });
});

describe("toAsepriteJson — determinism", () => {
  it("produces byte-identical JSON across runs and across doc instances", () => {
    const a = JSON.stringify(toAsepriteJson(gridDoc(), { pivots: "slices" }));
    const b = JSON.stringify(toAsepriteJson(gridDoc(), { pivots: "slices" }));
    expect(a).toBe(b);

    const doc = atlasDoc();
    expect(JSON.stringify(toAsepriteJson(doc, { format: "array" }))).toBe(
      JSON.stringify(toAsepriteJson(doc, { format: "array" })),
    );
  });

  it("does not mutate the document it was handed", () => {
    const doc = gridDoc();
    const before = JSON.stringify(doc);
    toAsepriteJson(doc, { format: "array", pivots: "slices", frameNames: "aseprite" });
    expect(JSON.stringify(doc)).toBe(before);
  });

  it("drops collision polygons rather than inventing a key for them", () => {
    // The grid fixture carries a collision entry on frame 0.
    expect(gridDoc().frames[0].polygon).not.toBeNull();
    expect(JSON.stringify(toAsepriteJson(gridDoc()))).not.toContain("polygon");
  });
});
