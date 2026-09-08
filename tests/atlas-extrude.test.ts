import { describe, it, expect } from "vitest";
import { packAtlas, type PackInput, type PackResult } from "@/lib/atlas/pack";
import { effectiveExtrude, extrudeFrames } from "@/lib/atlas/extrude";
import { filledRect } from "./helpers";

type RGBA = [number, number, number, number];

const RED: RGBA = [255, 0, 0, 255];
const BLUE: RGBA = [0, 0, 255, 255];
const TRANSPARENT: RGBA = [0, 0, 0, 0];

function pixelAt(img: ImageData, x: number, y: number): RGBA {
  const i = (y * img.width + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]];
}

/** Copy a sprite's pixels into the atlas at its packed rect (what the CLI does). */
function blit(atlas: ImageData, sprite: ImageData, dx: number, dy: number): void {
  for (let y = 0; y < sprite.height; y++) {
    for (let x = 0; x < sprite.width; x++) {
      const si = (y * sprite.width + x) * 4;
      const di = ((y + dy) * atlas.width + (x + dx)) * 4;
      atlas.data[di] = sprite.data[si];
      atlas.data[di + 1] = sprite.data[si + 1];
      atlas.data[di + 2] = sprite.data[si + 2];
      atlas.data[di + 3] = sprite.data[si + 3];
    }
  }
}

/** Solid w×h sprite of a single colour. */
function solid(w: number, h: number, color: RGBA): ImageData {
  return filledRect(w, h, 0, 0, w, h, color);
}

/** Pack a red 10×10 and a blue 8×8 with padding 2 and blit them into a real atlas. */
function buildTwoSpriteAtlas(): {
  atlas: ImageData;
  frames: PackResult[];
  colorOf: Map<string, RGBA>;
} {
  const inputs: PackInput[] = [
    { id: "red", width: 10, height: 10 },
    { id: "blue", width: 8, height: 8 },
  ];
  const packed = packAtlas(inputs, new Map(), { padding: 2, powerOfTwo: false });
  const atlas = new ImageData(packed.width, packed.height);
  const sprites = new Map<string, ImageData>([
    ["red", solid(10, 10, RED)],
    ["blue", solid(8, 8, BLUE)],
  ]);
  for (const frame of packed.frames) {
    blit(atlas, sprites.get(frame.id)!, frame.x, frame.y);
  }
  return {
    atlas,
    frames: packed.frames,
    colorOf: new Map<string, RGBA>([
      ["red", RED],
      ["blue", BLUE],
    ]),
  };
}

describe("effectiveExtrude", () => {
  it("clamps the request to the gutter padding provides", () => {
    expect(effectiveExtrude(4, 2)).toBe(2);
    expect(effectiveExtrude(1, 2)).toBe(1);
    expect(effectiveExtrude(2, 2)).toBe(2);
  });

  it("is a no-op at padding 0", () => {
    expect(effectiveExtrude(1, 0)).toBe(0);
    expect(effectiveExtrude(99, 0)).toBe(0);
  });

  it("floors negatives and fractions to a sane integer", () => {
    expect(effectiveExtrude(-1, 2)).toBe(0);
    expect(effectiveExtrude(-0.5, 2)).toBe(0);
    expect(effectiveExtrude(3, -2)).toBe(0);
    expect(effectiveExtrude(2.9, 4)).toBe(2);
    expect(effectiveExtrude(4, 2.9)).toBe(2);
  });
});

describe("extrudeFrames", () => {
  it("leaves the gutter transparent without extrusion", () => {
    const { atlas, frames } = buildTwoSpriteAtlas();
    for (const f of frames) {
      expect(pixelAt(atlas, f.x - 1, f.y)).toEqual(TRANSPARENT);
      expect(pixelAt(atlas, f.x + f.width, f.y)).toEqual(TRANSPARENT);
      expect(pixelAt(atlas, f.x, f.y - 1)).toEqual(TRANSPARENT);
      expect(pixelAt(atlas, f.x, f.y + f.height)).toEqual(TRANSPARENT);
    }

    // amount 0 changes nothing.
    const before = Uint8ClampedArray.from(atlas.data);
    extrudeFrames(atlas, frames, 0);
    expect(atlas.data).toEqual(before);
  });

  it("fills each sprite's four edge gutters with that sprite's colour", () => {
    const { atlas, frames, colorOf } = buildTwoSpriteAtlas();
    extrudeFrames(atlas, frames, 1);

    for (const f of frames) {
      const color = colorOf.get(f.id)!;
      // Left / right gutter, sampled along the sprite's full height.
      for (let y = f.y; y < f.y + f.height; y++) {
        expect(pixelAt(atlas, f.x - 1, y)).toEqual(color);
        expect(pixelAt(atlas, f.x + f.width, y)).toEqual(color);
      }
      // Top / bottom gutter, sampled along the sprite's full width.
      for (let x = f.x; x < f.x + f.width; x++) {
        expect(pixelAt(atlas, x, f.y - 1)).toEqual(color);
        expect(pixelAt(atlas, x, f.y + f.height)).toEqual(color);
      }
    }
  });

  it("fills corner gutter pixels with the sprite's corner pixel", () => {
    const { atlas, frames, colorOf } = buildTwoSpriteAtlas();
    extrudeFrames(atlas, frames, 1);

    for (const f of frames) {
      const color = colorOf.get(f.id)!;
      expect(pixelAt(atlas, f.x - 1, f.y - 1)).toEqual(color);
      expect(pixelAt(atlas, f.x + f.width, f.y - 1)).toEqual(color);
      expect(pixelAt(atlas, f.x - 1, f.y + f.height)).toEqual(color);
      expect(pixelAt(atlas, f.x + f.width, f.y + f.height)).toEqual(color);
    }
  });

  it("keeps each sprite's own colour — no bleed across sprites", () => {
    const { atlas, frames, colorOf } = buildTwoSpriteAtlas();
    extrudeFrames(atlas, frames, 1);
    const red = frames.find((f) => f.id === "red")!;
    const blue = frames.find((f) => f.id === "blue")!;
    expect(pixelAt(atlas, red.x - 1, red.y)).toEqual(colorOf.get("red"));
    expect(pixelAt(atlas, blue.x - 1, blue.y)).toEqual(colorOf.get("blue"));
    expect(pixelAt(atlas, red.x - 1, red.y)).not.toEqual(pixelAt(atlas, blue.x - 1, blue.y));
  });

  it("extrudes multiple rings when amount > 1", () => {
    const { atlas, frames, colorOf } = buildTwoSpriteAtlas();
    extrudeFrames(atlas, frames, 2);
    for (const f of frames) {
      const color = colorOf.get(f.id)!;
      for (let d = 1; d <= 2; d++) {
        expect(pixelAt(atlas, f.x - d, f.y)).toEqual(color);
        expect(pixelAt(atlas, f.x + f.width - 1 + d, f.y)).toEqual(color);
        expect(pixelAt(atlas, f.x, f.y - d)).toEqual(color);
        expect(pixelAt(atlas, f.x, f.y + f.height - 1 + d)).toEqual(color);
        expect(pixelAt(atlas, f.x - d, f.y - d)).toEqual(color);
      }
    }
  });

  it("never modifies pixels inside a frame rect", () => {
    const { atlas, frames } = buildTwoSpriteAtlas();
    const inside = frames.map((f) => {
      const rows: number[][] = [];
      for (let y = f.y; y < f.y + f.height; y++) {
        const row: number[] = [];
        for (let x = f.x; x < f.x + f.width; x++) row.push(...pixelAt(atlas, x, y));
        rows.push(row);
      }
      return rows;
    });

    extrudeFrames(atlas, frames, 2);

    frames.forEach((f, fi) => {
      for (let y = f.y; y < f.y + f.height; y++) {
        const row: number[] = [];
        for (let x = f.x; x < f.x + f.width; x++) row.push(...pixelAt(atlas, x, y));
        expect(row).toEqual(inside[fi][y - f.y]);
      }
    });
  });

  it("handles a frame flush against the atlas edge without writing out of bounds", () => {
    // Frame fills the whole atlas — every extrude destination is off-atlas.
    const atlas = new ImageData(6, 6);
    blit(atlas, solid(6, 6, RED), 0, 0);
    const before = Uint8ClampedArray.from(atlas.data);
    expect(() => extrudeFrames(atlas, [{ x: 0, y: 0, width: 6, height: 6 }], 3)).not.toThrow();
    expect(atlas.data).toEqual(before);
    expect(atlas.data.length).toBe(6 * 6 * 4);
  });

  it("extrudes only inward-available gutter for a corner-anchored frame", () => {
    // 8×8 atlas, 4×4 red sprite flush at the top-left corner.
    const atlas = new ImageData(8, 8);
    blit(atlas, solid(4, 4, RED), 0, 0);
    extrudeFrames(atlas, [{ x: 0, y: 0, width: 4, height: 4 }], 1);

    // The right and bottom gutters exist and are filled.
    for (let y = 0; y < 4; y++) expect(pixelAt(atlas, 4, y)).toEqual(RED);
    for (let x = 0; x < 4; x++) expect(pixelAt(atlas, x, 4)).toEqual(RED);
    expect(pixelAt(atlas, 4, 4)).toEqual(RED);
    // Nothing beyond the ring got touched.
    expect(pixelAt(atlas, 5, 0)).toEqual(TRANSPARENT);
    expect(pixelAt(atlas, 0, 5)).toEqual(TRANSPARENT);
  });

  it("ignores degenerate frames and empty frame lists", () => {
    const atlas = new ImageData(8, 8);
    blit(atlas, solid(4, 4, RED), 2, 2);
    const before = Uint8ClampedArray.from(atlas.data);
    extrudeFrames(atlas, [], 2);
    extrudeFrames(atlas, [{ x: 2, y: 2, width: 0, height: 4 }], 2);
    extrudeFrames(atlas, [{ x: 2, y: 2, width: 4, height: -1 }], 2);
    expect(atlas.data).toEqual(before);
  });
});
