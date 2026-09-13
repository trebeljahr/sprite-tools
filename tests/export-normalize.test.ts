import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { resolveGrid, sheetHeader, sheetSizeFromSource } from "../cli/lib/common";
import { readPngSize, savePng, sliceSheet } from "../cli/lib/image-io";
import { paddedSheet } from "./helpers";
import { normalizeExportInput, sheetDocumentFromDetection } from "@/lib/export/types";
import { toGodotSpriteFrames } from "@/lib/export/godot";
import { toPhaserAtlas } from "@/lib/export/phaser";
import { toUnityMeta } from "@/lib/export/unity";

// The MCP sheet tools report the margin/spacing they sliced with inside `grid`.
// A 3x2 sheet of 16x16 cells with a 4px left/top border, a 2px right/bottom
// border, and 1px horizontal / 3px vertical gutters:
//   width  = 4 + 2 + 3*16 + 2*1 = 56
//   height = 4 + 2 + 2*16 + 1*3 = 41
function paddedDoc() {
  return {
    source: "tiles.png",
    frameWidth: 16,
    frameHeight: 16,
    grid: {
      cols: 3,
      rows: 2,
      detected: true,
      margin: { left: 4, top: 4, right: 2, bottom: 2 },
      spacing: { x: 1, y: 3 },
    },
    frameCount: 6,
  };
}

describe("normalizeExportInput — grid padding", () => {
  it("offsets cell rects by margin and spacing", () => {
    const doc = normalizeExportInput(paddedDoc());
    expect(doc.frames.map((f) => f.frame)).toEqual([
      { x: 4, y: 4, w: 16, h: 16 },
      { x: 21, y: 4, w: 16, h: 16 },
      { x: 38, y: 4, w: 16, h: 16 },
      { x: 4, y: 23, w: 16, h: 16 },
      { x: 21, y: 23, w: 16, h: 16 },
      { x: 38, y: 23, w: 16, h: 16 },
    ]);
  });

  it("derives the full texture size including borders and gutters", () => {
    const doc = normalizeExportInput(paddedDoc());
    expect(doc.textureWidth).toBe(56);
    expect(doc.textureHeight).toBe(41);
  });

  it("accepts uniform numeric margin/spacing", () => {
    const doc = normalizeExportInput({
      ...paddedDoc(),
      grid: { cols: 3, rows: 2, margin: 1, spacing: 2 },
    });
    expect(doc.frames[4].frame).toEqual({ x: 19, y: 19, w: 16, h: 16 });
    expect(doc.textureWidth).toBe(1 + 1 + 48 + 4);
    expect(doc.textureHeight).toBe(1 + 1 + 32 + 2);
  });

  it("is unchanged for a flush grid", () => {
    const doc = normalizeExportInput({ ...paddedDoc(), grid: { cols: 3, rows: 2 } });
    expect(doc.frames[4].frame).toEqual({ x: 16, y: 16, w: 16, h: 16 });
    expect(doc.textureWidth).toBe(48);
    expect(doc.textureHeight).toBe(32);
  });

  it("rejects malformed padding with an export error", () => {
    expect(() =>
      normalizeExportInput({ ...paddedDoc(), grid: { cols: 3, rows: 2, spacing: -1 } }),
    ).toThrow(/^export: invalid grid padding/);
  });

  it("flips Unity rects against the padded texture height", () => {
    const meta = toUnityMeta(normalizeExportInput(paddedDoc()));
    // Frame 0 top-left y=4, h=16 in a 41px-tall texture: 41 - 4 - 16 = 21.
    // Frame 3 top-left y=23: 41 - 23 - 16 = 2 (sits on the 2px bottom border).
    const ys = [...meta.matchAll(/^ {8}y: (\d+)$/gm)].map((m) => Number(m[1]));
    expect(ys).toEqual([21, 21, 21, 2, 2, 2]);
  });
});

describe("normalizeExportInput — real sheet size", () => {
  it("rejects a header that omits the padding its sheet was sliced with", () => {
    // 56x41 is paddedDoc's sheet; a header without grid.margin/spacing would
    // put every region in the gutter.
    const { grid, ...rest } = paddedDoc();
    const bare = { ...rest, grid: { cols: grid.cols, rows: grid.rows } };
    expect(() => normalizeExportInput({ ...bare, sourceWidth: 56, sourceHeight: 41 })).toThrow(
      /omits grid\.margin\/grid\.spacing/,
    );
    expect(() => normalizeExportInput(bare, { sheetSize: { width: 56, height: 41 } })).toThrow(
      /slices the 56×41 sheet into 18×20 cells, but the document says 16×16/,
    );
  });

  it("accepts a padded header whose recorded size matches, and uses that size", () => {
    const doc = normalizeExportInput({ ...paddedDoc(), sourceWidth: 56, sourceHeight: 41 });
    expect(doc.frames[1].frame).toEqual({ x: 21, y: 4, w: 16, h: 16 });
    expect([doc.textureWidth, doc.textureHeight]).toEqual([56, 41]);
  });

  it("prefers the size read from the image over the document's own", () => {
    const doc = normalizeExportInput(
      {
        source: "odd.png",
        frameWidth: 32,
        frameHeight: 32,
        grid: { cols: 2, rows: 2 },
        sourceWidth: 64,
        sourceHeight: 64,
      },
      { sheetSize: { width: 64, height: 65 } },
    );
    expect(doc.textureHeight).toBe(65);
  });

  it("ignores the pre-pack sheet size for an atlas hybrid", () => {
    const doc = normalizeExportInput(
      {
        ...paddedDoc(),
        sourceWidth: 999,
        sourceHeight: 999,
        atlas: "packed.png",
        width: 32,
        height: 16,
        frames: { a: { frame: { x: 0, y: 0, w: 16, h: 16 } } },
      },
      { sheetSize: { width: 999, height: 999 } },
    );
    expect([doc.textureWidth, doc.textureHeight]).toEqual([32, 16]);
    expect(doc.source).toBeNull();
    expect(doc.texture).toBe("packed.png");
  });
});

describe("normalizeExportInput — image-producing tool output", () => {
  it("refuses a document that describes a written image rather than a sheet", () => {
    // sprite_remove_background echoes the INPUT's source and padded grid, but
    // the PNG it wrote is re-stitched flush at output_path.
    expect(() =>
      normalizeExportInput({
        ...paddedDoc(),
        output_path: "keyed.png",
        sourceWidth: 56,
        sourceHeight: 41,
        width: 48,
        height: 32,
      }),
    ).toThrow(/describes an image written to "keyed\.png"/);
  });
});

describe("normalizeExportInput — pivots", () => {
  it("maps the last pixel of an axis to the canvas edge and leaves the rest alone", () => {
    const doc = normalizeExportInput({
      source: "hero.png",
      frameWidth: 48,
      frameHeight: 48,
      grid: { cols: 3, rows: 1 },
      pivots: [
        // bottom-center preset: round(0.5 * 47), 47
        { index: 0, pivot: { x: 24, y: 47 } },
        { index: 1, pivot: { x: 0, y: 0 } },
        { index: 2, pivot: { x: 47, y: 20 } },
      ],
    });
    expect(doc.frames.map((f) => f.pivot)).toEqual([
      { x: 24, y: 48 },
      { x: 0, y: 0 },
      { x: 48, y: 20 },
    ]);
    const frames = toPhaserAtlas(doc).frames as Record<string, { anchor?: unknown }>;
    expect(frames.hero_0.anchor).toEqual({ x: 0.5, y: 1 });
  });
});

describe("sheetDocumentFromDetection", () => {
  const detection = {
    cols: 4,
    rows: 3,
    confidence: 0.78,
    margin: { left: 4, top: 4, right: 4, bottom: 4 },
    spacing: { x: 2, y: 2 },
  };

  it("subtracts the detected border and gutters before sizing cells", () => {
    // 142x108: 4x3 cells of 32px, 4px margin, 2px gutters.
    const derived = sheetDocumentFromDetection("padded.png", 142, 108, detection);
    expect(derived).toMatchObject({
      frameWidth: 32,
      frameHeight: 32,
      sourceWidth: 142,
      sourceHeight: 108,
      grid: {
        cols: 4,
        rows: 3,
        detected: true,
        margin: detection.margin,
        spacing: detection.spacing,
      },
      frameCount: 12,
    });
    const doc = normalizeExportInput(derived);
    expect(doc.frames[1].frame).toEqual({ x: 38, y: 4, w: 32, h: 32 });
    expect([doc.textureWidth, doc.textureHeight]).toEqual([142, 108]);
    expect(toGodotSpriteFrames(doc)).toContain("region = Rect2(4, 4, 32, 32)");
  });

  it("drops detected padding that does not tile the sheet, like the CLI", () => {
    const derived = sheetDocumentFromDetection("flush.png", 128, 97, {
      ...detection,
      spacing: { x: 3, y: 3 },
    });
    expect(derived.frameWidth).toBe(32);
    expect(derived.frameHeight).toBe(32);
    expect(derived.grid.margin).toEqual({ left: 0, top: 0, right: 0, bottom: 0 });
    expect(() => normalizeExportInput(derived)).not.toThrow();
  });
});

describe("CLI sheet header -> export", () => {
  it("records the padding and image size the frames were cut with", () => {
    // The `meta`/`tags`/`pivot`/`collision` header used to drop margin and
    // spacing, so `meta | export` placed every region in the gutter.
    const image = paddedSheet({ cols: 4, rows: 3, cellW: 16, cellH: 16, margin: 2, spacing: 1 });
    // resolveGrid + sliceSheet is what loadSheet does; its lazy require() of
    // image-io does not resolve under vitest.
    const grid = resolveGrid(image, 4, 3, { margin: 2, spacing: 1 });
    const frames = sliceSheet(image, 4, 3, { margin: grid.margin, spacing: grid.spacing });
    const header = sheetHeader("padded.png", image, grid, frames);
    expect(header).toMatchObject({
      sourceWidth: 71,
      sourceHeight: 54,
      frameWidth: 16,
      grid: { margin: { left: 2, top: 2, right: 2, bottom: 2 }, spacing: { x: 1, y: 1 } },
    });
    const out = toGodotSpriteFrames(normalizeExportInput(JSON.parse(JSON.stringify(header))));
    expect(out).toContain("region = Rect2(2, 2, 16, 16)");
    expect(out).toContain("region = Rect2(19, 2, 16, 16)");
  });

  it("reads the sheet size from the PNG a document's source names", () => {
    const dir = mkdtempSync(join(tmpdir(), "sprite-export-"));
    try {
      const png = join(dir, "odd.png");
      savePng(new ImageData(64, 65), png);
      expect(readPngSize(png)).toEqual({ width: 64, height: 65 });
      expect(readPngSize(join(dir, "missing.png"))).toBeNull();
      // Relative sources resolve next to the JSON when the cwd does not have them.
      const size = sheetSizeFromSource({ source: "odd.png" }, join(dir, "odd.json"));
      expect(size).toEqual({ width: 64, height: 65 });
      expect(sheetSizeFromSource({ source: "-" }, null)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("frameDurations", () => {
  // `tags --duration 0=250 --duration 3=40`: frames 0 and 3 hold, the rest
  // run at their tag's fps. Frame 2 sits in both tags.
  function timedDoc(extra: Record<string, unknown> = {}) {
    return {
      source: "hero.png",
      frameWidth: 16,
      frameHeight: 16,
      grid: { cols: 4, rows: 1 },
      frameCount: 4,
      tags: [
        { name: "idle", from: 0, to: 2, direction: "forward", fps: 12 },
        { name: "run", from: 2, to: 3, direction: "forward", fps: 20 },
      ],
      frameDurations: [250, null, null, 40],
      ...extra,
    };
  }

  it("uses an explicit hold over the covering tag's fps", () => {
    const doc = normalizeExportInput(timedDoc());
    expect(doc.frames.map((f) => f.durationMs)).toEqual([250, 83, 83, 40]);
    expect(doc.frames.map((f) => f.explicitDurationMs)).toEqual([250, null, null, 40]);
  });

  it("ignores junk entries and a too-short array", () => {
    const doc = normalizeExportInput(timedDoc({ frameDurations: [0, "x", -5] }));
    expect(doc.frames.map((f) => f.explicitDurationMs)).toEqual([null, null, null, null]);
    expect(doc.frames[0].durationMs).toBe(83);
  });

  it("writes holds as Godot multipliers of each animation's own speed", () => {
    const tres = toGodotSpriteFrames(normalizeExportInput(timedDoc()));
    const anim = (name: string) => {
      const start = tres.indexOf(`"name": &"${name}"`);
      const open = tres.lastIndexOf('"frames": [', start);
      return [...tres.slice(open, start).matchAll(/"duration": ([\d.]+)/g)].map((m) => m[1]);
    };
    // idle @12fps: 250ms = 3 steps; frames 1-2 one step each.
    expect(anim("idle")).toEqual(["3.0", "1.0", "1.0"]);
    // run @20fps: frame 2 has no hold (not idle's 83ms), frame 3 40ms = 0.8 steps.
    expect(anim("run")).toEqual(["1.0", "0.8"]);
    expect(tres).toContain('"speed": 12.0');
    expect(tres).toContain('"speed": 20.0');
  });

  it("keeps the no-tag fallback speed off a held first frame", () => {
    const tres = toGodotSpriteFrames(
      normalizeExportInput(timedDoc({ tags: [] }), { defaultFps: 10 }),
    );
    expect(tres).toContain('"speed": 10.0');
    expect(tres).toMatch(/"duration": 2\.5\b/);
  });

  it("carries holds into Phaser/Pixi frame durations", () => {
    const frames = toPhaserAtlas(normalizeExportInput(timedDoc())).frames as Record<
      string,
      { duration: number }
    >;
    expect(Object.values(frames).map((f) => f.duration)).toEqual([250, 83, 83, 40]);
  });
});

describe("normalizeExportInput — pingpong-reverse and repeat", () => {
  const sheet = (tags: unknown[]) => ({
    source: "hero.png",
    frameWidth: 8,
    frameHeight: 8,
    grid: { cols: 4, rows: 1, detected: false },
    frameCount: 4,
    tags,
  });

  it("keeps pingpong-reverse instead of flattening it to forward", () => {
    const doc = normalizeExportInput(
      sheet([
        { name: "a", from: 0, to: 3, direction: "pingpong-reverse" },
        // Aseprite's own JSON spelling round-trips to the same direction.
        { name: "b", from: 0, to: 3, direction: "pingpong_reverse" },
        { name: "c", from: 0, to: 3, direction: "sideways" },
      ]),
    );
    expect(doc.tags.map((t) => t.direction)).toEqual([
      "pingpong-reverse",
      "pingpong-reverse",
      "forward",
    ]);
  });

  it("carries a positive repeat count, from a number or Aseprite's string", () => {
    const doc = normalizeExportInput(
      sheet([
        { name: "a", from: 0, to: 1, repeat: 3 },
        { name: "b", from: 0, to: 1, repeat: "2" },
        { name: "c", from: 0, to: 1, repeat: 0 },
        { name: "d", from: 0, to: 1, repeat: -1 },
        { name: "e", from: 0, to: 1 },
      ]),
    );
    expect(doc.tags.map((t) => t.repeat)).toEqual([3, 2, undefined, undefined, undefined]);
    expect(doc.tags[2]).not.toHaveProperty("repeat");
  });
});

describe("normalizeExportInput — documents with no sheet file", () => {
  const noSheet = {
    source: null,
    sourceWidth: null,
    sourceHeight: null,
    frameWidth: 8,
    frameHeight: 8,
    grid: { cols: 2, rows: 1, detected: false },
    frameCount: 2,
  };

  it("refuses to invent a texture name for `source: null`", () => {
    expect(() => normalizeExportInput(noSheet)).toThrow(/source: null.*no sheet image/);
  });

  it("exports once the caller names the texture", () => {
    const doc = normalizeExportInput(noSheet, { texture: "hero.png" });
    expect(doc.texture).toBe("hero.png");
    expect([doc.textureWidth, doc.textureHeight]).toEqual([16, 8]);
  });

  it("still defaults the texture for a document that simply omits source", () => {
    const { source: _omit, ...rest } = noSheet;
    expect(normalizeExportInput(rest).texture).toBe("spritesheet.png");
  });

  it("accepts a tool result whose output_path is the sheet it describes", () => {
    // sprite_read_aseprite writes the sheet its grid describes, so output_path
    // and source name the same file.
    const doc = normalizeExportInput({
      ...noSheet,
      source: "out/hero.png",
      output_path: "out/hero.png",
      sourceWidth: 16,
      sourceHeight: 8,
    });
    expect(doc.texture).toBe("hero.png");
  });
});
