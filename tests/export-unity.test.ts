import { describe, it, expect } from "vitest";
import { normalizeExportInput } from "@/lib/export/types";
import { toUnityMeta, unityMetaFilename } from "@/lib/export/unity";

// A realistic `sprite-tools meta` output: 4x3 sheet of 32x32 cells (128x96 px),
// two tags, pivots on a few frames, one collision polygon.
function gridDoc() {
  return {
    source: "assets/hero.png",
    frameWidth: 32,
    frameHeight: 32,
    grid: { cols: 4, rows: 3, detected: true },
    frameCount: 12,
    tags: [
      { name: "idle", from: 0, to: 3, direction: "forward", fps: 8 },
      { name: "run", from: 4, to: 7, direction: "pingpong", fps: 12 },
    ],
    pivots: [
      { index: 0, cell: { row: 0, col: 0 }, pivot: { x: 16, y: 32 } },
      { index: 1, cell: { row: 0, col: 1 }, pivot: { x: 16, y: 0 } },
      { index: 8, cell: { row: 2, col: 0 }, pivot: { x: 8, y: 16 } },
    ],
    collision: [
      {
        index: 0,
        cell: { row: 0, col: 0 },
        pointCount: 4,
        bounds: { x: 8, y: 10, width: 16, height: 20 },
        polygon: [
          [8, 10],
          [24, 10],
          [24, 30],
          [8, 30],
        ] as Array<[number, number]>,
      },
    ],
  };
}

// A `sprite-tools atlas --json` manifest, one frame trimmed.
function atlasDoc() {
  return {
    atlas: "packed.png",
    width: 64,
    height: 64,
    frames: {
      idle_0: {
        frame: { x: 0, y: 0, w: 32, h: 32 },
        trimmed: false,
        sourceSize: { w: 32, h: 32 },
        spriteSourceSize: { x: 0, y: 0, w: 32, h: 32 },
      },
      idle_1: {
        frame: { x: 32, y: 0, w: 26, h: 30 },
        trimmed: true,
        sourceSize: { w: 32, h: 32 },
        spriteSourceSize: { x: 3, y: 1, w: 26, h: 30 },
      },
    },
  };
}

function lines(meta: string): string[] {
  return meta.split("\n");
}

/** The sprite block for `name`, from `- serializedVersion: 2` up to `weights`. */
function spriteBlock(meta: string, name: string): string[] {
  const all = lines(meta);
  const start = all.indexOf(`      name: ${name}`);
  expect(start).toBeGreaterThan(-1);
  const end = all.indexOf("      weights: []", start);
  return all.slice(start - 1, end + 1);
}

function fieldIn(block: string[], key: string): string {
  const line = block.find((l) => l.trim().startsWith(`${key}:`));
  expect(line, `missing ${key}`).toBeDefined();
  return (line as string)
    .trim()
    .slice(key.length + 1)
    .trim();
}

describe("toUnityMeta — file shape", () => {
  it("emits the exact Unity header lines", () => {
    const meta = toUnityMeta(normalizeExportInput(gridDoc()));
    const l = lines(meta);
    expect(l[0]).toBe("fileFormatVersion: 2");
    expect(l[1]).toMatch(/^guid: [0-9a-f]{32}$/);
    expect(l[2]).toBe("TextureImporter:");
  });

  it("uses LF endings and a single trailing newline", () => {
    const meta = toUnityMeta(normalizeExportInput(gridDoc()));
    expect(meta).not.toContain("\r");
    expect(meta.endsWith("\n")).toBe(true);
    expect(meta.endsWith("\n\n")).toBe(false);
  });

  it("sets the sprite-sheet importer literals", () => {
    const l = lines(toUnityMeta(normalizeExportInput(gridDoc())));
    // spriteMode 2 = Multiple, textureType 8 = Sprite, textureShape 1 = Texture2D.
    expect(l).toContain("  spriteMode: 2");
    expect(l).toContain("  textureType: 8");
    expect(l).toContain("  textureShape: 1");
    expect(l).toContain("  serializedVersion: 13");
    // nPOTScale 0 (None) — anything else rescales the sheet and breaks rects.
    expect(l).toContain("  nPOTScale: 0");
    expect(l).toContain("  alphaUsage: 1");
    expect(l).toContain("  alphaIsTransparency: 1");
    expect(l).toContain("  swizzle: 50462976");
    expect(l).toContain("  spriteMeshType: 0");
  });

  it("nests filterMode under textureSettings, not at the root", () => {
    const l = lines(toUnityMeta(normalizeExportInput(gridDoc())));
    const settings = l.indexOf("  textureSettings:");
    expect(settings).toBeGreaterThan(-1);
    expect(l[settings + 1]).toBe("    serializedVersion: 2");
    expect(l[settings + 2]).toBe("    filterMode: 0");
    expect(l).toContain("    wrapU: 1");
    expect(l).toContain("    wrapV: 1");
    // A root-level filterMode would be silently ignored by Unity.
    expect(l).not.toContain("  filterMode: 0");
  });

  it("puts textureCompression only inside platformSettings", () => {
    const l = lines(toUnityMeta(normalizeExportInput(gridDoc())));
    expect(l).toContain("    textureCompression: 0");
    expect(l).not.toContain("  textureCompression: 0");
    expect(l).toContain("  - serializedVersion: 4");
    expect(l).toContain("    buildTarget: DefaultTexturePlatform");
  });

  it("writes the spriteSheet tail with its sentinel empty ids", () => {
    const l = lines(toUnityMeta(normalizeExportInput(gridDoc())));
    expect(l).toContain("    spriteID: ");
    expect(l).toContain("    internalID: 0");
    expect(l).toContain("    secondaryTextures: []");
    expect(l).toContain("    spriteCustomMetadata:");
    expect(l).toContain("      entries: []");
    expect(l).toContain("  userData: ");
    expect(l[l.length - 2]).toBe("  assetBundleVariant: ");
  });

  it("emits `indices` as an empty scalar, never []", () => {
    const meta = toUnityMeta(normalizeExportInput(gridDoc()));
    expect(meta).toContain("      indices: \n");
    expect(meta).not.toContain("indices: []");
  });

  it("names the sidecar after the texture", () => {
    expect(unityMetaFilename(normalizeExportInput(gridDoc()))).toBe("hero.png.meta");
    expect(unityMetaFilename(normalizeExportInput(atlasDoc()))).toBe("packed.png.meta");
  });
});

describe("toUnityMeta — rect Y flip", () => {
  it("flips rects against the real sheet height when the slicer floored", () => {
    // 64x65 in 2 rows slices 32px cells with a stray bottom row. Unity measures
    // from the bottom of the real 65px texture.
    const doc = {
      source: "odd.png",
      frameWidth: 32,
      frameHeight: 32,
      grid: { cols: 2, rows: 2 },
    };
    for (const input of [
      normalizeExportInput({ ...doc, sourceWidth: 64, sourceHeight: 65 }),
      normalizeExportInput(doc, { sheetSize: { width: 64, height: 65 } }),
    ]) {
      const meta = toUnityMeta(input);
      expect(spriteBlock(meta, "odd_0")).toContain("        y: 33");
      expect(spriteBlock(meta, "odd_2")).toContain("        y: 1");
    }
  });

  it("converts top-left rows to Unity's bottom-left origin", () => {
    const doc = normalizeExportInput(gridDoc());
    expect(doc.textureWidth).toBe(128);
    expect(doc.textureHeight).toBe(96);
    const meta = toUnityMeta(doc);

    // Frame 0 is the top-left cell: yTopLeft 0 -> 96 - 0 - 32 = 64.
    const first = spriteBlock(meta, "hero_00");
    expect(fieldIn(first, "x")).toBe("0");
    expect(fieldIn(first, "y")).toBe("64");
    expect(fieldIn(first, "width")).toBe("32");
    expect(fieldIn(first, "height")).toBe("32");

    // Frame 6 is row 1, col 2: x = 64, yTopLeft = 32 -> 96 - 32 - 32 = 32.
    const middle = spriteBlock(meta, "hero_06");
    expect(fieldIn(middle, "x")).toBe("64");
    expect(fieldIn(middle, "y")).toBe("32");

    // Frame 11 is the bottom-right cell: yTopLeft = 64 -> 96 - 64 - 32 = 0.
    const last = spriteBlock(meta, "hero_11");
    expect(fieldIn(last, "x")).toBe("96");
    expect(fieldIn(last, "y")).toBe("0");
  });

  it("flips atlas frames against the manifest height", () => {
    const meta = toUnityMeta(normalizeExportInput(atlasDoc()));
    // 64-tall texture, 32-tall frame at yTopLeft 0 -> 64 - 0 - 32 = 32.
    expect(fieldIn(spriteBlock(meta, "idle_0"), "y")).toBe("32");
    // 30-tall trimmed frame at yTopLeft 0 -> 64 - 0 - 30 = 34.
    const trimmed = spriteBlock(meta, "idle_1");
    expect(fieldIn(trimmed, "x")).toBe("32");
    expect(fieldIn(trimmed, "y")).toBe("34");
    expect(fieldIn(trimmed, "width")).toBe("26");
    expect(fieldIn(trimmed, "height")).toBe("30");
  });

  it("refuses rects that fall outside the declared texture", () => {
    const doc = normalizeExportInput({
      atlas: "small.png",
      width: 32,
      height: 32,
      frames: { big: { frame: { x: 0, y: 0, w: 64, h: 64 } } },
    });
    expect(() => toUnityMeta(doc)).toThrow(/outside the 32×32 texture/);
  });
});

describe("toUnityMeta — pivot", () => {
  it("normalizes into the rect with alignment 9 (Custom)", () => {
    const meta = toUnityMeta(normalizeExportInput(gridDoc()));

    // (16, 32) top-left px on a 32x32 cell = bottom-centre -> (0.5, 0).
    const bottomCentre = spriteBlock(meta, "hero_00");
    expect(fieldIn(bottomCentre, "alignment")).toBe("9");
    expect(fieldIn(bottomCentre, "pivot")).toBe("{x: 0.5, y: 0}");

    // (16, 0) = top-centre -> (0.5, 1).
    expect(fieldIn(spriteBlock(meta, "hero_01"), "pivot")).toBe("{x: 0.5, y: 1}");

    // (8, 16) -> (0.25, 0.5).
    expect(fieldIn(spriteBlock(meta, "hero_08"), "pivot")).toBe("{x: 0.25, y: 0.5}");
  });

  it("falls back to alignment 0 (Center) with a zeroed pivot when none is supplied", () => {
    const meta = toUnityMeta(normalizeExportInput(gridDoc()));
    const noPivot = spriteBlock(meta, "hero_05");
    expect(fieldIn(noPivot, "alignment")).toBe("0");
    // Unity zeroes the pivot field whenever alignment != 9, since it is unread.
    expect(fieldIn(noPivot, "pivot")).toBe("{x: 0, y: 0}");
  });

  it("rebases a trimmed frame's pivot through spriteSourceSize", () => {
    const doc = atlasDoc();
    const meta = toUnityMeta(
      normalizeExportInput({
        ...doc,
        // Pivots attach by index against the manifest's key order.
        pivots: [{ index: 1, pivot: { x: 16, y: 16 } }],
      }),
    );
    // (16, 16) on the untrimmed 32x32 canvas, trimmed rect at (3, 1) sized
    // 26x30: x = (16-3)/26 = 0.5, y = 1 - (16-1)/30 = 0.5.
    expect(fieldIn(spriteBlock(meta, "idle_1"), "pivot")).toBe("{x: 0.5, y: 0.5}");
    expect(fieldIn(spriteBlock(meta, "idle_1"), "alignment")).toBe("9");
  });

  it("anchors a trimmed frame with no pivot at its untrimmed canvas centre", () => {
    // Alignment 0 would centre on the trimmed pixels, so each trimmed frame of
    // an animation would anchor somewhere else. Canvas centre (16, 16), trimmed
    // rect at (3, 1) sized 26x30: x = 13/26 = 0.5, y = 1 - 15/30 = 0.5.
    const meta = toUnityMeta(normalizeExportInput(atlasDoc()));
    expect(fieldIn(spriteBlock(meta, "idle_1"), "alignment")).toBe("9");
    expect(fieldIn(spriteBlock(meta, "idle_1"), "pivot")).toBe("{x: 0.5, y: 0.5}");
    // Untrimmed frames keep Unity's own default.
    expect(fieldIn(spriteBlock(meta, "idle_0"), "alignment")).toBe("0");

    // Off-centre trim: 16x22 at (0, 10) inside a 32x32 canvas.
    const offCentre = toUnityMeta(
      normalizeExportInput({
        atlas: "packed.png",
        width: 64,
        height: 64,
        frames: {
          b: {
            frame: { x: 32, y: 0, w: 16, h: 22 },
            trimmed: true,
            sourceSize: { w: 32, h: 32 },
            spriteSourceSize: { x: 0, y: 10, w: 16, h: 22 },
          },
        },
      }),
    );
    expect(fieldIn(spriteBlock(offCentre, "b"), "pivot")).toBe("{x: 1, y: 0.727273}");
  });

  it("puts a last-pixel pivot on the canvas edge", () => {
    // `--pivot bottom-center` picks pixel (24, 47) on a 48px frame; the feet
    // belong on the bottom edge, not one pixel above it.
    const meta = toUnityMeta(
      normalizeExportInput({
        source: "hero.png",
        frameWidth: 48,
        frameHeight: 48,
        grid: { cols: 1, rows: 1 },
        pivots: [{ index: 0, pivot: { x: 24, y: 47 } }],
      }),
    );
    expect(fieldIn(spriteBlock(meta, "hero_0"), "pivot")).toBe("{x: 0.5, y: 0}");
  });
});

describe("toUnityMeta — physicsShape", () => {
  it("converts collision polygons to rect-centre pixels with +Y up", () => {
    const meta = toUnityMeta(normalizeExportInput(gridDoc()));
    const block = spriteBlock(meta, "hero_00");
    const start = block.indexOf("      physicsShape:");
    expect(start).toBeGreaterThan(-1);
    // 32x32 rect: (8,10) -> (8-16, 16-10) = (-8, 6); (24,30) -> (8, -14).
    expect(block.slice(start + 1, start + 5)).toEqual([
      "      - - {x: -8, y: 6}",
      "        - {x: 8, y: 6}",
      "        - {x: 8, y: -14}",
      "        - {x: -8, y: -14}",
    ]);
  });

  it("emits an empty physicsShape for frames without collision", () => {
    const meta = toUnityMeta(normalizeExportInput(gridDoc()));
    expect(spriteBlock(meta, "hero_03")).toContain("      physicsShape: []");
  });

  it("suppresses shapes entirely when asked", () => {
    const meta = toUnityMeta(normalizeExportInput(gridDoc()), { physicsShape: false });
    expect(spriteBlock(meta, "hero_00")).toContain("      physicsShape: []");
    expect(meta).not.toContain("{x: -8, y: 6}");
  });

  it("keeps Unity's fallback generation configurable", () => {
    expect(lines(toUnityMeta(normalizeExportInput(gridDoc())))).toContain(
      "  spriteGenerateFallbackPhysicsShape: 1",
    );
    expect(
      lines(toUnityMeta(normalizeExportInput(gridDoc()), { generateFallbackPhysicsShape: false })),
    ).toContain("  spriteGenerateFallbackPhysicsShape: 0");
  });
});

describe("toUnityMeta — identity", () => {
  it("seeds a header+atlas hybrid's guid from the packed texture, not the header's sheet", () => {
    const header = {
      source: "padded.png",
      frameWidth: 32,
      frameHeight: 32,
      grid: { cols: 2, rows: 1 },
    };
    const sheetGuid = toUnityMeta(normalizeExportInput(header)).split("\n")[1];
    const atlasGuid = toUnityMeta(normalizeExportInput(atlasDoc())).split("\n")[1];
    const hybridGuid = toUnityMeta(normalizeExportInput({ ...header, ...atlasDoc() })).split(
      "\n",
    )[1];
    expect(hybridGuid).not.toBe(sheetGuid);
    expect(hybridGuid).toBe(atlasGuid);
  });

  it("is byte-identical across runs", () => {
    const a = toUnityMeta(normalizeExportInput(gridDoc()));
    const b = toUnityMeta(normalizeExportInput(gridDoc()));
    expect(a).toBe(b);
  });

  it("derives spriteID from internalID the way modern Unity does", () => {
    const meta = toUnityMeta(normalizeExportInput(gridDoc()));
    const block = spriteBlock(meta, "hero_04");
    const spriteId = fieldIn(block, "spriteID");
    const internalId = Number(fieldIn(block, "internalID"));

    expect(spriteId).toMatch(/^[0-9a-f]{32}$/);
    expect(Number.isSafeInteger(internalId)).toBe(true);
    expect(internalId).not.toBe(0);

    const encU32 = (v: number) => {
      let s = "";
      for (let i = 0; i < 8; i++) s += ((v >>> (4 * i)) & 0xf).toString(16);
      return s;
    };
    const lo = internalId >>> 0;
    const hi = Math.floor(internalId / 4294967296) >>> 0;
    expect(spriteId).toBe(`${encU32(lo)}${encU32(hi)}0800000000000000`);
  });

  it("gives every sprite a unique, non-zero internalID", () => {
    const meta = toUnityMeta(normalizeExportInput(gridDoc()));
    const ids = lines(meta)
      .filter((l) => l.startsWith("      internalID: "))
      .map((l) => Number(l.slice("      internalID: ".length)));
    expect(ids).toHaveLength(12);
    expect(new Set(ids).size).toBe(12);
    expect(ids.every((id) => id !== 0 && Number.isSafeInteger(id))).toBe(true);
  });

  it("spreads internalIDs across the signed range rather than clustering them", () => {
    // Names like hero_00 / hero_01 differ only in their last byte. A bad 64-bit
    // multiply, or plain FNV-1a without trailing mixing rounds, leaves those
    // ids a few thousand-millionths of the range apart.
    const ids = lines(toUnityMeta(normalizeExportInput(gridDoc())))
      .filter((l) => l.startsWith("      internalID: "))
      .map((l) => Number(l.slice("      internalID: ".length)));
    const gaps = ids.slice(1).map((id, i) => Math.abs(id - ids[i]));
    expect(Math.min(...gaps)).toBeGreaterThan(2 ** 40);
    expect(ids.some((id) => id < 0)).toBe(true);
  });

  it("keeps internalIDToNameTable and nameFileIdTable consistent", () => {
    const meta = toUnityMeta(normalizeExportInput(gridDoc()));
    const l = lines(meta);

    // 213 is Unity's YAML class id for Sprite.
    const tableIds = l
      .filter((line) => line.startsWith("      213: "))
      .map((line) => Number(line.slice("      213: ".length)));
    const spriteIds = l
      .filter((line) => line.startsWith("      internalID: "))
      .map((line) => Number(line.slice("      internalID: ".length)));
    expect(tableIds).toEqual(spriteIds);

    const nameTableStart = l.indexOf("    nameFileIdTable:");
    expect(nameTableStart).toBeGreaterThan(-1);
    const nameTable = l.slice(nameTableStart + 1, nameTableStart + 13);
    expect(nameTable[0]).toBe(`      hero_00: ${spriteIds[0]}`);
    expect(nameTable[11]).toBe(`      hero_11: ${spriteIds[11]}`);
    // Unity string-sorts this map.
    expect([...nameTable].sort()).toEqual(nameTable);
  });

  it("changes the guid with the asset path but not between runs", () => {
    const doc = normalizeExportInput(gridDoc());
    const a = lines(toUnityMeta(doc, { assetPath: "Assets/Art/hero.png" }))[1];
    const b = lines(toUnityMeta(doc, { assetPath: "Assets/Enemies/hero.png" }))[1];
    const again = lines(toUnityMeta(doc, { assetPath: "Assets/Art/hero.png" }))[1];
    expect(a).toMatch(/^guid: [0-9a-f]{32}$/);
    expect(a).not.toBe(b);
    expect(a).toBe(again);
  });

  it("reuses an incumbent guid and rejects a malformed one", () => {
    const doc = normalizeExportInput(gridDoc());
    const guid = "FDF91A130C91DEA775DFA60665A073B7";
    expect(lines(toUnityMeta(doc, { guid }))[1]).toBe("guid: fdf91a130c91dea775dfa60665a073b7");
    expect(() => toUnityMeta(doc, { guid: "nope" })).toThrow(/32 hex characters/);
  });
});

describe("toUnityMeta — options", () => {
  it("defaults pixelsPerUnit to the frame height and honours an override", () => {
    expect(lines(toUnityMeta(normalizeExportInput(gridDoc())))).toContain(
      "  spritePixelsToUnits: 32",
    );
    expect(lines(toUnityMeta(normalizeExportInput(gridDoc()), { pixelsPerUnit: 16 }))).toContain(
      "  spritePixelsToUnits: 16",
    );
  });

  it("sets maxTextureSize on both the root and DefaultTexturePlatform", () => {
    const l = lines(toUnityMeta(normalizeExportInput(gridDoc())));
    expect(l.filter((line) => line.trim() === "maxTextureSize: 2048")).toHaveLength(2);

    const big = lines(
      toUnityMeta(normalizeExportInput({ ...gridDoc(), frameWidth: 1024, frameHeight: 1024 })),
    );
    // 4096-wide sheet must not inherit the 2048 default, which would downscale it.
    expect(big.filter((line) => line.trim() === "maxTextureSize: 4096")).toHaveLength(2);

    const forced = lines(toUnityMeta(normalizeExportInput(gridDoc()), { maxTextureSize: 512 }));
    expect(forced.filter((line) => line.trim() === "maxTextureSize: 512")).toHaveLength(2);
  });

  it("switches filterMode and spriteMeshType", () => {
    const l = lines(
      toUnityMeta(normalizeExportInput(gridDoc()), { filterMode: 1, spriteMeshType: 1 }),
    );
    expect(l).toContain("    filterMode: 1");
    expect(l).toContain("  spriteMeshType: 1");
  });

  it("targets serializedVersion 12 (2022.3 / 2023.x)", () => {
    const meta = toUnityMeta(normalizeExportInput(gridDoc()), { serializedVersion: 12 });
    const l = lines(meta);
    expect(l).toContain("  serializedVersion: 12");
    // platformSettings entries drop to sv3, and the sv13-only keys disappear.
    expect(l).toContain("  - serializedVersion: 3");
    expect(meta).not.toContain("customData:");
    expect(meta).not.toContain("spriteCustomMetadata:");
    // Everything else is unchanged.
    expect(l).toContain("  spriteMode: 2");
    expect(l).toContain("    filterMode: 0");
  });

  it("rejects an unsupported serializedVersion", () => {
    const doc = normalizeExportInput(gridDoc());
    expect(() => toUnityMeta(doc, { serializedVersion: 11 as unknown as 12 })).toThrow(
      /serializedVersion must be 12 or 13/,
    );
  });
});

describe("toUnityMeta — edge cases", () => {
  it("handles a single-frame sheet with no tags, pivots or collision", () => {
    const meta = toUnityMeta(
      normalizeExportInput({
        source: "coin.png",
        frameWidth: 16,
        frameHeight: 16,
        grid: { cols: 1, rows: 1, detected: true },
        frameCount: 1,
      }),
    );
    const l = lines(meta);
    expect(l.filter((line) => line === "    - serializedVersion: 2")).toHaveLength(1);
    const block = spriteBlock(meta, "coin_0");
    expect(fieldIn(block, "x")).toBe("0");
    expect(fieldIn(block, "y")).toBe("0");
    expect(fieldIn(block, "alignment")).toBe("0");
    expect(block).toContain("      physicsShape: []");
    // Tags carry no representation in a .meta — Unity clips are separate assets.
    expect(meta).not.toContain("idle");
  });

  it("carries every frame of a 12-frame sheet through in reading order", () => {
    const meta = toUnityMeta(normalizeExportInput(gridDoc()));
    const names = lines(meta)
      .filter((l) => l.startsWith("      name: "))
      .map((l) => l.slice("      name: ".length));
    expect(names).toHaveLength(12);
    expect(names[0]).toBe("hero_00");
    expect(names[11]).toBe("hero_11");
  });

  it("quotes non-ASCII sprite names the way Unity does", () => {
    const meta = toUnityMeta(
      normalizeExportInput({
        atlas: "sheet.png",
        width: 16,
        height: 16,
        frames: { Daño0016: { frame: { x: 0, y: 0, w: 16, h: 16 } } },
      }),
    );
    expect(meta).toContain('      name: "Da\\xF1o0016"');
    expect(meta).toContain('      "Da\\xF1o0016": ');
  });
});
