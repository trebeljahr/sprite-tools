// MCP tool registrations. Each tool wraps the same pure algorithm the CLI
// wraps — the MCP server is a thin transport over the same core.
//
// Tool naming: `sprite_<verb>_<noun>`. Tools that produce images take an
// explicit `output_path` so the client can control where files land;
// responses include a `path` field so agents can chain tools.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, basename, resolve } from "node:path";

import { loadPng, savePng, stitchSheet } from "../cli/lib/image-io";
import { gridPaddingFromOpts, sheetFromImage, sheetSizeFromSource } from "../cli/lib/common";
import { applyDurationSpecs, type FrameDurations } from "../src/lib/animation/durations";
import { detectGridFromImageData } from "../src/lib/pipeline/detect";
import type { GridMargin, GridSpacing } from "../src/lib/pipeline/grid";
import {
  applyChromaKeyToImageData,
  applySolidFillToImageData,
  detectBackgroundColor,
  hexToRgb as chromaHexToRgb,
  type ChromaCoreConfig,
  type Rgb,
} from "../src/lib/pipeline/chroma-core";
import { generateOutline } from "../src/lib/collision/outline";
import { pixelate, hexToRgb } from "../src/lib/pixel-art/pixelate";
import { paletteById, PALETTES } from "../src/lib/pixel-art/palettes";
import {
  upscale as upscalePixels,
  upscaleNearestBy,
  UPSCALE_ALGORITHMS,
  type UpscaleAlgorithm,
} from "../src/lib/pixel-art/upscale";
import { generateNormalMap } from "../src/lib/normal-map/normal-map";
import {
  applyOutlineFx,
  requiredMargin,
  type Connectivity,
  type Margin,
  type OutlineFxConfig,
} from "../src/lib/outline/outline-fx";
import {
  extractPalette,
  applyPaletteSwap,
  rgbToHex,
  hexToRgb as paletteHexToRgb,
} from "../src/lib/palette/extract";
import { detectRamps, DEFAULT_HUE_TOLERANCE } from "../src/lib/palette/ramps";
import {
  describeRamps,
  hueShiftVariants,
  parseVariantSet,
  resolveVariant,
  slugifyVariantName,
  variantFileName,
  VARIANT_MANIFEST_VERSION,
  VARIANT_SET_VERSION,
  type VariantManifest,
  type VariantManifestEntry,
} from "../src/lib/palette/variants";
import { packAtlas, computeTrimRect, type PackInput } from "../src/lib/atlas/pack";
import { effectiveExtrude, extrudeFrames } from "../src/lib/atlas/extrude";
import {
  clampInsets,
  detectNineSlice,
  nineSliceRegions,
  stretchNineSlice,
  DEFAULT_ALPHA_THRESHOLD,
  DEFAULT_MIN_MIDDLE,
  DEFAULT_TOLERANCE,
  type NineSliceInsets,
} from "../src/lib/nine-slice/nine-slice";
import { decodeNinePatch, encodeNinePatch } from "../src/lib/nine-slice/ninepatch";
import {
  applyDedupe,
  buildTagPartitions,
  findDuplicateFrames,
  parseTagsDocument,
  remapFrameDurations,
  remapTags,
  type ParsedTagsDocument,
} from "../src/lib/pipeline/dedupe-core";

import {
  detectExportInputKind,
  normalizeExportInput,
  stripExtension,
} from "../src/lib/export/types";
import {
  toGodotAtlasTextureFiles,
  toGodotSpriteFrames,
  type GodotExportOptions,
} from "../src/lib/export/godot";
import { toUnityMeta, unityMetaFilename, type UnityExportOptions } from "../src/lib/export/unity";
import {
  toAsepriteJson,
  type AsepriteExportOptions,
  type AsepriteFormat,
} from "../src/lib/export/aseprite";
import {
  toPhaserAtlas,
  type PhaserExportOptions,
  type PhaserFramesLayout,
} from "../src/lib/export/phaser";
import {
  lintSheet,
  isRuleId,
  RULE_IDS,
  SEVERITY_ORDER,
  validateRuleOption,
  type DeepPartial,
  type LintConfig,
} from "../src/lib/lint";
import { compositeFrames, isAsepriteFile, parseAseprite } from "../src/lib/aseprite";
// Not from the ../src/lib/aseprite barrel on purpose: that barrel is browser-safe
// and pulling node:zlib through it would break the web bundle.
import { inflateNode } from "../src/lib/aseprite/inflate-node";
import {
  buildAsepriteMetadata,
  resolveAsepriteLayers,
  resolveAsepriteRange,
} from "../cli/commands/aseprite";

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

const HEX_COLOR = /^#?[0-9a-fA-F]{6}$/;

const ZERO_FX_MARGIN: Margin = { left: 0, top: 0, right: 0, bottom: 0 };
/** One variant recipe, in this surface's snake_case / array-of-pairs dialect. */
const VARIANT_SPEC_INPUT = z.object({
  name: z.string().min(1).describe("Display name; slugified into the output filename"),
  swaps: z
    .array(z.object({ from: z.string(), to: z.string() }))
    .optional()
    .describe(
      "Literal per-colour substitutions, hex #rrggbb. Applied last, so they override ramps and hue_shift",
    ),
  ramps: z
    .array(z.object({ base: z.string(), to: z.string() }))
    .optional()
    .describe(
      "Re-tint whole ramps: `base` is ANY member hex of the ramp to move (see sprite_detect_ramps), `to` is its new base colour",
    ),
  hue_shift: z
    .number()
    .optional()
    .describe("Degrees to rotate the hue of every palette entry; applied first"),
});

/**
 * The two mutually exclusive ways to say which variants to build. Kept apart
 * from the tool's input shape so the same fields can be both advertised to the
 * client (as a raw shape, which is what the SDK turns into JSON Schema) and
 * cross-validated by a zod refine — a refined object would come back as an
 * empty schema in tools/list.
 */
const VARIANT_SOURCE_SHAPE = {
  variants: z
    .array(VARIANT_SPEC_INPUT)
    .min(1)
    .optional()
    .describe("Explicit variant recipes. Mutually exclusive with hue_variants"),
  hue_variants: z
    .number()
    .int()
    .min(1)
    .max(64)
    .optional()
    .describe(
      "Instead of `variants`: generate N evenly spaced hue rotations named hue000, hue045, … The 0-degree original counts as one of the N",
    ),
};

const VARIANT_SOURCE = z
  .object(VARIANT_SOURCE_SHAPE)
  .refine((v) => (v.variants === undefined) !== (v.hue_variants === undefined), {
    message: "supply exactly one of `variants` or `hue_variants`",
  });

// Derived from the core module so the schema can never drift from the algorithms
// that actually exist; the per-algorithm sentences are the core's own copy.
const UPSCALE_ALGO_IDS = UPSCALE_ALGORITHMS.map((a) => a.id) as [string, ...string[]];
const UPSCALE_ALGO_HELP = UPSCALE_ALGORITHMS.map((a) => `${a.id}: ${a.description}`).join(" ");

// Per-frame hold times are authored as inclusive frame-index ranges — an
// LLM caller gets that right far more often than a sparse array — and are
// folded into the document-level `frameDurations` array before emitting.
const FRAME_DURATIONS_SCHEMA = z
  .array(
    z.object({
      from: z.number().int().min(0).describe("First frame index of the hold (0-based)"),
      to: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Last frame index, inclusive; omit to hold only `from`"),
      ms: z.number().int().positive().describe("Hold time in milliseconds"),
    }),
  )
  .optional()
  .describe(
    "Per-frame hold times in milliseconds, e.g. [{ from: 2, to: 3, ms: 250 }]. Ranges are " +
      "inclusive and later entries win where they overlap. Frames left uncovered fall back " +
      "to the fps of whichever tag plays them, so you can hold two key poses without timing " +
      "the other frames. Emitted as the document's global `frameDurations` array (one entry " +
      "per frame, null where unset); omit this to keep uniform fps timing.",
  );

type FrameDurationSpec = { from: number; to?: number; ms: number };

function resolveFrameDurations(
  entries: FrameDurationSpec[] | undefined,
  frameCount: number,
): FrameDurations | undefined {
  if (!entries || entries.length === 0) return undefined;
  return applyDurationSpecs(
    entries.map((e) => `${e.from}-${e.to ?? e.from}=${e.ms}`),
    frameCount,
  );
}

// The one explanation of the dedupe threshold. Shared between the tool
// description and the parameter description so the two can never drift, and
// worded identically to the CLI --help and the docs.
const MAE_THRESHOLD_DOC =
  "threshold is the mean absolute difference per RGBA channel on a 0-255 scale, averaged over every channel of every pixel. 0 requires byte-identical frames. 1 means the average channel differs by 1/255 (~0.4%), the scale of rounding noise from lossy video compression or canvas alpha premultiplication. 2-4 absorbs a handful of stray pixels. Above ~8 visibly different poses start collapsing.";

/** Output flavours each engine exporter offers; the first entry is that format's default. */
const EXPORT_VARIANTS = {
  godot: ["spriteframes", "atlastextures"],
  unity: ["meta"],
  aseprite: ["hash", "array"],
  phaser: ["hash", "array"],
} as const;

function jsonResult(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  };
}

/**
 * The grid knobs every sheet-consuming tool accepts. One shared block so the
 * sheet tools cannot drift, and so an agent that learns them on `sprite_slice`
 * can use the same words everywhere.
 */
const SHEET_GRID_ARGS = {
  cols: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Columns in the sheet; auto-detected if omitted"),
  rows: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Rows in the sheet; auto-detected if omitted"),
  margin: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      "Border in px around the whole sheet, before the first cell. Sheets exported by Kenney, Tiled or TexturePacker often have one; slicing them without it bleeds a strip of the neighbouring sprite into every frame. Run sprite_detect_grid first if you do not know the number.",
    ),
  margin_x: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Left+right border in px; beats `margin` on the horizontal axis"),
  margin_y: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Top+bottom border in px; beats `margin` on the vertical axis"),
  spacing: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      "Gutter in px between cells, both axes. Kenney and Tiled tilesets typically use 1-2. Leave unset for flush sheets; run sprite_detect_grid first if unknown.",
    ),
  spacing_x: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Horizontal gutter in px; beats `spacing`"),
  spacing_y: z.number().int().min(0).optional().describe("Vertical gutter in px; beats `spacing`"),
};

/** The same fields as handed back by zod, i.e. what a handler's `...gridArgs` rest holds. */
interface SheetGridArgs {
  cols?: number;
  rows?: number;
  margin?: number;
  margin_x?: number;
  margin_y?: number;
  spacing?: number;
  spacing_x?: number;
  spacing_y?: number;
}

/**
 * The choke point every sheet-consuming tool goes through. Delegates to the
 * CLI's sheetFromImage so both transports resolve geometry identically: stated
 * fields win, detection fills the rest, detected padding that cannot tile the
 * sheet is dropped rather than thrown. A GridFitError from a padding the
 * caller stated propagates to the client — a wrong slice is worse than an
 * error the agent can act on.
 */
function loadSheetFromArgs(
  input: string,
  args: SheetGridArgs = {},
): {
  image: ImageData;
  grid: {
    cols: number;
    rows: number;
    detected: boolean;
    margin: GridMargin;
    spacing: GridSpacing;
  };
  frames: ImageData[];
} {
  return gridFromImage(loadPng(input), args);
}

type SheetGrid = ReturnType<typeof loadSheetFromArgs>;

// Same resolution, but starting from pixels that are already in memory — the
// nine-slice tool has to strip a .9.png marker border before it can slice.
function gridFromImage(image: ImageData, args: SheetGridArgs = {}): SheetGrid {
  const { grid, frames } = sheetFromImage(
    image,
    args.cols,
    args.rows,
    gridPaddingFromOpts({
      margin: args.margin,
      marginX: args.margin_x,
      marginY: args.margin_y,
      spacing: args.spacing,
      spacingX: args.spacing_x,
      spacingY: args.spacing_y,
    }),
  );
  return {
    image,
    // Report the geometry actually used, not the geometry asked for.
    grid: {
      cols: grid.cols,
      rows: grid.rows,
      detected: grid.detected,
      margin: grid.margin,
      spacing: grid.spacing,
    },
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
        "Inspect a PNG sprite or sheet. Returns width, height, opaque-pixel count, content bounds, and the auto-detected grid — cols, rows plus the sheet's outer margin and inter-cell spacing in px.",
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
          margin: det.margin,
          spacing: det.spacing,
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
        "Auto-detect the layout of a sprite sheet: cols, rows, the outer margin (left/top/right/bottom) and the gutter between cells (x/y), all in px, plus confidence in [0,1]. Margin and spacing are zeros for a flush sheet. Pass the numbers straight back into sprite_slice (and every other cols/rows tool) as `margin`/`margin_x`/`margin_y` and `spacing`/`spacing_x`/`spacing_y` so frames are cut on the real cell boundaries.",
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
        grid: {
          cols: det.cols,
          rows: det.rows,
          margin: det.margin,
          spacing: det.spacing,
        },
        confidence: Number(det.confidence.toFixed(3)),
      });
    },
  );

  // ------- lint -------
  server.registerTool(
    "sprite_lint_sheet",
    {
      description:
        "Lint a sprite sheet and report what is wrong with it. Run this FIRST on any sheet you did not make yourself: it says whether the sheet is healthy, what grid it really has, and what problems it carries — alpha fringe from a sloppy chroma key, content bleeding across cell seams, jumping pivots, duplicate/empty/fully-opaque frames, non-power-of-two dimensions, palette noise. Every finding carries a stable rule id, a severity, the frame and cell it belongs to, and sheet-absolute pixel coordinates, so you can act on it without re-deriving anything. `ok` is true when nothing error-severity fired; `summary.rulesSkipped` lists rules whose preconditions the sheet did not meet, which is normal on healthy art, not a failure.",
      inputSchema: {
        input_path: z.string().describe("Absolute path to a PNG sprite or sheet"),
        ...SHEET_GRID_ARGS,
        disable_rules: z
          .array(z.string())
          .optional()
          .describe(`Rule ids to skip entirely. Valid ids: ${RULE_IDS.join(", ")}`),
        only_rules: z
          .array(z.string())
          .optional()
          .describe("Run only these rule ids; every other rule is disabled"),
        min_severity: z
          .enum(["error", "warning", "info"])
          .optional()
          .describe(
            "Drop findings below this severity from the list. `summary` still counts the whole run, so you can see what was filtered out.",
          ),
        options: z
          .record(z.string(), z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])))
          .optional()
          .describe(
            'Per-rule threshold overrides, keyed by rule id then option name, e.g. {"frame-bleed": {"minRunLength": 5}}. Unlisted options keep their defaults; an unknown option name, a value of the wrong type, or a severity outside error|warning|info comes back as an invalid_rule_option error rather than being ignored.',
          ),
      },
    },
    ({ input_path, disable_rules, only_rules, min_severity, options, ...gridArgs }) => {
      // Every rule id the caller named is validated up front, so a typo comes
      // back as a recoverable message listing the valid ids rather than a
      // silently ignored flag or an opaque throw.
      const named = [
        ...(disable_rules ?? []),
        ...(only_rules ?? []),
        ...Object.keys(options ?? {}),
      ];
      const unknown = [...new Set(named.filter((id) => !isRuleId(id)))];
      if (unknown.length > 0) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  error: "unknown_rule_id",
                  message: `Unknown rule id(s): ${unknown.join(", ")}. Valid rule ids are: ${RULE_IDS.join(", ")}.`,
                  unknownRules: unknown,
                  validRules: RULE_IDS,
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      // Option names and value types are checked too, against the same defaults
      // the CLI's `--set` validates against: an unknown name is otherwise
      // dropped silently, and a string where a threshold belongs makes every
      // comparison against it false, which inverts a gate instead of leaving it
      // alone. A mis-cased severity would also put a value outside the
      // documented Severity enum into the report and leave `ok` true.
      const badOptions: string[] = [];
      for (const [id, opts] of Object.entries(options ?? {})) {
        if (!isRuleId(id)) continue;
        for (const [option, value] of Object.entries(opts)) {
          const problem = validateRuleOption(id, option, value);
          if (problem) badOptions.push(problem);
        }
      }
      if (badOptions.length > 0) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  error: "invalid_rule_option",
                  message: `Invalid rule option(s): ${badOptions.join("; ")}.`,
                  problems: badOptions,
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      const rules: Record<string, Record<string, unknown>> = {};
      const patch = (id: string, fields: Record<string, unknown>) => {
        rules[id] = { ...rules[id], ...fields };
      };
      if (only_rules && only_rules.length > 0) {
        for (const id of RULE_IDS) {
          if (!only_rules.includes(id)) patch(id, { enabled: false });
        }
      }
      for (const id of disable_rules ?? []) patch(id, { enabled: false });
      for (const [id, opts] of Object.entries(options ?? {})) patch(id, opts);

      const image = loadPng(input_path);
      const report = lintSheet({
        source: input_path,
        image,
        cols: gridArgs.cols,
        rows: gridArgs.rows,
        padding: gridPaddingFromOpts({
          margin: gridArgs.margin,
          marginX: gridArgs.margin_x,
          marginY: gridArgs.margin_y,
          spacing: gridArgs.spacing,
          spacingX: gridArgs.spacing_x,
          spacingY: gridArgs.spacing_y,
        }),
        // The record is keyed by validated rule ids, which is exactly the
        // DeepPartial shape lintSheet merges — TypeScript just cannot see it.
        config: { rules } as DeepPartial<LintConfig>,
      });

      // Filtering trims the findings list only — `summary` keeps counting the
      // whole run, so an agent can still see how much was held back.
      const floor = min_severity ? SEVERITY_ORDER[min_severity] : null;
      const findings =
        floor === null
          ? report.findings
          : report.findings.filter((f) => SEVERITY_ORDER[f.severity] <= floor);

      return jsonResult({ ok: report.summary.errors === 0, ...report, findings });
    },
  );

  // ------- slice -------
  server.registerTool(
    "sprite_slice",
    {
      description:
        "Split a sprite sheet into one PNG per cell on disk. Returns the list of written paths, plus the grid geometry actually used. Handles sheets with an outer border or gutters between cells via `margin`/`spacing` — run sprite_detect_grid first and pass its numbers through, otherwise a padded sheet slices with a strip of the neighbouring sprite in every frame.",
      inputSchema: {
        input_path: z.string(),
        out_dir: z.string().describe("Directory to write frames into"),
        ...SHEET_GRID_ARGS,
        name_pattern: z
          .string()
          .default("frame_%02d.png")
          .describe("printf-style pattern, e.g. 'run_%03d.png'"),
      },
    },
    ({ input_path, out_dir, name_pattern, ...gridArgs }) => {
      const { frames, grid } = loadSheetFromArgs(input_path, gridArgs);
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

  // ------- remove_background -------
  server.registerTool(
    "sprite_remove_background",
    {
      description:
        "Chroma-key the background out of a sprite or every cell of a sheet. Samples the background colour from each frame's corners (or keys the explicit `color`) and knocks it out to transparency, optionally auto-cropping afterwards. Mode 'solid' replaces the background with a flat fill instead of transparency. Returns the colour that was keyed and how much of the image it removed, so you can tell whether the key took.",
      inputSchema: {
        input_path: z.string(),
        output_path: z.string(),
        ...SHEET_GRID_ARGS,
        mode: z
          .enum(["transparent", "solid"])
          .default("transparent")
          .describe("'transparent' keys the background out; 'solid' replaces it with a fill"),
        similarity: z
          .number()
          .min(0)
          .max(150)
          .default(30)
          .describe("Colour distance from the background that still counts as background"),
        softness: z
          .number()
          .min(0)
          .max(50)
          .default(10)
          .describe("Width of the feathered edge band"),
        spill: z
          .number()
          .min(0)
          .max(100)
          .default(20)
          .describe("Desaturate background colour bleeding into the edges"),
        choke: z.number().int().min(0).max(5).default(1).describe("Erode the mask by N pixels"),
        color: z
          .string()
          .regex(HEX_COLOR, "expected a hex colour like #00ff00")
          .optional()
          .describe(
            "Background colour to key out; omit to auto-detect it per frame. Ignored in 'solid' mode.",
          ),
        fill: z
          .string()
          .regex(HEX_COLOR, "expected a hex colour like #ffffff")
          .optional()
          .describe(
            "Flat fill colour for 'solid' mode; omit to blend the frame's own corner colours.",
          ),
        trim: z
          .boolean()
          .default(false)
          .describe("Auto-crop to the content bounds shared by every frame"),
        trim_padding: z
          .number()
          .int()
          .min(0)
          .default(0)
          .describe("Transparent pixels kept around the crop"),
      },
    },
    ({
      input_path,
      output_path,
      mode,
      similarity,
      softness,
      spill,
      choke,
      color,
      fill,
      trim,
      trim_padding,
      ...gridArgs
    }) => {
      const { image, frames, grid } = loadSheetFromArgs(input_path, gridArgs);
      const solid = mode === "solid";
      const cfg: ChromaCoreConfig = {
        mode: solid ? "chroma-solid" : "chroma-transparent",
        similarity,
        softness,
        spill,
        choke,
        solidColor: fill,
        // Matches the web app, which samples the corners unless told otherwise.
        autoDetermineFillColor: fill === undefined,
      };
      const explicit = color ? chromaHexToRgb(color) : null;

      // The core mutates in place, so every frame is copied first — a 1x1
      // "sheet" is the source image itself, which must stay untouched.
      const backgrounds: (Rgb | null)[] = [];
      let processed = frames.map((f) => {
        const out = new ImageData(f.width, f.height);
        out.data.set(f.data);
        if (solid) {
          applySolidFillToImageData(out, cfg);
          backgrounds.push(null);
          return out;
        }
        const target = explicit ?? detectBackgroundColor(out);
        applyChromaKeyToImageData(out, target, cfg);
        backgrounds.push(target);
        return out;
      });

      // One crop rect for the whole sheet: per-frame rects would produce
      // differently sized cells that no longer stitch back into a grid.
      let cropped: { x: number; y: number; width: number; height: number } | null = null;
      if (trim) {
        const rects = processed
          .map((p) => computeTrimRect(p))
          .filter((r): r is NonNullable<typeof r> => r !== null);
        if (rects.length > 0) {
          const fw = processed[0].width;
          const fh = processed[0].height;
          const minX = Math.min(...rects.map((r) => r.x));
          const minY = Math.min(...rects.map((r) => r.y));
          const maxX = Math.max(...rects.map((r) => r.x + r.w));
          const maxY = Math.max(...rects.map((r) => r.y + r.h));
          const x = Math.max(0, minX - trim_padding);
          const y = Math.max(0, minY - trim_padding);
          const w = Math.min(fw - x, maxX - minX + trim_padding * 2);
          const h = Math.min(fh - y, maxY - minY + trim_padding * 2);
          if (x !== 0 || y !== 0 || w !== fw || h !== fh) {
            processed = processed.map((p) => sliceRect(p, { x, y, w, h }));
          }
          cropped = { x, y, width: w, height: h };
        }
      }

      const out =
        processed.length === 1 ? processed[0] : stitchSheet(processed, grid.cols, grid.rows);
      mkdirSync(dirname(output_path), { recursive: true });
      savePng(out, output_path);

      let clear = 0;
      for (let i = 3; i < out.data.length; i += 4) if (out.data[i] === 0) clear++;
      const total = out.width * out.height;
      const keyed = backgrounds.filter((b): b is Rgb => b !== null).map(rgbToHex);

      return jsonResult({
        source: input_path,
        output_path,
        sourceWidth: image.width,
        sourceHeight: image.height,
        width: out.width,
        height: out.height,
        grid,
        frameCount: processed.length,
        frameWidth: processed[0]?.width ?? 0,
        frameHeight: processed[0]?.height ?? 0,
        backgroundColor: keyed[0] ?? null,
        backgroundColorSource: solid ? null : color ? "explicit" : "detected",
        distinctBackgroundColors: [...new Set(keyed)],
        transparentFraction: total > 0 ? Number((clear / total).toFixed(4)) : 0,
        trim: cropped,
        options: {
          mode,
          similarity,
          softness,
          spill,
          choke,
          color: color ?? null,
          fill: fill ?? null,
          trim,
          trim_padding,
        },
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
        ...SHEET_GRID_ARGS,
        alpha_threshold: z.number().int().min(0).max(254).default(10),
        simplify_tolerance: z.number().min(0).default(10),
        convex_hull: z.boolean().default(false),
      },
    },
    ({ input_path, alpha_threshold, simplify_tolerance, convex_hull, ...gridArgs }) => {
      const { image, frames, grid } = loadSheetFromArgs(input_path, gridArgs);
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
        sourceWidth: image.width,
        sourceHeight: image.height,
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
        ...SHEET_GRID_ARGS,
        preset: z.enum(PRESET_IDS as [string, ...string[]]).default("bottom-center"),
        x: z.number().int().optional().describe("Override X (pixels)"),
        y: z.number().int().optional().describe("Override Y (pixels)"),
      },
    },
    ({ input_path, preset, x, y, ...gridArgs }) => {
      const { image, frames, grid } = loadSheetFromArgs(input_path, gridArgs);
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
        sourceWidth: image.width,
        sourceHeight: image.height,
        frameWidth: frames[0]?.width ?? 0,
        frameHeight: frames[0]?.height ?? 0,
        grid,
        options: {
          preset,
          explicit: x !== undefined || y !== undefined ? { x, y } : null,
        },
        pivots,
      });
    },
  );

  // ------- nine_slice -------
  server.registerTool(
    "sprite_generate_nine_slice",
    {
      description:
        "Nine-slice (9-patch) insets plus the nine stretch regions for a sprite or every cell of a sheet. Setting `left`/`right`/`top`/`bottom` yourself is the real interface. Any side left out is filled in with a starting guess read off adjacent-line variance profiles: it holds up on panels with an obviously flat or repeated middle and falls apart on busy or gradient artwork, so check `confidence` and correct the numbers. `from_9patch` reads the insets off an Android .9.png marker border instead of guessing. Optionally also writes a .9.png (`ninepatch_output_path`) and a stretched preview PNG (`preview_output_path`), both built from the first frame.",
      inputSchema: {
        input_path: z.string(),
        ...SHEET_GRID_ARGS,
        left: z.number().int().min(0).optional().describe("Explicit left inset (pixels)"),
        right: z.number().int().min(0).optional().describe("Explicit right inset (pixels)"),
        top: z.number().int().min(0).optional().describe("Explicit top inset (pixels)"),
        bottom: z.number().int().min(0).optional().describe("Explicit bottom inset (pixels)"),
        alpha_threshold: z
          .number()
          .int()
          .min(0)
          .max(255)
          .default(DEFAULT_ALPHA_THRESHOLD)
          .describe("Pixels below this alpha count as equal to each other while guessing"),
        tolerance: z
          .number()
          .min(0)
          .max(1)
          .default(DEFAULT_TOLERANCE)
          .describe("Adjacent-line difference below which two lines count as the same"),
        min_middle: z
          .number()
          .int()
          .min(0)
          .default(DEFAULT_MIN_MIDDLE)
          .describe("Pixels the stretchable middle must keep on each axis"),
        from_9patch: z
          .boolean()
          .default(false)
          .describe("Read the insets off the input's Android .9.png marker border"),
        ninepatch_output_path: z
          .string()
          .optional()
          .describe("Write the first frame as a .9.png carrying the resolved insets"),
        preview_output_path: z
          .string()
          .optional()
          .describe("Write the first frame stretched to the preview size"),
        preview_width: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Defaults to 3x frame width"),
        preview_height: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Defaults to 3x frame height"),
      },
    },
    ({
      input_path,
      left,
      right,
      top,
      bottom,
      alpha_threshold,
      tolerance,
      min_middle,
      from_9patch,
      ninepatch_output_path,
      preview_output_path,
      preview_width,
      preview_height,
      ...gridArgs
    }) => {
      // A .9.png keeps its insets in a 1px marker border around the content,
      // so the border has to come off before the sheet is cut into cells.
      let border: NineSliceInsets | null = null;
      let borderPadding: NineSliceInsets | null = null;
      let sheet = loadPng(input_path);
      if (from_9patch) {
        const decoded = decodeNinePatch(sheet);
        border = decoded.insets;
        borderPadding = decoded.padding;
        sheet = decoded.content;
      }

      const { frames, grid } = gridFromImage(sheet, gridArgs);
      const nineSlice = nineSliceSection(frames, grid, {
        left,
        right,
        top,
        bottom,
        alphaThreshold: alpha_threshold,
        tolerance,
        minMiddle: min_middle,
        borderInsets: border,
      });

      const first = frames[0];
      const firstInsets = nineSlice[0]?.insets;
      let ninePatchPath: string | undefined;
      let previewPath: string | undefined;
      if (ninepatch_output_path || preview_output_path) {
        if (!first || !firstInsets) throw new Error("no frames to export");
        if (ninepatch_output_path) {
          mkdirSync(dirname(ninepatch_output_path), { recursive: true });
          savePng(encodeNinePatch(first, firstInsets, borderPadding), ninepatch_output_path);
          ninePatchPath = ninepatch_output_path;
        }
        if (preview_output_path) {
          // Same default as the CLI's --preview: 3x is big enough to see the
          // corners stay 1:1 while the middle stretches.
          const w = preview_width ?? first.width * 3;
          const h = preview_height ?? first.height * 3;
          mkdirSync(dirname(preview_output_path), { recursive: true });
          savePng(stretchNineSlice(first, firstInsets, w, h), preview_output_path);
          previewPath = preview_output_path;
        }
      }

      const explicit =
        left !== undefined || right !== undefined || top !== undefined || bottom !== undefined
          ? { left, right, top, bottom }
          : null;

      return jsonResult({
        source: input_path,
        frameWidth: first?.width ?? 0,
        frameHeight: first?.height ?? 0,
        grid,
        options: {
          auto: nineSlice.some((n) => n.detected),
          explicit,
          alphaThreshold: alpha_threshold,
          tolerance,
          minMiddle: min_middle,
          ...(from_9patch ? { ninePatch: true } : {}),
        },
        nineSlice,
        ...(ninePatchPath ? { ninePatchPath } : {}),
        ...(previewPath ? { previewPath } : {}),
      });
    },
  );

  // ------- tags -------
  server.registerTool(
    "sprite_generate_tags",
    {
      description:
        "Emit animation tag metadata — named, inclusive frame ranges with a direction and a frame rate — in sprite-tools' own JSON shape. Each tag plays at its own uniform fps; `frame_durations` optionally holds individual frames longer (key poses). This is not an Aseprite file: feed the result to sprite_export_engine to turn it into an actual Aseprite JSON sheet, a Godot SpriteFrames resource, a Unity .meta, or a Phaser/Pixi atlas.",
      inputSchema: {
        input_path: z.string(),
        ...SHEET_GRID_ARGS,
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
        frame_durations: FRAME_DURATIONS_SCHEMA,
      },
    },
    ({ input_path, tags, frame_durations, ...gridArgs }) => {
      const { image, frames, grid } = loadSheetFromArgs(input_path, gridArgs);
      const frameDurations = resolveFrameDurations(frame_durations, frames.length);
      return jsonResult({
        source: input_path,
        sourceWidth: image.width,
        sourceHeight: image.height,
        frameWidth: frames[0]?.width ?? 0,
        frameHeight: frames[0]?.height ?? 0,
        grid,
        frameCount: frames.length,
        ...(frameDurations ? { frameDurations } : {}),
        tags,
      });
    },
  );

  // ------- find_duplicates -------
  server.registerTool(
    "sprite_find_duplicates",
    {
      description:
        "Find duplicate and near-duplicate frames in a sprite sheet, optionally write the deduplicated sheet, and rewrite the animation tags that pointed at the removed frames. " +
        "Why this exists: extracting frames from video at a fixed FPS (10fps over a four-pose animation yields dozens of frames) and AI frame generation both produce long runs of identical frames. Nothing else in the pipeline notices, so sheets get packed, keyed and shipped mostly redundant. " +
        `THRESHOLD: ${MAE_THRESHOLD_DOC} The comparison is inclusive (distance <= threshold merges). ` +
        "ALPHA PARTICIPATES: all four RGBA channels are compared straight, with no premultiply and no alpha weighting, so an alpha difference adds to the distance like any other channel. At threshold 0 an alpha-only change is never a duplicate; at a higher threshold it merges once its distance is at or below the threshold. RGB under a fully transparent pixel is ignored (read as 0), so invisible colour never counts. Frames of different dimensions never match. " +
        "MATCHING: byte-identical frames always merge first (an exact hash pass confirmed by a real byte comparison), then, only when threshold > 0, each survivor is compared in source order against the representatives of the groups established so far and joins the first one within threshold. Comparing against representatives only prevents transitive chaining: if a~b and b~c but a!~c, a and c stay apart. Frames are never reordered, and the kept frame of a group is always its lowest index. " +
        "TAGS: removing frames RENUMBERS every frame after them, so an animation tag — a named frame RANGE — is silently invalidated unless it is rewritten through the remap. Pass tags_path and the rewrite is done for you. A rewritten range can legitimately become non-contiguous (a frame inside it deduped against an identical frame outside it, or two non-adjacent frames inside it merging with each other); when that happens the tag's `frames` array is the authoritative playback order, from/to are only min/max and are MEANINGLESS, `contiguous` is false, and a warning names the tag. Never feed from/to to an exporter without checking `contiguous` first. Pass respect_tags:true to stop a range from losing frames to a different animation — that removes the cross-tag cause of non-contiguity, but a tag whose own frames 2 and 4 are duplicates still comes back non-contiguous. " +
        "Call it with no output_path first to survey a sheet: the response reports every duplicate group with its per-frame distances, which is enough to decide whether deduping is worth doing at all.",
      inputSchema: {
        input_path: z.string().describe("Absolute path to the sprite sheet PNG"),
        ...SHEET_GRID_ARGS,
        threshold: z
          .number()
          .min(0)
          .default(0)
          .describe(
            `${MAE_THRESHOLD_DOC} The comparison is inclusive (distance <= threshold merges).`,
          ),
        output_path: z
          .string()
          .optional()
          .describe(
            "Where to write the deduplicated sheet PNG. Omit to only report what would be removed.",
          ),
        sheet_cols: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "Columns in the written sheet; rows follow from the surviving frame count. Defaults to the input's column count. Capped at the number of frames kept (the CLI instead keeps --sheet-cols and pads).",
          ),
        tags_path: z
          .string()
          .optional()
          .describe(
            "Absolute path to a tags JSON to rewrite — either a { tags: [...], frameDurations?: [...] } document (as emitted by sprite_generate_tags) or a bare array of { name, from, to, direction?, fps? }. from/to must be integers. A frameDurations array is carried into tags_output_path: each kept frame takes the first explicit hold in its duplicate group.",
          ),
        tags_output_path: z
          .string()
          .optional()
          .describe(
            "Where to write the rewritten tags JSON. Requires tags_path. Omit to get the rewritten tags in the response only.",
          ),
        respect_tags: z
          .boolean()
          .default(false)
          .describe(
            "Confine merging to within each tag, so no range can lose a frame to an identical frame in another animation. Requires tags_path. This removes the cross-tag cause of non-contiguous ranges, but does not guarantee contiguity: two non-adjacent frames inside the same tag can still merge with each other. Frames covered by no tag form one partition of their own; where tags overlap, the first tag listed wins.",
          ),
      },
    },
    ({
      input_path,
      threshold,
      output_path,
      sheet_cols,
      tags_path,
      tags_output_path,
      respect_tags,
      ...gridArgs
    }) => {
      if (tags_output_path && !tags_path) {
        throw new Error("tags_output_path requires tags_path — there are no tags to rewrite");
      }
      if (respect_tags && !tags_path) {
        throw new Error(
          "respect_tags requires tags_path — tag ranges are what the partitions are built from",
        );
      }

      const { image, frames, grid } = loadSheetFromArgs(input_path, gridArgs);
      const doc = tags_path ? readTagsFile(tags_path) : null;
      const tags = doc ? doc.tags : null;
      const warnings: string[] = [];

      // respect_tags is a caller-side concern: the core only knows partition
      // ids, so the tag ranges get flattened into one id per frame here.
      let partitions: number[] | undefined;
      if (respect_tags && tags) {
        const built = buildTagPartitions(tags, frames.length);
        partitions = built.partitions;
        warnings.push(...built.warnings.map((w) => `respect_tags: ${w}`));
      }

      const result = findDuplicateFrames(frames, { threshold, partitions });

      let written: {
        path: string;
        width: number;
        height: number;
        cols: number;
        rows: number;
      } | null = null;
      if (output_path) {
        const kept = applyDedupe(frames, result);
        if (kept.length === 0) {
          throw new Error(
            `nothing to write: the grid ${grid.cols}x${grid.rows} yielded no frames for ${input_path}`,
          );
        }
        // Never widen the sheet past the surviving frame count, and let the row
        // count follow from it — a dedupe that keeps 5 of 12 frames should not
        // emit a mostly empty 4x3 grid.
        const outCols = Math.max(1, Math.min(sheet_cols ?? grid.cols, kept.length));
        const outRows = Math.ceil(kept.length / outCols);
        const sheet =
          kept.length === 1 && outCols === 1 && outRows === 1
            ? kept[0]
            : stitchSheet(kept, outCols, outRows);
        mkdirSync(dirname(output_path), { recursive: true });
        savePng(sheet, output_path);
        written = {
          path: output_path,
          width: sheet.width,
          height: sheet.height,
          cols: outCols,
          rows: outRows,
        };
      }

      const remapped = tags ? remapTags(tags, result) : null;
      if (remapped) {
        warnings.push(...remapped.warnings);
        if (tags_output_path && !output_path) {
          warnings.push(
            "tags were renumbered for the deduplicated frame order, but no deduplicated sheet was written — re-run with output_path, or the rewritten tags will not match any sheet on disk",
          );
        }
      }
      if (result.removedCount > 0 && !output_path && !tags_path) {
        warnings.push(
          `${result.removedCount} duplicate frame(s) found but nothing was written — pass output_path to write the deduplicated sheet, and tags_path so the tag ranges get renumbered with it`,
        );
      }

      if (remapped && tags_output_path) {
        const frameDurations = remapFrameDurations(doc?.frameDurations, result);
        const tagsDoc = {
          source: output_path ?? input_path,
          frameWidth: frames[0]?.width ?? 0,
          frameHeight: frames[0]?.height ?? 0,
          grid: written
            ? { cols: written.cols, rows: written.rows, detected: false }
            : { cols: grid.cols, rows: grid.rows, detected: grid.detected },
          frameCount: result.uniqueCount,
          tags: remapped.tags,
          ...(frameDurations ? { frameDurations } : {}),
          warnings,
        };
        mkdirSync(dirname(tags_output_path), { recursive: true });
        writeFileSync(tags_output_path, `${JSON.stringify(tagsDoc, null, 2)}\n`);
      }

      return jsonResult({
        source: input_path,
        output_path: output_path ?? null,
        tags_source: tags_path ?? null,
        tags_output_path: tags_output_path ?? null,
        sourceWidth: image.width,
        sourceHeight: image.height,
        grid,
        frameWidth: frames[0]?.width ?? 0,
        frameHeight: frames[0]?.height ?? 0,
        method: result.method,
        threshold: result.threshold,
        frameCount: result.frameCount,
        uniqueCount: result.uniqueCount,
        removedCount: result.removedCount,
        // distances[i] is the MAE of duplicates[i] against keep; 0 means
        // byte-identical. Significant digits rather than fixed decimals, so a
        // genuinely tiny distance never rounds down to a bare 0 and reads as
        // "identical" to whoever is looking at this.
        groups: result.groups.map((g) => ({
          keep: g.keep,
          duplicates: g.duplicates,
          distances: g.distances.map((d) => (d === 0 ? 0 : Number(d.toPrecision(4)))),
        })),
        keptIndices: result.keptIndices,
        // remap[oldIndex] = new index of the frame that now stands in for it.
        remap: result.remap,
        output: written,
        tags: remapped ? remapped.tags : null,
        warnings,
        options: {
          threshold,
          respect_tags,
          sheet_cols: sheet_cols ?? null,
          partitioned: partitions !== undefined,
        },
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
        ...SHEET_GRID_ARGS,
        colors: z.number().int().min(1).max(256).default(8),
      },
    },
    ({ input_path, colors, ...gridArgs }) => {
      const { frames, grid } = loadSheetFromArgs(input_path, gridArgs);
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
        ...SHEET_GRID_ARGS,
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
    ({ input_path, output_path, colors, swaps, ...gridArgs }) => {
      const { frames, grid } = loadSheetFromArgs(input_path, gridArgs);
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
        recolored.length === 1 ? recolored[0] : stitchSheet(recolored, grid.cols, grid.rows);
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

  // ------- palette_ramps -------
  server.registerTool(
    "sprite_detect_ramps",
    {
      description:
        "Group a sprite's extracted palette into shading ramps — the light-to-dark runs of shades an artist painted for one material (skin, cloth, metal) — by clustering hue in the perceptual OKLCH space, with all near-greys in one achromatic ramp. Run this before sprite_palette_variants to see what is recolourable: every hex it reports for a ramp is a valid `ramps[].base` handle for re-tinting that whole ramp.",
      inputSchema: {
        input_path: z.string(),
        ...SHEET_GRID_ARGS,
        colors: z
          .number()
          .int()
          .min(1)
          .max(256)
          .default(8)
          .describe("Palette size to quantize to before grouping"),
        hue_tolerance: z
          .number()
          .min(0)
          .max(180)
          .default(DEFAULT_HUE_TOLERANCE)
          .describe(
            "Degrees of hue slack for joining a ramp; raise it to merge neighbouring hues into one ramp, lower it to split them",
          ),
      },
    },
    ({ input_path, colors, hue_tolerance, ...gridArgs }) => {
      const { frames, grid } = loadSheetFromArgs(input_path, gridArgs);
      const palette = extractPalette(mergeFramePixels(frames), colors);
      const ramps = detectRamps(palette, { hueTolerance: hue_tolerance });
      return jsonResult({
        source: input_path,
        frameWidth: frames[0]?.width ?? 0,
        frameHeight: frames[0]?.height ?? 0,
        grid,
        options: { colors, rampTolerance: hue_tolerance },
        palette: palette.map(rgbToHex),
        ramps: describeRamps(ramps),
      });
    },
  );

  // ------- palette_variants -------
  server.registerTool(
    "sprite_palette_variants",
    {
      description:
        "Write a whole family of recoloured copies of a sprite or sheet — team colours, enemy tints, seasonal skins — as <name>_<slug>.png in output_dir, plus a manifest describing every palette, ramp and swap used. A variant is a recipe: a whole-palette `hue_shift`, per-ramp re-tints that move an entire shading ramp at once (preserving its lightness steps and the artist's shadow/highlight hue drift), and/or literal per-colour `swaps`. Reach for sprite_palette_swap instead when you want a single output from a handful of hand-picked colour substitutions.",
      inputSchema: {
        input_path: z.string(),
        output_dir: z
          .string()
          .describe("Directory to write the variant PNGs into; created if missing"),
        ...SHEET_GRID_ARGS,
        colors: z
          .number()
          .int()
          .min(1)
          .max(256)
          .default(8)
          .describe("Palette size to quantize to; the same palette is shared by every frame"),
        hue_tolerance: z
          .number()
          .min(0)
          .max(180)
          .default(DEFAULT_HUE_TOLERANCE)
          .describe("Degrees of hue slack for ramp detection, as in sprite_detect_ramps"),
        name: z
          .string()
          .optional()
          .describe("Filename base for the variants; defaults to the input file's basename"),
        manifest_path: z
          .string()
          .optional()
          .describe("Write the manifest JSON here as well as returning it"),
        ...VARIANT_SOURCE_SHAPE,
        hue_step: z
          .number()
          .optional()
          .describe("Degrees between hue_variants entries; defaults to an even 360/N spacing"),
      },
    },
    ({
      input_path,
      output_dir,
      colors,
      hue_tolerance,
      name,
      manifest_path,
      variants,
      hue_variants,
      hue_step,
      ...gridArgs
    }) => {
      const source = VARIANT_SOURCE.safeParse({ variants, hue_variants });
      if (!source.success) {
        throw new Error(source.error.issues[0]?.message ?? "invalid variant selection");
      }

      // This surface speaks snake_case with arrays of pairs; the shared variant
      // format is camelCase with a swap map. Convert at the boundary, then run
      // the result through the same validator the CLI's --variants file uses, so
      // bad hex and duplicate names fail identically on both surfaces.
      const specs = variants
        ? parseVariantSet({
            version: VARIANT_SET_VERSION,
            variants: variants.map((v) => ({
              name: v.name,
              ...(v.swaps ? { swaps: Object.fromEntries(v.swaps.map((s) => [s.from, s.to])) } : {}),
              ...(v.ramps ? { ramps: v.ramps } : {}),
              ...(v.hue_shift !== undefined ? { hueShift: v.hue_shift } : {}),
            })),
          }).variants
        : hueShiftVariants(hue_variants ?? 0, { stepDeg: hue_step });

      const { frames, grid } = loadSheetFromArgs(input_path, gridArgs);
      const palette = extractPalette(mergeFramePixels(frames), colors);
      const ramps = detectRamps(palette, { hueTolerance: hue_tolerance });
      const base = name ?? basename(input_path).replace(/\.[^.]+$/, "");

      mkdirSync(output_dir, { recursive: true });
      const files: string[] = [];
      const entries: VariantManifestEntry[] = [];
      for (const spec of specs) {
        const swaps = resolveVariant(spec, palette, ramps);
        const recolored = frames.map((f) => applyPaletteSwap(f, palette, swaps));
        const out =
          recolored.length === 1 ? recolored[0] : stitchSheet(recolored, grid.cols, grid.rows);
        const file = variantFileName(base, spec.name);
        // Absolute, so an agent can feed the path straight into the next tool.
        const path = resolve(output_dir, file);
        savePng(out, path);
        files.push(path);
        entries.push({
          name: spec.name,
          slug: slugifyVariantName(spec.name),
          file,
          ...(spec.hueShift !== undefined ? { hueShift: spec.hueShift } : {}),
          swaps: swaps.map((s) => ({ from: rgbToHex(s.from), to: rgbToHex(s.to) })),
        });
      }

      const manifest: VariantManifest = {
        version: VARIANT_MANIFEST_VERSION,
        source: input_path,
        frameWidth: frames[0]?.width ?? 0,
        frameHeight: frames[0]?.height ?? 0,
        grid,
        options: { colors, mode: variants ? "defs" : "hue", rampTolerance: hue_tolerance },
        palette: palette.map(rgbToHex),
        ramps: describeRamps(ramps),
        variants: entries,
      };
      if (manifest_path) {
        mkdirSync(dirname(manifest_path), { recursive: true });
        writeFileSync(manifest_path, `${JSON.stringify(manifest, null, 2)}\n`);
      }
      return jsonResult({
        ...manifest,
        files,
        ...(manifest_path ? { manifest_path } : {}),
      });
    },
  );

  // ------- pixelate -------
  server.registerTool(
    "sprite_pixelate",
    {
      description:
        "Downscale a sprite into pixel-art form with optional color quantization, dither, and preset palettes (gameboy, pico8, nes, cga, mono). " +
        "Two independent size controls, do not confuse them: `upscale` (default true) only restores the pixelated result to the ORIGINAL image size with blocky nearest-neighbour pixels, so the output is the same dimensions as the input. " +
        "`upscale_factor` (default 1 = off) instead MAGNIFIES the pixelated result by an explicit integer factor using `upscale_algo`, and replaces that restore-to-source-size step entirely — use it to make a sprite genuinely larger than the source.",
      inputSchema: {
        input_path: z.string(),
        output_path: z.string(),
        ...SHEET_GRID_ARGS,
        pixel_size: z.number().int().min(1).max(64).default(4),
        colors: z.number().int().min(0).max(256).default(16),
        palette: z.enum(PALETTES.map((p) => p.id) as [string, ...string[]]).default("none"),
        dither: z.boolean().default(false),
        upscale: z
          .boolean()
          .default(true)
          .describe("Scale back up to source size with blocky pixels"),
        upscale_algo: z
          .enum(UPSCALE_ALGO_IDS)
          .default("nearest")
          .describe(
            `Filter used when upscale_factor > 1; ignored otherwise. All of them only copy existing source pixels, so no new colors are invented and transparency is preserved. ${UPSCALE_ALGO_HELP}`,
          ),
        upscale_factor: z
          .number()
          .int()
          .min(1)
          .max(9)
          .default(1)
          .describe(
            "Explicit magnification applied after pixelation, e.g. 4 = four times as wide and tall as the pixelated frame. 1 (default) disables it and leaves the `upscale` behavior alone. Any value > 1 overrides `upscale`. Factors that are not a whole power of the algorithm's native step (2 for scale2x/eagle/xbr, 3 for scale3x) finish with a nearest-neighbour pass, so the pure ones are 2/4/8 for the 2x filters and 3/9 for scale3x — 9 is the ceiling here for that reason.",
          ),
      },
    },
    ({
      input_path,
      output_path,
      pixel_size,
      colors,
      palette,
      dither,
      upscale,
      upscale_algo,
      upscale_factor,
      ...gridArgs
    }) => {
      const { frames, grid } = loadSheetFromArgs(input_path, gridArgs);
      const preset = paletteById(palette);
      const paletteRgb = preset.colors.length > 0 ? preset.colors.map(hexToRgb) : undefined;

      const processed = frames.map((f) => {
        const small = pixelate(f, {
          pixelSize: pixel_size,
          colorCount: colors,
          palette: paletteRgb,
          dither: dither ? "floyd-steinberg" : "none",
          alphaThreshold: 0,
        });
        // An explicit magnification replaces the implicit restore-to-source-size
        // upscale; factor 1 leaves the original behavior untouched.
        if (upscale_factor > 1) {
          return upscalePixels(small, {
            algorithm: upscale_algo as UpscaleAlgorithm,
            scale: upscale_factor,
          });
        }
        if (!upscale) return small;
        const scale = Math.max(1, Math.round(f.width / small.width));
        return upscaleNearestBy(small, scale);
      });

      const out =
        processed.length === 1 ? processed[0] : stitchSheet(processed, grid.cols, grid.rows);
      mkdirSync(dirname(output_path), { recursive: true });
      savePng(out, output_path);
      return jsonResult({
        source: input_path,
        output_path,
        grid,
        width: out.width,
        height: out.height,
        frameWidth: processed[0]?.width ?? 0,
        frameHeight: processed[0]?.height ?? 0,
        options: {
          pixel_size,
          colors,
          palette,
          dither,
          upscale,
          upscale_algo,
          upscale_factor,
        },
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
        ...SHEET_GRID_ARGS,
        source: z.enum(["alpha", "luminance", "mixed"]).default("alpha"),
        strength: z.number().default(1),
        mix: z.number().min(0).max(1).default(0.5),
        flip_y: z.boolean().default(false),
        blur: z.number().int().min(0).max(16).default(0),
      },
    },
    ({ input_path, output_path, source, strength, mix, flip_y, blur, ...gridArgs }) => {
      const { frames, grid } = loadSheetFromArgs(input_path, gridArgs);
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
        processed.length === 1 ? processed[0] : stitchSheet(processed, grid.cols, grid.rows);
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

  // ------- outline -------
  server.registerTool(
    "sprite_add_outline",
    {
      description:
        "Add a pixel-exact outer or inner outline to a sprite or every cell of a sheet. 'outer' grows a band of `width` pixels around the silhouette and composites the sprite on top, so anti-aliased edges blend over it instead of being cut; 'inner' recolors the band just inside the edge and never changes the size. Connectivity 4 gives mitred corners, 8 gives square ones. Every interior hole and disconnected island is outlined, not just the outer contour.",
      inputSchema: {
        input_path: z.string(),
        output_path: z.string(),
        ...SHEET_GRID_ARGS,
        style: z
          .enum(["outer", "inner"])
          .default("outer")
          .describe("'outer' draws around the silhouette; 'inner' draws inside it"),
        width: z.number().int().min(0).max(64).default(1).describe("Band thickness in pixels"),
        color: z.string().regex(HEX_COLOR, "expected a hex colour like #000000").default("#000000"),
        opacity: z.number().min(0).max(1).default(1),
        connectivity: z
          .union([z.literal(4), z.literal(8)])
          .default(8)
          .describe("4 = Manhattan growth (mitred corners), 8 = Chebyshev (square corners)"),
        alpha_threshold: z
          .number()
          .int()
          .min(0)
          .max(255)
          .default(8)
          .describe("Alpha above which a pixel counts as sprite; raise it to skip soft edges"),
        overflow: z
          .enum(["expand", "clip"])
          .default("expand")
          .describe("'expand' grows the canvas so nothing is cropped; 'clip' keeps the cell size"),
      },
    },
    ({
      input_path,
      output_path,
      style,
      width,
      color,
      opacity,
      connectivity,
      alpha_threshold,
      overflow,
      ...gridArgs
    }) => {
      const { frames, grid } = loadSheetFromArgs(input_path, gridArgs);
      const cfg: OutlineFxConfig = {
        outline: {
          style,
          width,
          color,
          opacity,
          connectivity: connectivity as Connectivity,
          alphaThreshold: alpha_threshold,
        },
        overflow,
      };
      // One margin for the whole sheet: per-frame margins would produce
      // differently sized cells that no longer stitch back into a grid.
      const shared = requiredMargin(cfg);
      const results = frames.map((f) => applyOutlineFx(f, { ...cfg, margin: shared }));
      const processed = results.map(fxToImageData);

      const out =
        processed.length === 1 ? processed[0] : stitchSheet(processed, grid.cols, grid.rows);
      mkdirSync(dirname(output_path), { recursive: true });
      savePng(out, output_path);
      return jsonResult({
        source: input_path,
        output_path,
        grid,
        output_width: out.width,
        output_height: out.height,
        margin: results[0]?.margin ?? ZERO_FX_MARGIN,
        options: { style, width, color, opacity, connectivity, alpha_threshold, overflow },
      });
    },
  );

  // ------- shadow -------
  server.registerTool(
    "sprite_add_shadow",
    {
      description:
        "Drop a shadow behind a sprite or every cell of a sheet. The silhouette is translated by (offset_x, offset_y), box-blurred by `blur`, tinted and composited beneath the sprite. Positive offsets move right and down.",
      inputSchema: {
        input_path: z.string(),
        output_path: z.string(),
        ...SHEET_GRID_ARGS,
        offset_x: z.number().int().min(-256).max(256).default(2),
        offset_y: z.number().int().min(-256).max(256).default(2),
        color: z.string().regex(HEX_COLOR, "expected a hex colour like #000000").default("#000000"),
        opacity: z.number().min(0).max(1).default(0.5),
        blur: z
          .number()
          .int()
          .min(0)
          .max(64)
          .default(0)
          .describe("Blur radius in pixels; 0 = hard"),
        alpha_threshold: z
          .number()
          .int()
          .min(0)
          .max(255)
          .default(8)
          .describe("Alpha above which a pixel counts as sprite"),
        overflow: z
          .enum(["expand", "clip"])
          .default("expand")
          .describe("'expand' grows the canvas so nothing is cropped; 'clip' keeps the cell size"),
      },
    },
    ({
      input_path,
      output_path,
      offset_x,
      offset_y,
      color,
      opacity,
      blur,
      alpha_threshold,
      overflow,
      ...gridArgs
    }) => {
      const { frames, grid } = loadSheetFromArgs(input_path, gridArgs);
      const cfg: OutlineFxConfig = {
        shadow: {
          offsetX: offset_x,
          offsetY: offset_y,
          color,
          opacity,
          blur,
          alphaThreshold: alpha_threshold,
        },
        overflow,
      };
      // Same shared margin as the outline tool, for the same reason.
      const shared = requiredMargin(cfg);
      const results = frames.map((f) => applyOutlineFx(f, { ...cfg, margin: shared }));
      const processed = results.map(fxToImageData);

      const out =
        processed.length === 1 ? processed[0] : stitchSheet(processed, grid.cols, grid.rows);
      mkdirSync(dirname(output_path), { recursive: true });
      savePng(out, output_path);
      return jsonResult({
        source: input_path,
        output_path,
        grid,
        output_width: out.width,
        output_height: out.height,
        margin: results[0]?.margin ?? ZERO_FX_MARGIN,
        options: { offset_x, offset_y, color, opacity, blur, alpha_threshold, overflow },
      });
    },
  );

  // ------- atlas -------
  server.registerTool(
    "sprite_pack_atlas",
    {
      description:
        "Pack multiple sprite PNGs into a single atlas PNG + TexturePacker-style JSON manifest, with edge extrusion into the padding gutter to avoid bilinear/mipmap halos.",
      inputSchema: {
        input_paths: z.array(z.string()).min(1),
        output_path: z.string(),
        json_path: z.string(),
        padding: z.number().int().min(0).default(2),
        extrude: z
          .number()
          .int()
          .min(0)
          .default(1)
          .describe("Repeat edge pixels N px into the padding gutter; clamped to padding"),
        power_of_two: z.boolean().default(false),
        trim: z.boolean().default(true),
      },
    },
    ({ input_paths, output_path, json_path, padding, extrude, power_of_two, trim }) => {
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
        | {
            sourceWidth: number;
            sourceHeight: number;
            offsetX: number;
            offsetY: number;
          }
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
        padding,
        powerOfTwo: power_of_two,
      });
      const out = new ImageData(atlas.width, atlas.height);
      for (const f of atlas.frames) {
        const s = sprites.find((x) => x.id === f.id);
        if (!s) continue;
        blit(s.content, out, f.x, f.y);
      }
      const bleed = effectiveExtrude(extrude, padding);
      if (bleed > 0) extrudeFrames(out, atlas.frames, bleed);
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
      writeFileSync(json_path, `${JSON.stringify(manifest, null, 2)}\n`);
      return jsonResult({
        atlas_path: output_path,
        manifest_path: json_path,
        extrude: bleed,
        ...manifest,
      });
    },
  );

  // ------- meta -------
  server.registerTool(
    "sprite_generate_meta",
    {
      description:
        "One-shot: collision + pivot + nine-slice + tags in a single merged JSON. Pass a config object for each section you want — `{}` takes that section's defaults — and omit a section to skip it. The nine-slice section takes explicit insets and guesses any side you leave out — see sprite_generate_nine_slice for what that guess is worth, and use that tool for .9.png input or PNG output. `frame_durations` optionally holds individual frames longer than their tag's uniform fps; omit it for uniform timing.",
      inputSchema: {
        input_path: z.string(),
        ...SHEET_GRID_ARGS,
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
        nine_slice: z
          .object({
            left: z.number().int().min(0).optional(),
            right: z.number().int().min(0).optional(),
            top: z.number().int().min(0).optional(),
            bottom: z.number().int().min(0).optional(),
            alpha_threshold: z.number().int().min(0).max(255).default(DEFAULT_ALPHA_THRESHOLD),
            tolerance: z.number().min(0).max(1).default(DEFAULT_TOLERANCE),
            min_middle: z.number().int().min(0).default(DEFAULT_MIN_MIDDLE),
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
        frame_durations: FRAME_DURATIONS_SCHEMA,
      },
    },
    ({ input_path, collision, pivot, nine_slice, tags, frame_durations, ...gridArgs }) => {
      const { image, frames, grid } = loadSheetFromArgs(input_path, gridArgs);
      const out: Record<string, unknown> = {
        source: input_path,
        sourceWidth: image.width,
        sourceHeight: image.height,
        frameWidth: frames[0]?.width ?? 0,
        frameHeight: frames[0]?.height ?? 0,
        grid,
        frameCount: frames.length,
      };
      const frameDurations = resolveFrameDurations(frame_durations, frames.length);
      if (frameDurations) out.frameDurations = frameDurations;
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
      if (nine_slice) {
        out.nineSlice = nineSliceSection(frames, grid, {
          left: nine_slice.left,
          right: nine_slice.right,
          top: nine_slice.top,
          bottom: nine_slice.bottom,
          alphaThreshold: nine_slice.alpha_threshold,
          tolerance: nine_slice.tolerance,
          minMiddle: nine_slice.min_middle,
        });
      }
      if (tags && tags.length > 0) {
        out.tags = tags;
      }
      return jsonResult(out);
    },
  );

  // ------- export_engine -------
  server.registerTool(
    "sprite_export_engine",
    {
      description:
        "Turn sprite-tools metadata into a file a game engine can import directly: a Godot SpriteFrames/AtlasTexture `.tres`, a Unity `<texture>.png.meta` with sliced sprite rects, an Aseprite-shaped JSON sheet, or a Phaser/PixiJS texture atlas. This closes the chain image -> sprite_generate_collision + sprite_generate_pivot + sprite_generate_tags (or sprite_generate_meta in one pass, or sprite_pack_atlas for packed rects) -> engine file. Reach for it whenever the goal is a sheet usable *in an engine* rather than raw JSON. Supply the metadata one of two ways: `input_path` (a JSON file on disk) or `metadata` (the same document inline) — exactly one, and inline is the fast path when you already hold the JSON from a previous call. The document may be a single command's output, several merged with `jq -s add`, a `meta` result, an atlas manifest, or a header+manifest hybrid; collision polygons, pivots and tags all attach by frame index and missing sections are simply skipped. With `output_path` the file is written and a summary returned; without it the exact generated text comes back inline.",
      inputSchema: {
        input_path: z
          .string()
          .optional()
          .describe(
            "Absolute path to a sprite-tools metadata JSON file. Mutually exclusive with `metadata`.",
          ),
        metadata: z
          .record(z.unknown())
          .optional()
          .describe(
            "The metadata document passed inline, so JSON already in hand needs no temp file. Mutually exclusive with `input_path`.",
          ),
        format: z
          .enum(["godot", "unity", "aseprite", "phaser"])
          .describe("Target engine/format of the generated file"),
        variant: z
          .enum(["spriteframes", "atlastextures", "meta", "hash", "array"])
          .optional()
          .describe(
            "Per-format flavour. godot: 'spriteframes' (default — one SpriteFrames resource) or 'atlastextures' (one AtlasTexture .tres per frame). unity: 'meta' (default, the only one). aseprite/phaser: 'hash' (default — frames keyed by name) or 'array'.",
          ),
        texture: z
          .string()
          .optional()
          .describe(
            "Override the spritesheet filename recorded in the output, e.g. 'hero.png'. The metadata usually only carries the source path.",
          ),
        name_prefix: z.string().optional().describe("Override the stem used to name frames"),
        fps: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Frame rate for frames no tag covers, which sets their duration. Default 10."),
        output_path: z
          .string()
          .optional()
          .describe(
            "Where to write. A file path for every single-file variant; a DIRECTORY for godot 'atlastextures', which emits one .tres per frame. Omit to get the content back inline.",
          ),
        godot: z
          .object({
            texture_path: z
              .string()
              .optional()
              .describe(
                "`res://` path of the PNG inside the Godot project. Default `res://<texture>`.",
              ),
            loop: z.boolean().optional().describe("Animation loop flag. Default true."),
            loop_mode: z
              .enum(["bool", "int"])
              .optional()
              .describe(
                "'bool' (default) works on every Godot 4.x; 'int' uses the 4.7 LoopMode enum.",
              ),
            pingpong: z
              .enum(["bake", "native"])
              .optional()
              .describe(
                "'bake' (default) expands a pingpong tag into an explicit frame list; 'native' needs loop_mode 'int'.",
              ),
            default_animation_name: z
              .string()
              .optional()
              .describe("Name of the fallback animation used when the document has no tags."),
            default_alias: z
              .boolean()
              .optional()
              .describe(
                "Also emit the first animation as 'default', which is what AnimatedSprite2D plays out of the box.",
              ),
            load_steps: z.boolean().optional().describe("Emit `load_steps=` on the header."),
          })
          .optional()
          .describe("Godot-only options"),
        unity: z
          .object({
            pixels_per_unit: z
              .number()
              .positive()
              .optional()
              .describe(
                "Default: the first frame's untrimmed height, so one sprite spans one world unit.",
              ),
            filter_mode: z
              .union([z.literal(0), z.literal(1), z.literal(2)])
              .optional()
              .describe("0 Point (default, pixel art), 1 Bilinear, 2 Trilinear"),
            max_texture_size: z.number().int().positive().optional(),
            serialized_version: z
              .union([z.literal(12), z.literal(13)])
              .optional()
              .describe("13 = Unity 6 (default), 12 = 2022.3/2023.x"),
            asset_path: z
              .string()
              .optional()
              .describe(
                "Project-relative path of the PNG, e.g. 'Assets/Art/hero.png'. Seeds the guid and every sprite id — pass the full path so two same-named sheets cannot collide.",
              ),
            guid: z
              .string()
              .optional()
              .describe(
                "Reuse the guid of an existing .meta. Overwriting a .meta with a fresh guid detaches every reference in the project, so read the incumbent `guid:` line first.",
              ),
            sprite_mesh_type: z
              .union([z.literal(0), z.literal(1)])
              .optional()
              .describe("0 FullRect (default), 1 Tight"),
            generate_fallback_physics_shape: z.boolean().optional(),
            physics_shape: z
              .boolean()
              .optional()
              .describe("Emit collision polygons as per-sprite physicsShape. Default true."),
          })
          .optional()
          .describe("Unity-only options"),
        aseprite: z
          .object({
            frame_names: z
              .enum(["index", "aseprite", "normalized"])
              .optional()
              .describe(
                "'index' (default) is bare '0','1',… — the only naming Phaser's createFromAseprite resolves. 'aseprite' reproduces Aseprite's own 'hero 0.aseprite'.",
              ),
            pivots: z
              .enum(["omit", "slices"])
              .optional()
              .describe(
                "The format has no per-frame pivot slot; 'slices' carries them in meta.slices instead. Default 'omit'.",
              ),
            pivot_slice_name: z.string().optional(),
            app: z.string().optional().describe("meta.app provenance string"),
            version: z.string().optional().describe("meta.version provenance string"),
            image: z.string().optional().describe("meta.image; always reduced to a basename"),
            pixel_format: z
              .enum(["RGBA8888", "I8"])
              .optional()
              .describe("meta.format. Default 'RGBA8888'; 'I8' for indexed/grayscale sheets."),
          })
          .optional()
          .describe("Aseprite-only options"),
        phaser: z
          .object({
            frame_names: z
              .enum(["keep", "index"])
              .optional()
              .describe(
                "'keep' (default) uses the resolved frame names; 'index' renames to '0','1',… for createFromAseprite.",
              ),
            image: z.string().optional().describe("meta.image; always reduced to a basename"),
            pixel_format: z.string().optional().describe("meta.format. Default 'RGBA8888'."),
            scale: z
              .union([z.string(), z.number()])
              .optional()
              .describe("meta.scale. Default the string '1', which is what Aseprite hardcodes."),
            app: z.string().optional().describe("meta.app provenance string"),
            version: z.string().optional().describe("meta.version provenance string"),
            frame_tags: z.boolean().optional().describe("Emit meta.frameTags. Default true."),
            animations: z
              .boolean()
              .optional()
              .describe("Emit the top-level Pixi `animations` map. Default true."),
            anchors: z
              .boolean()
              .optional()
              .describe("Emit a normalized per-frame anchor for pivoted frames. Default true."),
            related_multi_packs: z
              .array(z.string())
              .optional()
              .describe(
                "Bare sibling pack filenames for meta.related_multi_packs. List them on the FIRST pack only — a mutual reference deadlocks Pixi's Assets.load().",
              ),
          })
          .optional()
          .describe("Phaser/PixiJS-only options"),
      },
    },
    ({
      input_path,
      metadata,
      format,
      variant,
      texture,
      name_prefix,
      fps,
      output_path,
      godot,
      unity,
      aseprite,
      phaser,
    }) => {
      if ((input_path === undefined) === (metadata === undefined)) {
        throw new Error(
          "sprite_export_engine: pass exactly one of `input_path` (a metadata JSON file on disk) " +
            "or `metadata` (the same document inline) — got " +
            (input_path === undefined ? "neither" : "both"),
        );
      }

      const allowed: readonly string[] = EXPORT_VARIANTS[format];
      if (variant !== undefined && !allowed.includes(variant)) {
        throw new Error(
          `sprite_export_engine: format '${format}' has no variant '${variant}' — it accepts ${allowed
            .map((v) => `'${v}'`)
            .join(" or ")}`,
        );
      }
      const resolvedVariant = variant ?? allowed[0];

      const raw = input_path !== undefined ? readJsonDocument(input_path) : metadata;
      // A grid document's texture size is only trustworthy when read from the
      // sheet itself: the slicer floors, so frameWidth × cols can be short of
      // the real PNG, and Unity flips every rect against that height.
      const sheetSize =
        detectExportInputKind(raw) === "grid" ? sheetSizeFromSource(raw, input_path ?? null) : null;
      const doc = normalizeExportInput(raw, {
        texture,
        namePrefix: name_prefix,
        defaultFps: fps,
        sheetSize: sheetSize ?? undefined,
      });
      const stem = stripExtension(doc.texture);

      // Every format collapses to the same shape — a list of files — so the
      // single-file and multi-file variants share one write/return path.
      let files: { filename: string; content: string }[];
      switch (format) {
        case "godot": {
          const opts: GodotExportOptions = {
            texturePath: godot?.texture_path,
            loop: godot?.loop,
            loopMode: godot?.loop_mode,
            pingpong: godot?.pingpong,
            defaultAnimationName: godot?.default_animation_name,
            defaultAlias: godot?.default_alias,
            loadSteps: godot?.load_steps,
          };
          files =
            resolvedVariant === "atlastextures"
              ? toGodotAtlasTextureFiles(doc, opts)
              : [{ filename: `${stem}.tres`, content: toGodotSpriteFrames(doc, opts) }];
          break;
        }
        case "unity": {
          const opts: UnityExportOptions = {
            pixelsPerUnit: unity?.pixels_per_unit,
            filterMode: unity?.filter_mode,
            maxTextureSize: unity?.max_texture_size,
            serializedVersion: unity?.serialized_version,
            assetPath: unity?.asset_path,
            guid: unity?.guid,
            spriteMeshType: unity?.sprite_mesh_type,
            generateFallbackPhysicsShape: unity?.generate_fallback_physics_shape,
            physicsShape: unity?.physics_shape,
          };
          files = [{ filename: unityMetaFilename(doc), content: toUnityMeta(doc, opts) }];
          break;
        }
        case "aseprite": {
          const opts: AsepriteExportOptions = {
            format: resolvedVariant as AsepriteFormat,
            frameNames: aseprite?.frame_names,
            pivots: aseprite?.pivots,
            pivotSliceName: aseprite?.pivot_slice_name,
            app: aseprite?.app,
            version: aseprite?.version,
            image: aseprite?.image,
            pixelFormat: aseprite?.pixel_format,
          };
          files = [
            {
              filename: `${stem}.json`,
              content: `${JSON.stringify(toAsepriteJson(doc, opts), null, 2)}\n`,
            },
          ];
          break;
        }
        case "phaser": {
          const opts: PhaserExportOptions = {
            layout: resolvedVariant as PhaserFramesLayout,
            image: phaser?.image,
            format: phaser?.pixel_format,
            scale: phaser?.scale,
            app: phaser?.app,
            version: phaser?.version,
            frameNames: phaser?.frame_names,
            frameTags: phaser?.frame_tags,
            animations: phaser?.animations,
            anchors: phaser?.anchors,
            relatedMultiPacks: phaser?.related_multi_packs,
          };
          files = [
            {
              filename: `${stem}.json`,
              content: `${JSON.stringify(toPhaserAtlas(doc, opts), null, 2)}\n`,
            },
          ];
          break;
        }
      }

      const sized = files.map((f) => ({ ...f, bytes: Buffer.byteLength(f.content, "utf8") }));
      const summary = {
        format,
        variant: resolvedVariant,
        texture: doc.texture,
        frameCount: doc.frames.length,
        tagCount: doc.tags.length,
        bytes: sized.reduce((n, f) => n + f.bytes, 0),
      };

      if (output_path === undefined) {
        return jsonResult(
          sized.length === 1
            ? { ...summary, filename: sized[0].filename, content: sized[0].content }
            : { ...summary, files: sized },
        );
      }

      // A multi-file variant needs somewhere to put N files, so `output_path`
      // is the containing directory there and the file itself everywhere else.
      if (sized.length === 1) {
        mkdirSync(dirname(output_path), { recursive: true });
        writeFileSync(output_path, sized[0].content);
        return jsonResult({ path: output_path, ...summary });
      }
      mkdirSync(output_path, { recursive: true });
      const written = sized.map((f) => {
        const p = join(output_path, f.filename);
        writeFileSync(p, f.content);
        return { path: p, filename: f.filename, bytes: f.bytes };
      });
      return jsonResult({ path: output_path, ...summary, files: written });
    },
  );

  // ------- read_aseprite -------
  server.registerTool(
    "sprite_read_aseprite",
    {
      description:
        "Read an Aseprite working file (.ase / .aseprite) directly — the artist's source, not an export. Returns everything a PNG throws away: the named animation tags with their frame ranges, loop direction and repeat count, the per-frame durations in milliseconds, the layer tree (names, nesting, blend modes, opacity, visibility) and the palette. Optionally composites the frames and writes them as a sprite sheet PNG (`output_path`) and/or one PNG per frame (`frames_dir`); omit both to inspect the file without touching disk. Use this instead of asking for a PNG export when you need to know how a sprite animates, which layers exist, or how long each frame is held. `tag` exports just one animation; the returned `tags` ranges are then rebased onto the exported frames (0-based, indexing the sheet you got) and each frame's `sourceIndex` points back into the file. `layers` composites only the named layers (a group name selects every layer inside it), `include_hidden` brings back layers hidden in Aseprite. Palette entries are `#rrggbb`, or `#rrggbbaa` when not fully opaque. Always check the returned `warnings` — tilemap layers are unsupported and get skipped, so a sheet can legitimately come back missing content. Reference layers never composite; `layers` naming only reference or hidden layers (without `include_hidden`) is an error, and `layers[].reference` / `effectivelyVisible` tell them apart. The result is a sheet metadata document like sprite_generate_meta's: `source` / `sourceWidth` / `sourceHeight` describe the written sheet PNG (all null without `output_path`), `asepriteFile` is the file that was read, and `frameDurations` holds each exported frame's duration in ms — pass the result (or its file) straight to sprite_export_engine and the engine files keep Aseprite's timings, tag directions (including pingpong-reverse) and the sheet's real name and size.",
      inputSchema: {
        input_path: z.string().describe("Absolute path to a .ase or .aseprite file"),
        output_path: z
          .string()
          .optional()
          .describe("Write the composited frames as one sprite sheet PNG here"),
        frames_dir: z
          .string()
          .optional()
          .describe("Write one PNG per exported frame into this directory"),
        filename_pattern: z
          .string()
          .default("frame_%02d.png")
          .describe("printf-style pattern used inside frames_dir, e.g. 'run_%03d.png'"),
        cols: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Sheet columns; omit to lay every exported frame out in a single row"),
        tag: z
          .string()
          .optional()
          .describe("Export only the frames of this animation tag; omit for every frame"),
        layers: z
          .array(z.string())
          .optional()
          .describe(
            "Composite only the layers with these names (a group name selects its children); omit for every visible layer",
          ),
        include_hidden: z
          .boolean()
          .default(false)
          .describe("Composite layers that are hidden in Aseprite too"),
        scale: z
          .number()
          .int()
          .min(1)
          .max(16)
          .default(1)
          .describe("Integer nearest-neighbour upscale applied to every exported frame"),
      },
    },
    async ({
      input_path,
      output_path,
      frames_dir,
      filename_pattern,
      cols,
      tag,
      layers,
      include_hidden,
      scale,
    }) => {
      if (!existsSync(input_path)) throw new Error(`${input_path}: no such file`);
      const buf = readFileSync(input_path);
      if (buf.length === 0) throw new Error(`${input_path} is empty`);
      const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
      if (!isAsepriteFile(bytes)) {
        throw new Error(
          `${input_path}: not an Aseprite file (bad magic number) — expected a .ase or .aseprite ` +
            "document saved by Aseprite",
        );
      }

      // parse + composite as two steps (not decodeAseprite) so `layers` and
      // `include_hidden` reach the compositor without compositing twice.
      const doc = await parseAseprite(bytes, { inflate: inflateNode });
      const selection = resolveAsepriteLayers(doc, layers ?? [], {
        flag: "layers",
        includeHidden: include_hidden,
        hiddenHint: "include_hidden: true",
      });
      const all = compositeFrames(doc, {
        includeHiddenLayers: include_hidden,
        layerIndices: selection.indices,
      });
      if (all.length === 0) throw new Error(`${input_path}: file contains no frames`);

      const range = resolveAsepriteRange(doc, tag, all.length, "tag");
      const selected = all.slice(range.from, range.to + 1);
      const images = selected.map((f) => {
        // Copy rather than `new ImageData(f.pixels, ...)`: the composited buffer
        // is typed Uint8ClampedArray<ArrayBufferLike>, which the DOM ImageData
        // constructor signature rejects.
        const img = new ImageData(f.width, f.height);
        img.data.set(f.pixels);
        return upscaleNearestBy(img, scale);
      });

      // Checked before anything touches disk: a pattern with no %d gives every
      // frame the same filename, so each write would silently clobber the last
      // and the caller would get N identical paths back for one surviving PNG.
      if (frames_dir && images.length > 1 && !/%0?\d*d/.test(filename_pattern)) {
        throw new Error(
          `filename_pattern "${filename_pattern}" has no %d placeholder, so all ${images.length} ` +
            "frames would overwrite one file — use something like 'frame_%02d.png'",
        );
      }

      const sheetCols = cols ?? images.length;
      const sheetRows = Math.ceil(images.length / sheetCols);

      let sheetSize: { width: number; height: number } | null = null;
      if (output_path) {
        const sheet = stitchSheet(images, sheetCols, sheetRows);
        mkdirSync(dirname(output_path), { recursive: true });
        savePng(sheet, output_path);
        sheetSize = { width: sheet.width, height: sheet.height };
      }

      const framePaths: string[] = [];
      if (frames_dir) {
        for (let i = 0; i < images.length; i++) {
          const p = join(frames_dir, formatPattern(filename_pattern, i));
          // Per file, not once for frames_dir: the pattern may contain subdirectories.
          mkdirSync(dirname(p), { recursive: true });
          savePng(images[i], p);
          framePaths.push(p);
        }
      }

      // The document itself comes from the CLI's builder, so the two surfaces
      // cannot drift: `source` is the written sheet (null without output_path),
      // and `output_path === source` is what lets sprite_export_engine accept
      // this result as sheet metadata.
      const meta = buildAsepriteMetadata({
        asepriteFile: input_path,
        doc,
        frames: all,
        range,
        cols: sheetCols,
        scale,
        tag: tag ?? null,
        sheet: output_path && sheetSize ? { path: output_path, ...sheetSize } : null,
        extraWarnings: selection.warnings,
      });
      return jsonResult({
        ...meta,
        output_path: output_path ?? null,
        sheetWidth: sheetSize?.width ?? null,
        sheetHeight: sheetSize?.height ?? null,
        frames_dir: frames_dir ?? null,
        frame_paths: framePaths,
        options: {
          tag: tag ?? null,
          layers: layers ?? null,
          include_hidden,
          scale,
          cols: cols ?? null,
          filename_pattern,
        },
      });
    },
  );
}

// -----------------------------------------------------------------
// Local helpers
// -----------------------------------------------------------------

/**
 * Flatten every frame's pixels into one buffer. Palette work on a sheet has to
 * quantize across all frames at once, or each frame gets its own palette and a
 * swap that lands on frame 1 misses the same colour on frame 2.
 */
function mergeFramePixels(frames: ImageData[]): ImageData {
  let total = 0;
  for (const f of frames) total += f.width * f.height;
  const merged = new ImageData(Math.max(1, total), 1);
  let off = 0;
  for (const f of frames) {
    merged.data.set(f.data, off);
    off += f.data.length;
  }
  return merged;
}

// Per-frame nine-slice payload shared by sprite_generate_nine_slice and the
// merged meta tool. An explicitly given side always wins, then a .9.png
// border, and only what is still missing is guessed off the variance
// profiles — a frame with all four sides supplied is never even scanned.
function nineSliceSection(
  frames: ImageData[],
  grid: { cols: number; rows: number },
  opts: {
    left?: number;
    right?: number;
    top?: number;
    bottom?: number;
    alphaThreshold: number;
    tolerance: number;
    minMiddle: number;
    borderInsets?: NineSliceInsets | null;
  },
) {
  const border = opts.borderInsets ?? null;
  const allExplicit =
    opts.left !== undefined &&
    opts.right !== undefined &&
    opts.top !== undefined &&
    opts.bottom !== undefined;
  return frames.map((f, i) => {
    const guess =
      allExplicit || border
        ? null
        : detectNineSlice(f, {
            alphaThreshold: opts.alphaThreshold,
            tolerance: opts.tolerance,
            minMiddle: opts.minMiddle,
          });
    const base = border ?? guess?.insets ?? null;
    const insets = clampInsets(
      {
        left: opts.left ?? base?.left ?? 0,
        right: opts.right ?? base?.right ?? 0,
        top: opts.top ?? base?.top ?? 0,
        bottom: opts.bottom ?? base?.bottom ?? 0,
      },
      f.width,
      f.height,
      opts.minMiddle,
    );
    return {
      index: i,
      cell: { row: Math.floor(i / grid.cols), col: i % grid.cols },
      insets,
      detected: guess !== null,
      confidence: guess?.confidence ?? 0,
      regions: nineSliceRegions(insets, f.width, f.height),
    };
  });
}

// File I/O and error wrapping only; the validation (and buildTagPartitions)
// lives in dedupe-core, shared with the CLI so the two accept the same input.
function readTagsFile(path: string): ParsedTagsDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`could not read tags JSON at ${path}: ${e instanceof Error ? e.message : e}`);
  }
  try {
    return parseTagsDocument(parsed);
  } catch (e) {
    throw new Error(`tags JSON at ${path}: ${e instanceof Error ? e.message : e}`);
  }
}

/** Reads a metadata document, reporting a parse failure against the path the caller passed. */
function readJsonDocument(path: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(`sprite_export_engine: cannot read ${path} — ${(err as Error).message}`);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`sprite_export_engine: ${path} is not valid JSON — ${(err as Error).message}`);
  }
}

function formatPattern(pattern: string, n: number): string {
  return pattern.replace(/%(0?\d*)d/g, (_m, pad: string) => {
    const s = String(n);
    if (pad.startsWith("0")) return s.padStart(parseInt(pad, 10), "0");
    if (pad) return s.padStart(parseInt(pad, 10), " ");
    return s;
  });
}

// applyOutlineFx returns a bare buffer; the rest of the pipeline speaks ImageData.
function fxToImageData(res: { width: number; height: number; data: Uint8ClampedArray }): ImageData {
  const out = new ImageData(res.width, res.height);
  out.data.set(res.data);
  return out;
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
