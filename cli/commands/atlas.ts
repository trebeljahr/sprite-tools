import type { Command } from "commander";
import { basename } from "node:path";
import { writeJsonOutput, fail, parseIntArg, addHelpExtras } from "../lib/common";
import { loadPng, imageToPngBuffer } from "../lib/image-io";
import { writeFileSync } from "node:fs";
import { computeTrimRect, packAtlas, type PackInput } from "../../src/lib/atlas/pack";

export function registerAtlasCommand(program: Command) {
  const cmd = program
    .command("atlas <inputs...>")
    .description("Pack multiple sprites into a single PNG atlas + JSON manifest.")
    .option("--padding <n>", "gutter between packed sprites", (v) => parseIntArg("padding", v), 2)
    .option("--pow2", "round atlas size up to power of 2", false)
    .option("--no-trim", "don't auto-trim transparent borders (default: trim)")
    .option("-o, --output <file>", "output atlas PNG file", "atlas.png")
    .option("--json <file>", "output JSON manifest file", "atlas.json");

  addHelpExtras(cmd, {
    examples: [
      "sprite-tools atlas sprites/*.png",
      "sprite-tools atlas sprites/*.png --padding 4 --pow2 -o game.png --json game.json",
      "sprite-tools atlas sprites/*.png --no-trim   # keep original canvas sizes",
    ],
    output: [
      "PNG atlas + TexturePacker-style JSON manifest:",
      "  { atlas, width, height,",
      "    frames: { 'name.png': { frame:{x,y,w,h}, trimmed,",
      "                            sourceSize, spriteSourceSize }, ... } }",
    ],
  });

  cmd.action(
    (
      inputs: string[],
      opts: {
        padding: number;
        pow2: boolean;
        trim: boolean;
        output: string;
        json: string;
      },
    ) => {
      try {
        if (inputs.length === 0) fail("need at least one input sprite");

        interface Sprite {
          id: string;
          name: string;
          fullWidth: number;
          fullHeight: number;
          trim: { x: number; y: number; w: number; h: number } | null;
          content: ImageData;
        }

        const sprites: Sprite[] = [];
        for (const path of inputs) {
          const raw = loadPng(path);
          const trim = opts.trim ? computeTrimRect(raw) : null;
          const content = trim ? trimImage(raw, trim) : raw;
          sprites.push({
            id: path,
            name: basename(path),
            fullWidth: raw.width,
            fullHeight: raw.height,
            trim,
            content,
          });
        }

        // Build pack inputs.
        const packInputs: PackInput[] = sprites.map((s) => ({
          id: s.id,
          width: s.content.width,
          height: s.content.height,
        }));
        const trimMeta = new Map<
          string,
          | { sourceWidth: number; sourceHeight: number; offsetX: number; offsetY: number }
          | undefined
        >();
        for (const s of sprites) {
          if (s.trim) {
            trimMeta.set(s.id, {
              sourceWidth: s.fullWidth,
              sourceHeight: s.fullHeight,
              offsetX: s.trim.x,
              offsetY: s.trim.y,
            });
          }
        }

        const atlas = packAtlas(packInputs, trimMeta, {
          padding: opts.padding,
          powerOfTwo: opts.pow2,
        });

        // Build atlas ImageData.
        const out = new ImageData(atlas.width, atlas.height);
        for (const f of atlas.frames) {
          const s = sprites.find((x) => x.id === f.id);
          if (!s) continue;
          blit(s.content, out, f.x, f.y);
        }

        writeFileSync(opts.output, imageToPngBuffer(out));

        const manifest = {
          atlas: basename(opts.output),
          width: atlas.width,
          height: atlas.height,
          frames: Object.fromEntries(
            atlas.frames.map((f) => {
              const s = sprites.find((x) => x.id === f.id);
              return [
                s?.name ?? f.id,
                {
                  frame: { x: f.x, y: f.y, w: f.width, h: f.height },
                  trimmed: f.trimmed !== undefined,
                  sourceSize: f.trimmed
                    ? { w: f.trimmed.sourceWidth, h: f.trimmed.sourceHeight }
                    : { w: f.width, h: f.height },
                  spriteSourceSize: f.trimmed
                    ? {
                        x: f.trimmed.offsetX,
                        y: f.trimmed.offsetY,
                        w: f.width,
                        h: f.height,
                      }
                    : { x: 0, y: 0, w: f.width, h: f.height },
                },
              ];
            }),
          ),
        };

        writeJsonOutput(manifest, opts.json);
      } catch (e) {
        fail(e instanceof Error ? e.message : String(e));
      }
    },
  );
}

function trimImage(
  src: ImageData,
  rect: { x: number; y: number; w: number; h: number },
): ImageData {
  const out = new ImageData(rect.w, rect.h);
  for (let y = 0; y < rect.h; y++) {
    const srcRow = ((rect.y + y) * src.width + rect.x) * 4;
    out.data.set(src.data.subarray(srcRow, srcRow + rect.w * 4), y * rect.w * 4);
  }
  return out;
}

function blit(src: ImageData, dst: ImageData, dx: number, dy: number) {
  for (let y = 0; y < src.height; y++) {
    const srcRow = y * src.width * 4;
    const dstRow = ((dy + y) * dst.width + dx) * 4;
    dst.data.set(src.data.subarray(srcRow, srcRow + src.width * 4), dstRow);
  }
}
