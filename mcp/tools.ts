// MCP tool registrations. Each tool wraps the same pure algorithm the CLI
// wraps — the MCP server is a thin transport over the same core.
//
// Tool naming: `sprite_<verb>_<noun>`. Tools that produce images take an
// explicit `output_path` so the client can control where files land;
// responses include a `path` field so agents can chain tools.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { mkdirSync } from "node:fs";
import { dirname, join, basename } from "node:path";

import { loadPng, savePng, sliceSheet, stitchSheet } from "../cli/lib/image-io";
import { detectGridFromImageData } from "../src/lib/pipeline/detect";
import { generateOutline } from "../src/lib/collision/outline";
import { pixelate, hexToRgb } from "../src/lib/pixel-art/pixelate";
import { paletteById, PALETTES } from "../src/lib/pixel-art/palettes";
import { generateNormalMap } from "../src/lib/normal-map/normal-map";
import {
  extractPalette,
  applyPaletteSwap,
  rgbToHex,
  hexToRgb as paletteHexToRgb,
} from "../src/lib/palette/extract";
import { packAtlas, computeTrimRect, type PackInput } from "../src/lib/atlas/pack";

// -----------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------

const PIVOT_PRESETS: Record<string, { nx: number; ny: number }> = {
  center: { nx: 0.5, ny: 0.5 },
  "top-center": { nx: 0.5, ny: 0 },
  "top-left": { nx: 0, ny: 0 },
  "top-right": { nx: 1, ny: 0 },
  "bottom-center": { nx: 0.5, ny: 1 },
  "bottom-left": { nx: 0, ny: 1 },
  "bottom-right": { nx: 1, ny: 1 },
};
const PRESET_IDS = Object.keys(PIVOT_PRESETS) as (keyof typeof PIVOT_PRESETS)[];

function jsonResult(payload: unknown) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(payload, null, 2) },
    ],
  };
}

function loadSheetFromArgs(
  input: string,
  cols?: number,
  rows?: number,
): { image: ImageData; grid: { cols: number; rows: number; detected: boolean }; frames: ImageData[] } {
  const image = loadPng(input);
  let effectiveCols = cols;
  let effectiveRows = rows;
  let detected = false;
  if (effectiveCols === undefined || effectiveRows === undefined) {
    const det = detectGridFromImageData(image);
    effectiveCols ??= det.cols;
    effectiveRows ??= det.rows;
    detected = true;
  }
  const frames =
    effectiveCols === 1 && effectiveRows === 1
      ? [image]
      : sliceSheet(image, effectiveCols, effectiveRows);
  return {
    image,
    grid: { cols: effectiveCols, rows: effectiveRows, detected },
    frames,
  };
}

// -----------------------------------------------------------------
// Tool registrations
// -----------------------------------------------------------------

export function registerAllTools(server: McpServer) {
  // ------- info -------
  server.registerTool(
    "sprite_info",
    {
      description:
        "Inspect a PNG sprite or sheet. Returns width, height, opaque-pixel count, content bounds, and auto-detected grid.",
      inputSchema: {
        input_path: z.string().describe("Absolute path to a PNG file"),
      },
    },
    ({ input_path }) => {
      const img = loadPng(input_path);
      let opaque = 0;
      for (let i = 3; i < img.data.length; i += 4) if (img.data[i] > 0) opaque++;
      const total = img.width * img.height;
      const det = detectGridFromImageData(img);
      const bounds = computeTrimRect(img);
      return jsonResult({
        source: input_path,
        width: img.width,
        height: img.height,
        opaquePixels: opaque,
        opaqueFraction: total > 0 ? Number((opaque / total).toFixed(4)) : 0,
        contentBounds: bounds
          ? { x: bounds.x, y: bounds.y, width: bounds.w, height: bounds.h }
          : null,
        grid: {
          cols: det.cols,
          rows: det.rows,
          confidence: Number(det.confidence.toFixed(3)),
        },
      });
    },
  );

  // ------- detect_grid -------
  server.registerTool(
    "sprite_detect_grid",
    {
      description:
        "Auto-detect the (cols, rows) of a sprite sheet. Returns confidence in [0,1].",
      inputSchema: {
        input_path: z.string().describe("Absolute path to a PNG file"),
      },
    },
    ({ input_path }) => {
      const img = loadPng(input_path);
      const det = detectGridFromImageData(img);
      return jsonResult({
        source: input_path,
        width: img.width,
        height: img.height,
        grid: { cols: det.cols, rows: det.rows },
        confidence: Number(det.confidence.toFixed(3)),
      });
    },
  );

  // ------- slice -------
  server.registerTool(
    "sprite_slice",
    {
      description:
        "Split a sprite sheet into one PNG per cell on disk. Returns the list of written paths.",
      inputSchema: {
        input_path: z.string(),
        out_dir: z.string().describe("Directory to write frames into"),
        cols: z.number().int().positive().optional(),
        rows: z.number().int().positive().optional(),
        name_pattern: z
          .string()
          .default("frame_%02d.png")
          .describe("printf-style pattern, e.g. 'run_%03d.png'"),
      },
    },
    ({ input_path, out_dir, cols, rows, name_pattern }) => {
      const { frames, grid } = loadSheetFromArgs(input_path, cols, rows);
      mkdirSync(out_dir, { recursive: true });
      const paths: string[] = [];
      for (let i = 0; i < frames.length; i++) {
        const filename = formatPattern(name_pattern, i);
        const p = join(out_dir, filename);
        mkdirSync(dirname(p), { recursive: true });
        savePng(frames[i], p);
        paths.push(p);
      }
      return jsonResult({
        source: input_path,
        frameWidth: frames[0]?.width ?? 0,
        frameHeight: frames[0]?.height ?? 0,
        grid,
        frameCount: frames.length,
        paths,
      });
    },
  );

  // ------- trim -------
  server.registerTool(
    "sprite_trim",
    {
      description: "Auto-crop transparent padding around the opaque region of a single sprite.",
      inputSchema: {
        input_path: z.string(),
        output_path: z.string(),
        padding: z.number().int().min(0).default(0),
      },
    },
    ({ input_path, output_path, padding }) => {
      const img = loadPng(input_path);
      const rect = computeTrimRect(img);
      if (!rect) {
        throw new Error("image is fully transparent — nothing to trim");
      }
      const pad = Math.max(0, padding);
      const x = Math.max(0, rect.x - pad);
      const y = Math.max(0, rect.y - pad);
      const w = Math.min(img.width - x, rect.w + pad * 2);
      const h = Math.min(img.height - y, rect.h + pad * 2);
      const out = new ImageData(w, h);
      for (let yy = 0; yy < h; yy++) {
        const srcRow = ((y + yy) * img.width + x) * 4;
        out.data.set(img.data.subarray(srcRow, srcRow + w * 4), yy * w * 4);
      }
      mkdirSync(dirname(output_path), { recursive: true });
      savePng(out, output_path);
      return jsonResult({
        source: input_path,
        output_path,
        sourceWidth: img.width,
        sourceHeight: img.height,
        trim: { x, y, width: w, height: h },
        paddingKept: pad,
      });
    },
  );

  // ------- collision -------
  server.registerTool(
    "sprite_generate_collision",
    {
      description:
        "Per-frame collision polygons from a sprite or sheet. Outputs a structured JSON; tolerance 0 keeps every contour pixel, higher values produce simpler hulls.",
      inputSchema: {
        input_path: z.string(),
        cols: z.number().int().positive().optional(),
        rows: z.number().int().positive().optional(),
        alpha_threshold: z.number().int().min(0).max(254).default(10),
        simplify_tolerance: z.number().min(0).default(10),
        convex_hull: z.boolean().default(false),
      },
    },
    ({
      input_path,
      cols,
      rows,
      alpha_threshold,
      simplify_tolerance,
      convex_hull,
    }) => {
      const { frames, grid } = loadSheetFromArgs(input_path, cols, rows);
      const collision = frames.map((f, i) => {
        const outline = generateOutline(f, {
          alphaThreshold: alpha_threshold,
          simplifyTolerance: simplify_tolerance,
          convexHull: convex_hull,
        });
        return {
          index: i,
          cell: { row: Math.floor(i / grid.cols), col: i % grid.cols },
          pointCount: outline.polygon.length,
          bounds: outline.bounds,
          polygon: outline.polygon.map((p) => [p.x, p.y] as const),
        };
      });
      return jsonResult({
        source: input_path,
        frameWidth: frames[0]?.width ?? 0,
        frameHeight: frames[0]?.height ?? 0,
        grid,
        options: {
          alphaThreshold: alpha_threshold,
          simplifyTolerance: simplify_tolerance,
          convexHull: convex_hull,
        },
        collision,
      });
    },
  );

  // ------- pivot -------
  server.registerTool(
    "sprite_generate_pivot",
    {
      description: "Emit per-frame pivot (anchor) metadata from a preset or explicit coords.",
      inputSchema: {
        input_path: z.string(),
        cols: z.number().int().positive().optional(),
        rows: z.number().int().positive().optional(),
        preset: z.enum(PRESET_IDS as [string, ...string[]]).default("bottom-center"),
        x: z.number().int().optional().describe("Override X (pixels)"),
        y: z.number().int().optional().describe("Override Y (pixels)"),
      },
    },
    ({ input_path, cols, rows, preset, x, y }) => {
      const { frames, grid } = loadSheetFromArgs(input_path, cols, rows);
      const p = PIVOT_PRESETS[preset];
      const pivots = frames.map((f, i) => ({
        index: i,
        cell: { row: Math.floor(i / grid.cols), col: i % grid.cols },
        pivot: {
          x: x ?? Math.round(p.nx * (f.width - 1)),
          y: y ?? Math.round(p.ny * (f.height - 1)),
        },
      }));
      return jsonResult({
        source: input_path,
        frameWidth: frames[0]?.width ?? 0,
        frameHeight: frames[0]?.height ?? 0,
        grid,
        options: { preset, explicit: x !== undefined || y !== undefined ? { x, y } : null },
        pivots,
      });
    },
  );

  // ------- tags -------
  server.registerTool(
    "sprite_generate_tags",
    {
      description: "Emit Aseprite-style animation tag metadata (named frame ranges).",
      inputSchema: {
        input_path: z.string(),
        cols: z.number().int().positive().optional(),
        rows: z.number().int().positive().optional(),
        tags: z
          .array(
            z.object({
              name: z.string(),
              from: z.number().int().min(0),
              to: z.number().int().min(0),
              direction: z.enum(["forward", "reverse", "pingpong"]).default("forward"),
              fps: z.number().int().positive().default(10),
            }),
          )
          .default([]),
      },
    },
    ({ input_path, cols, rows, tags }) => {
      const { frames, grid } = loadSheetFromArgs(input_path, cols, rows);
      return jsonResult({
        source: input_path,
        frameWidth: frames[0]?.width ?? 0,
        frameHeight: frames[0]?.height ?? 0,
        grid,
        frameCount: frames.length,
        tags,
      });
    },
  );

  // ------- palette -------
  server.registerTool(
    "sprite_extract_palette",
    {
      description:
        "Extract N dominant colors from a sprite (or shared across all frames of a sheet).",
      inputSchema: {
        input_path: z.string(),
        cols: z.number().int().positive().optional(),
        rows: z.number().int().positive().optional(),
        colors: z.number().int().min(1).max(256).default(8),
      },
    },
    ({ input_path, cols, rows, colors }) => {
      const { frames, grid } = loadSheetFromArgs(input_path, cols, rows);
      let total = 0;
      for (const f of frames) total += f.width * f.height;
      const merged = new ImageData(total, 1);
      let off = 0;
      for (const f of frames) {
        merged.data.set(f.data, off);
        off += f.data.length;
      }
      const palette = extractPalette(merged, colors);
      return jsonResult({
        source: input_path,
        frameWidth: frames[0]?.width ?? 0,
        frameHeight: frames[0]?.height ?? 0,
        grid,
        options: { colors },
        palette: palette.map(rgbToHex),
      });
    },
  );

  // ------- palette_swap -------
  server.registerTool(
    "sprite_palette_swap",
    {
      description: "Recolor a sprite by swapping one or more palette colors; writes a PNG.",
      inputSchema: {
        input_path: z.string(),
        output_path: z.string(),
        cols: z.number().int().positive().optional(),
        rows: z.number().int().positive().optional(),
        colors: z.number().int().min(1).max(256).default(8),
        swaps: z
          .array(
            z.object({
              from: z.string().describe("hex #rrggbb (must match an extracted palette entry)"),
              to: z.string().describe("hex #rrggbb"),
            }),
          )
          .min(1),
      },
    },
    ({ input_path, output_path, cols, rows, colors, swaps }) => {
      const { frames, grid } = loadSheetFromArgs(input_path, cols, rows);
      let total = 0;
      for (const f of frames) total += f.width * f.height;
      const merged = new ImageData(total, 1);
      let off = 0;
      for (const f of frames) {
        merged.data.set(f.data, off);
        off += f.data.length;
      }
      const palette = extractPalette(merged, colors);
      const swapPairs = swaps.map((s) => ({
        from: paletteHexToRgb(s.from),
        to: paletteHexToRgb(s.to),
      }));
      const recolored = frames.map((f) => applyPaletteSwap(f, palette, swapPairs));
      const out =
        recolored.length === 1
          ? recolored[0]
          : stitchSheet(recolored, grid.cols, grid.rows);
      mkdirSync(dirname(output_path), { recursive: true });
      savePng(out, output_path);
      return jsonResult({
        source: input_path,
        output_path,
        grid,
        palette: palette.map(rgbToHex),
        swaps,
      });
    },
  );

  // ------- pixelate -------
  server.registerTool(
    "sprite_pixelate",
    {
      description:
        "Downscale a sprite into pixel-art form with optional color quantization, dither, and preset palettes (gameboy, pico8, nes, cga, mono).",
      inputSchema: {
        input_path: z.string(),
        output_path: z.string(),
        cols: z.number().int().positive().optional(),
        rows: z.number().int().positive().optional(),
        pixel_size: z.number().int().min(1).max(64).default(4),
        colors: z.number().int().min(0).max(256).default(16),
        palette: z.enum(PALETTES.map((p) => p.id) as [string, ...string[]]).default("none"),
        dither: z.boolean().default(false),
        upscale: z.boolean().default(true).describe("Scale back up to source size with blocky pixels"),
      },
    },
    ({
      input_path,
      output_path,
      cols,
      rows,
      pixel_size,
      colors,
      palette,
      dither,
      upscale,
    }) => {
      const { frames, grid } = loadSheetFromArgs(input_path, cols, rows);
      const preset = paletteById(palette);
      const paletteRgb =
        preset.colors.length > 0 ? preset.colors.map(hexToRgb) : undefined;

      const processed = frames.map((f) => {
        const small = pixelate(f, {
          pixelSize: pixel_size,
          colorCount: colors,
          palette: paletteRgb,
          dither: dither ? "floyd-steinberg" : "none",
          alphaThreshold: 0,
        });
        if (!upscale) return small;
        const scale = Math.max(1, Math.round(f.width / small.width));
        return upscaleNearest(small, scale);
      });

      const out =
        processed.length === 1
          ? processed[0]
          : stitchSheet(processed, grid.cols, grid.rows);
      mkdirSync(dirname(output_path), { recursive: true });
      savePng(out, output_path);
      return jsonResult({
        source: input_path,
        output_path,
        grid,
        options: { pixel_size, colors, palette, dither, upscale },
      });
    },
  );

  // ------- normal_map -------
  server.registerTool(
    "sprite_generate_normal_map",
    {
      description:
        "Generate an OpenGL-style (or DirectX, via flip_y) normal map from alpha, luminance, or a mix.",
      inputSchema: {
        input_path: z.string(),
        output_path: z.string(),
        cols: z.number().int().positive().optional(),
        rows: z.number().int().positive().optional(),
        source: z.enum(["alpha", "luminance", "mixed"]).default("alpha"),
        strength: z.number().default(1),
        mix: z.number().min(0).max(1).default(0.5),
        flip_y: z.boolean().default(false),
        blur: z.number().int().min(0).max(16).default(0),
      },
    },
    ({
      input_path,
      output_path,
      cols,
      rows,
      source,
      strength,
      mix,
      flip_y,
      blur,
    }) => {
      const { frames, grid } = loadSheetFromArgs(input_path, cols, rows);
      const processed = frames.map((f) =>
        generateNormalMap(f, {
          source,
          strength,
          mix,
          flipY: flip_y,
          blur,
        }),
      );
      const out =
        processed.length === 1
          ? processed[0]
          : stitchSheet(processed, grid.cols, grid.rows);
      mkdirSync(dirname(output_path), { recursive: true });
      savePng(out, output_path);
      return jsonResult({
        source: input_path,
        output_path,
        grid,
        options: { source, strength, mix, flip_y, blur },
      });
    },
  );

  // ------- atlas -------
  server.registerTool(
    "sprite_pack_atlas",
    {
      description:
        "Pack multiple sprite PNGs into a single atlas PNG + TexturePacker-style JSON manifest.",
      inputSchema: {
        input_paths: z.array(z.string()).min(1),
        output_path: z.string(),
        json_path: z.string(),
        padding: z.number().int().min(0).default(2),
        power_of_two: z.boolean().default(false),
        trim: z.boolean().default(true),
      },
    },
    ({ input_paths, output_path, json_path, padding, power_of_two, trim }) => {
      interface Sprite {
        id: string;
        name: string;
        fullWidth: number;
        fullHeight: number;
        trim: { x: number; y: number; w: number; h: number } | null;
        content: ImageData;
      }
      const sprites: Sprite[] = [];
      for (const path of input_paths) {
        const raw = loadPng(path);
        const trimRect = trim ? computeTrimRect(raw) : null;
        const content = trimRect ? sliceRect(raw, trimRect) : raw;
        sprites.push({
          id: path,
          name: basename(path),
          fullWidth: raw.width,
          fullHeight: raw.height,
          trim: trimRect,
          content,
        });
      }
      const packInputs: PackInput[] = sprites.map((s) => ({
        id: s.id,
        width: s.content.width,
        height: s.content.height,
      }));
      const trimMeta = new Map<
        string,
        { sourceWidth: number; sourceHeight: number; offsetX: number; offsetY: number } | undefined
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
        padding,
        powerOfTwo: power_of_two,
      });
      const out = new ImageData(atlas.width, atlas.height);
      for (const f of atlas.frames) {
        const s = sprites.find((x) => x.id === f.id);
        if (!s) continue;
        blit(s.content, out, f.x, f.y);
      }
      mkdirSync(dirname(output_path), { recursive: true });
      savePng(out, output_path);

      const manifest = {
        atlas: basename(output_path),
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
      mkdirSync(dirname(json_path), { recursive: true });
      require("node:fs").writeFileSync(
        json_path,
        JSON.stringify(manifest, null, 2) + "\n",
      );
      return jsonResult({
        atlas_path: output_path,
        manifest_path: json_path,
        ...manifest,
      });
    },
  );

  // ------- meta -------
  server.registerTool(
    "sprite_generate_meta",
    {
      description:
        "One-shot: collision + pivot + tags in a single merged JSON. Pass `true` or config for each section you want; omit to skip.",
      inputSchema: {
        input_path: z.string(),
        cols: z.number().int().positive().optional(),
        rows: z.number().int().positive().optional(),
        collision: z
          .object({
            alpha_threshold: z.number().default(10),
            simplify_tolerance: z.number().default(10),
            convex_hull: z.boolean().default(false),
          })
          .optional(),
        pivot: z
          .object({
            preset: z.enum(PRESET_IDS as [string, ...string[]]).default("bottom-center"),
            x: z.number().int().optional(),
            y: z.number().int().optional(),
          })
          .optional(),
        tags: z
          .array(
            z.object({
              name: z.string(),
              from: z.number().int().min(0),
              to: z.number().int().min(0),
              direction: z.enum(["forward", "reverse", "pingpong"]).default("forward"),
              fps: z.number().int().positive().default(10),
            }),
          )
          .optional(),
      },
    },
    ({ input_path, cols, rows, collision, pivot, tags }) => {
      const { frames, grid } = loadSheetFromArgs(input_path, cols, rows);
      const out: Record<string, unknown> = {
        source: input_path,
        frameWidth: frames[0]?.width ?? 0,
        frameHeight: frames[0]?.height ?? 0,
        grid,
        frameCount: frames.length,
      };
      if (collision) {
        out.collision = frames.map((f, i) => {
          const o = generateOutline(f, {
            alphaThreshold: collision.alpha_threshold,
            simplifyTolerance: collision.simplify_tolerance,
            convexHull: collision.convex_hull,
          });
          return {
            index: i,
            cell: { row: Math.floor(i / grid.cols), col: i % grid.cols },
            pointCount: o.polygon.length,
            bounds: o.bounds,
            polygon: o.polygon.map((p) => [p.x, p.y] as const),
          };
        });
      }
      if (pivot) {
        const p = PIVOT_PRESETS[pivot.preset];
        out.pivots = frames.map((f, i) => ({
          index: i,
          cell: { row: Math.floor(i / grid.cols), col: i % grid.cols },
          pivot: {
            x: pivot.x ?? Math.round(p.nx * (f.width - 1)),
            y: pivot.y ?? Math.round(p.ny * (f.height - 1)),
          },
        }));
      }
      if (tags && tags.length > 0) {
        out.tags = tags;
      }
      return jsonResult(out);
    },
  );
}

// -----------------------------------------------------------------
// Local helpers
// -----------------------------------------------------------------

function formatPattern(pattern: string, n: number): string {
  return pattern.replace(/%(0?\d*)d/g, (_m, pad: string) => {
    const s = String(n);
    if (pad.startsWith("0")) return s.padStart(parseInt(pad, 10), "0");
    if (pad) return s.padStart(parseInt(pad, 10), " ");
    return s;
  });
}

function sliceRect(
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

function upscaleNearest(img: ImageData, f: number): ImageData {
  if (f <= 1) return img;
  const out = new ImageData(img.width * f, img.height * f);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const si = (y * img.width + x) * 4;
      const r = img.data[si];
      const g = img.data[si + 1];
      const b = img.data[si + 2];
      const a = img.data[si + 3];
      for (let dy = 0; dy < f; dy++) {
        for (let dx = 0; dx < f; dx++) {
          const di = ((y * f + dy) * out.width + x * f + dx) * 4;
          out.data[di] = r;
          out.data[di + 1] = g;
          out.data[di + 2] = b;
          out.data[di + 3] = a;
        }
      }
    }
  }
  return out;
}
