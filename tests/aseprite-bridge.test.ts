// .aseprite -> sheet metadata -> engine export, end to end and in-process.
//
// The reader (aseprite.test.ts) and the exporters (export-*.test.ts) are each
// tested on their own. This file tests the seam between them: that the JSON
// `sprite-tools ase` and `sprite_read_aseprite` emit is a sheet metadata
// document every downstream consumer reads without silently losing timing,
// direction, texture name or size. It drives the same builder both surfaces
// call, so there is no second copy of the document shape to drift.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  type AsepriteSheetRef,
  buildAsepriteMetadata,
  resolveAsepriteLayers,
  resolveAsepriteRange,
} from "../cli/commands/aseprite";
import { stitchSheet, upscaleNearest } from "../cli/lib/image-io";
import { compositeFrames, parseAseprite } from "@/lib/aseprite";
import { inflateNode } from "@/lib/aseprite/inflate-node";
import { normalizeFrameDurations, resolveSequenceDurationsMs } from "@/lib/animation/durations";
import { type AsepriteArrayDocument, toAsepriteJson } from "@/lib/export/aseprite";
import { toGodotSpriteFrames } from "@/lib/export/godot";
import { toPhaserAtlas } from "@/lib/export/phaser";
import { normalizeExportInput } from "@/lib/export/types";

const FIXTURES = fileURLToPath(new URL("./fixtures/aseprite/", import.meta.url));

interface ReadOptions {
  tag?: string;
  cols?: number;
  scale?: number;
  layers?: string[];
  includeHidden?: boolean;
  /** Sheet filename to record; null = no sheet written (--no-sheet). */
  sheetPath?: string | null;
}

/** What the CLI action does, minus the filesystem writes. */
async function readAse(file: string, opts: ReadOptions = {}) {
  const bytes = new Uint8Array(readFileSync(`${FIXTURES}${file}`));
  const doc = await parseAseprite(bytes, { inflate: inflateNode });
  const scale = opts.scale ?? 1;
  const selection = resolveAsepriteLayers(doc, opts.layers ?? [], {
    flag: "--layer",
    includeHidden: opts.includeHidden ?? false,
    hiddenHint: "--include-hidden",
  });
  const all = compositeFrames(doc, {
    includeHiddenLayers: opts.includeHidden ?? false,
    layerIndices: selection.indices,
  });
  const range = resolveAsepriteRange(doc, opts.tag, all.length, "--tag");
  const selected = all.slice(range.from, range.to + 1);
  const cols = opts.cols ?? selected.length;

  let sheet: AsepriteSheetRef | null = null;
  const sheetPath = opts.sheetPath === undefined ? "hero.png" : opts.sheetPath;
  if (sheetPath !== null) {
    // Built exactly like the CLI builds the PNG, so the recorded size is the
    // size of real pixels, not a re-derivation of the grid maths under test.
    const images = selected.map((f) => {
      const img = new ImageData(f.width, f.height);
      img.data.set(f.pixels);
      return img;
    });
    const stitched = stitchSheet(images, cols, Math.ceil(selected.length / cols));
    const scaled = scale > 1 ? upscaleNearest(stitched, scale) : stitched;
    sheet = { path: sheetPath, width: scaled.width, height: scaled.height };
  }

  const meta = buildAsepriteMetadata({
    asepriteFile: file,
    doc,
    frames: all,
    range,
    cols,
    scale,
    tag: opts.tag ?? null,
    sheet,
    extraWarnings: selection.warnings,
  });
  // Through JSON, because that is how every consumer receives it.
  return {
    doc,
    meta: JSON.parse(JSON.stringify(meta)) as ReturnType<typeof buildAsepriteMetadata>,
  };
}

/** Per-frame `duration` of the Aseprite JSON array variant. */
function aseDurations(doc: ReturnType<typeof normalizeExportInput>): number[] {
  const out = toAsepriteJson(doc, { format: "array" }) as AsepriteArrayDocument;
  return out.frames.map((f) => f.duration);
}

/** On-screen ms per referenced frame, per animation, read back out of a .tres. */
function godotTimings(tres: string): Record<string, { frames: number; ms: number[] }> {
  const out: Record<string, { frames: number; ms: number[] }> = {};
  const re = /"frames": (\[[^\]]*\]),\n"loop": [^,]+,\n"name": &"([^"]*)",\n"speed": ([\d.]+)/g;
  for (const m of tres.matchAll(re)) {
    const speed = Number(m[3]);
    const durations = [...m[1].matchAll(/"duration": ([\d.]+)/g)].map((d) => Number(d[1]));
    // Godot: on-screen seconds = duration / speed.
    out[m[2]] = {
      frames: durations.length,
      ms: durations.map((d) => Math.round((d / speed) * 1000)),
    };
  }
  return out;
}

describe("aseprite -> export: durations", () => {
  it("emits frameDurations, one number per exported frame", async () => {
    const { meta } = await readAse("generated/rgba-durations.aseprite");
    expect(meta.frameDurations).toEqual([100, 250, 40, 33]);
    // The frames[] array is kept, and agrees.
    expect(meta.frames.map((f) => f.durationMs)).toEqual([100, 250, 40, 33]);
    // Readable by main's own durations helpers, as `gif --tags-json` reads it.
    expect(normalizeFrameDurations(meta.frameDurations, meta.frameCount)).toEqual([
      100, 250, 40, 33,
    ]);
    expect(resolveSequenceDurationsMs([0, 1, 2, 3], meta.frameDurations, 10)).toEqual([
      100, 250, 40, 33,
    ]);
  });

  it("carries no invented tag fps", async () => {
    const { meta } = await readAse("generated/tags-directions.aseprite");
    for (const tag of meta.tags) expect(tag).not.toHaveProperty("fps");
  });

  it.each([10, 12, 7])(
    "exports the file's exact durations to Aseprite JSON, Phaser and Godot (export fps %i)",
    async (defaultFps) => {
      const { meta } = await readAse("generated/rgba-durations.aseprite");
      const doc = normalizeExportInput(meta, { defaultFps });

      expect(aseDurations(doc)).toEqual([100, 250, 40, 33]);

      const phaser = toPhaserAtlas(doc, { layout: "array" });
      expect((phaser.frames as Array<{ duration: number }>).map((f) => f.duration)).toEqual([
        100, 250, 40, 33,
      ]);

      // No tags: one fallback animation over every frame.
      const godot = godotTimings(toGodotSpriteFrames(doc));
      expect(godot.default.ms).toEqual([100, 250, 40, 33]);
    },
  );

  it("indexes frameDurations by exported frame after --tag", async () => {
    const { meta } = await readAse("generated/tags-directions.aseprite", { tag: "reverse" });
    expect(meta.frameCount).toBe(4);
    expect(meta.frameDurations).toHaveLength(4);
    expect(meta.frames.map((f) => f.sourceIndex)).toEqual([4, 5, 6, 7]);
    expect(meta.tags).toEqual([
      { name: "reverse", from: 0, to: 3, direction: "reverse", repeat: 3, color: "#00ff00" },
    ]);
    const godot = godotTimings(toGodotSpriteFrames(normalizeExportInput(meta)));
    expect(godot.reverse).toEqual({ frames: 4, ms: [100, 100, 100, 100] });
  });

  it("keeps a real Aseprite file's 500ms frames through a tag export", async () => {
    const { meta } = await readAse("excalibur/beetle-rgba-multi-animation.aseprite", {
      tag: "Animation 2",
    });
    const doc = normalizeExportInput(meta);
    expect(aseDurations(doc)).toEqual([500, 500]);
    const godot = godotTimings(toGodotSpriteFrames(doc));
    expect(godot["Animation 2"].ms).toEqual([500, 500]);
  });
});

describe("aseprite -> export: sheet reference", () => {
  it("names the written PNG as the texture, at its real pixel size", async () => {
    const { meta } = await readAse("generated/tags-directions.aseprite", {
      cols: 4,
      scale: 2,
      sheetPath: "out/hero-sheet.png",
    });
    expect(meta.source).toBe("out/hero-sheet.png");
    expect(meta.asepriteFile).toBe("generated/tags-directions.aseprite");
    // 12 frames of an 8x8 canvas, 4 columns, scale 2: 4*16 x 3*16.
    expect([meta.sourceWidth, meta.sourceHeight]).toEqual([64, 48]);
    expect([meta.frameWidth, meta.frameHeight]).toEqual([16, 16]);

    const doc = normalizeExportInput(meta, {
      // What `export` passes after reading the PNG named by `source`.
      sheetSize: { width: meta.sourceWidth ?? 0, height: meta.sourceHeight ?? 0 },
    });
    expect(doc.texture).toBe("hero-sheet.png");
    expect([doc.textureWidth, doc.textureHeight]).toEqual([64, 48]);
    expect(doc.frames[5].frame).toEqual({ x: 16, y: 16, w: 16, h: 16 });
    expect(toAsepriteJson(doc).meta.image).toBe("hero-sheet.png");
    expect(toGodotSpriteFrames(doc)).toContain('path="res://hero-sheet.png"');
  });

  it("records the true size of a short last row", async () => {
    // 3 frames in 2 columns: the PNG is 2 cells wide and 2 rows tall.
    const { meta } = await readAse("excalibur/beetle-rgba-multi-animation.aseprite", { cols: 2 });
    expect(meta.grid).toEqual({ cols: 2, rows: 2, detected: false });
    expect([meta.sourceWidth, meta.sourceHeight]).toEqual([128, 128]);
    const doc = normalizeExportInput(meta);
    expect(doc.frames).toHaveLength(3);
    expect([doc.textureWidth, doc.textureHeight]).toEqual([128, 128]);
  });

  it("claims no texture without a sheet, and export fails until one is named", async () => {
    const { meta } = await readAse("generated/rgba-durations.aseprite", { sheetPath: null });
    expect(meta.source).toBeNull();
    expect(meta.sourceWidth).toBeNull();
    expect(meta.sourceHeight).toBeNull();
    expect(() => normalizeExportInput(meta)).toThrow(/source: null/);
    expect(normalizeExportInput(meta, { texture: "hero.png" }).texture).toBe("hero.png");
  });

  it("is accepted with the MCP tool's output_path next to it", async () => {
    const { meta } = await readAse("generated/rgba-durations.aseprite", { sheetPath: "a/b.png" });
    const mcpShaped = { ...meta, output_path: "a/b.png", frames_dir: null, frame_paths: [] };
    expect(normalizeExportInput(mcpShaped).texture).toBe("b.png");
  });
});

describe("aseprite -> export: tag directions", () => {
  it("keeps all four directions, pingpong-reverse included", async () => {
    const { meta } = await readAse("generated/tags-directions.aseprite");
    const doc = normalizeExportInput(meta);
    expect(doc.tags.map((t) => t.direction)).toEqual([
      "forward",
      "reverse",
      "pingpong",
      "pingpong-reverse",
    ]);
    const tags = toAsepriteJson(doc).meta.frameTags;
    expect(tags?.map((t) => t.direction)).toEqual([
      "forward",
      "reverse",
      "pingpong",
      "pingpong_reverse",
    ]);
    // The repeat count survives into Aseprite's own (string) field.
    expect(tags?.[1].repeat).toBe("3");
    expect(tags?.[0]).not.toHaveProperty("repeat");
  });

  it("bakes a pingpong-reverse tag into Godot and Pixi frame order", async () => {
    const { meta } = await readAse("generated/tags-directions.aseprite");
    // The fixture's pingpong-reverse tag is a single frame, which cannot show
    // the order. Widen it over the pingpong tag's frames, as an artist would.
    const widened = {
      ...meta,
      tags: [{ ...meta.tags[3], from: 8, to: 11 }],
    };
    const doc = normalizeExportInput(widened);
    const pixi = toPhaserAtlas(doc, { frameNames: "index" }).animations;
    expect(pixi?.pingpong_reverse).toEqual(["11", "10", "9", "8", "9", "10"]);

    const tres = toGodotSpriteFrames(doc);
    const timing = godotTimings(tres);
    expect(timing.pingpong_reverse).toEqual({ frames: 6, ms: [100, 100, 100, 100, 100, 100] });
    // First referenced region is frame 11: x = 11 * 8 in a single-row sheet.
    const firstRef = /"texture": SubResource\("([^"]+)"\)/.exec(tres)?.[1];
    const region = new RegExp(
      `id="${firstRef}"\\]\\natlas = [^\\n]+\\nregion = Rect2\\((\\d+),`,
    ).exec(tres)?.[1];
    expect(Number(region)).toBe(88);
  });
});

describe("aseprite -> JSON: layers", () => {
  it("reports reference and effectivelyVisible for every layer", async () => {
    const { meta } = await readAse("generated/rgba-reference-layer.aseprite");
    expect(meta.layers.map((l) => [l.name, l.reference, l.visible, l.effectivelyVisible])).toEqual([
      ["Art", false, true, true],
      ["Reference", true, true, true],
    ]);
  });

  it("refuses a selection of only a reference layer instead of an empty sheet", async () => {
    await expect(
      readAse("generated/rgba-reference-layer.aseprite", { layers: ["Reference"] }),
    ).rejects.toThrow(
      /--layer "Reference": this selection renders no pixels.*reference layer.*"Art"/,
    );
  });

  it("warns when a reference layer is named next to one that renders", async () => {
    const { meta } = await readAse("generated/rgba-reference-layer.aseprite", {
      layers: ["Art", "Reference"],
    });
    expect(meta.warnings).toEqual([
      '--layer "Reference" is a reference layer, which Aseprite never renders into an export; it adds nothing to the sheet',
    ]);
  });

  it("refuses a hidden-only selection unless hidden layers are included", async () => {
    await expect(
      readAse("generated/layers-blend.aseprite", { layers: ["Hidden"] }),
    ).rejects.toThrow(/renders no pixels.*"Hidden" is hidden.*--include-hidden/);
    const { meta } = await readAse("generated/layers-blend.aseprite", {
      layers: ["Hidden"],
      includeHidden: true,
    });
    expect(meta.warnings).not.toContainEqual(expect.stringContaining("Hidden"));
  });

  it("still selects a group's children by the group's name", async () => {
    const { meta } = await readAse("generated/layers-blend.aseprite", { layers: ["Group"] });
    expect(meta.warnings.filter((w) => w.startsWith("--layer"))).toEqual([]);
  });
});
