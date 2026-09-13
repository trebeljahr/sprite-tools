import type { Command } from "commander";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  writeJsonOutput,
  writeBinaryOutput,
  fail,
  parseIntArg,
  parseFloatArg,
  loadSheet,
  sheetHeader,
  baseName,
  addHelpExtras,
  addGridOptions,
  gridPaddingFromOpts,
  type GridPaddingOpts,
} from "../lib/common";
import { imageToPngBuffer, savePng, stitchSheet } from "../lib/image-io";
import {
  applyPaletteSwap,
  extractPalette,
  rgbToHex,
  hexToRgb,
  type SwapEntry,
} from "../../src/lib/palette/extract";
import { DEFAULT_HUE_TOLERANCE, detectRamps } from "../../src/lib/palette/ramps";
import {
  describeRamps,
  hueShiftVariants,
  parseVariantSet,
  resolveVariant,
  slugifyVariantName,
  variantFileName,
  VARIANT_MANIFEST_VERSION,
  type VariantManifest,
  type VariantManifestEntry,
  type VariantSpec,
} from "../../src/lib/palette/variants";
import type { RGB } from "../../src/lib/pixel-art/pixelate";

export function registerPaletteCommand(program: Command) {
  const cmd = program
    .command("palette <input>")
    .description("Extract dominant colors, detect shading ramps, recolor and generate variants.")
    .option("--cols <n>", "sheet columns", (v) => parseIntArg("cols", v))
    .option("--rows <n>", "sheet rows", (v) => parseIntArg("rows", v))
    .option("--colors <n>", "palette size", (v) => parseIntArg("colors", v), 8)
    .option(
      "--swap <from>=<to>",
      'repeatable: hex=hex swap, e.g. "#ff0000=#0000ff"',
      collectArg,
      [],
    )
    .option("--ramps", "include detected shading ramps in the JSON output", false)
    .option(
      "--ramp-tolerance <deg>",
      "hue tolerance (degrees) for ramp detection",
      (v) => parseFloatArg("ramp-tolerance", v),
      DEFAULT_HUE_TOLERANCE,
    )
    .option(
      "--ramp <member>=<newbase>",
      'repeatable: re-tint the ramp containing <member>, e.g. "#af4d4d=#4d7faf"',
      collectArg,
      [],
    )
    .option("--variants <file>", "variant-set JSON file (version 1)")
    .option("--hue-variants <n>", "instead: generate n evenly spaced hue rotations", (v) =>
      parseIntArg("hue-variants", v),
    )
    .option("--hue-step <deg>", "override the even spacing of --hue-variants", (v) =>
      parseFloatArg("hue-step", v),
    )
    .option("--out-dir <dir>", "directory for generated variant PNGs", ".")
    .option("--name <base>", "filename base for variants (default: input basename)")
    .option("--manifest <file>", "write the variant manifest JSON here")
    .option("--image <file>", "write recolored sheet PNG here (in addition to JSON)")
    .option("-o, --output <file>", "output JSON file (default: stdout)");

  addGridOptions(cmd);

  addHelpExtras(cmd, {
    examples: [
      "sprite-tools palette hero.png --colors 12",
      'sprite-tools palette hero.png --swap "#ff0000=#0000ff" --image hero-blue.png',
      "# inspect the shading ramps before re-tinting one:",
      "sprite-tools palette hero.png --ramps | jq '.ramps'",
      "# move a whole ramp at once (any member hex names it), shading preserved:",
      'sprite-tools palette hero.png --ramp "#af4d4d=#4d7faf" --image hero-blue.png',
      "# 8 evenly spaced team colors + a manifest:",
      "sprite-tools palette hero.png --hue-variants 8 --out-dir ./variants \\",
      "  --manifest ./variants/hero.json",
      "# named variants from a spec file:",
      "sprite-tools palette hero.png --variants teams.json --out-dir ./variants",
      "# extract once, reuse the palette:",
      "sprite-tools palette hero.png | jq -r '.palette[]'",
    ],
    output: [
      "{ source, frameWidth, frameHeight, grid, options,",
      "  palette: ['#rrggbb', ...],",
      "  swaps: [{ from: '#rrggbb', to: '#rrggbb' }, ...],",
      "  ramps: [{ index, base, colors: ['#rrggbb', ...], achromatic }, ...],",
      "  variants: [{ name, slug, file, hueShift?, swaps }, ...] }",
      "",
      "`ramps` appears with --ramps or any --ramp/variant flag; `variants` when",
      "variants were generated. Variant PNGs go to <out-dir>/<base>_<slug>.png.",
      "",
      "--variants file shape (camelCase, unlike the MCP tool's snake_case):",
      "  { version: 1, colors?: 8, variants: [",
      '    { name: "Team Red", ramps: [{ base: "#af4d4d", to: "#4d7faf" }],',
      '      swaps: { "#ffffff": "#ffe9a0" }, hueShift: 90 }, ... ] }',
    ],
  });

  cmd.action(
    (
      input: string,
      opts: {
        cols?: number;
        rows?: number;
        colors: number;
        swap: string[];
        ramps: boolean;
        rampTolerance: number;
        ramp: string[];
        variants?: string;
        hueVariants?: number;
        hueStep?: number;
        outDir: string;
        name?: string;
        manifest?: string;
        image?: string;
        output?: string;
      } & GridPaddingOpts,
    ) => {
      try {
        if (opts.variants && opts.hueVariants !== undefined) {
          fail("--variants and --hue-variants are mutually exclusive (pick one)");
        }
        if (opts.hueStep !== undefined && opts.hueVariants === undefined) {
          fail(
            '--hue-step only applies with --hue-variants (e.g. "--hue-variants 6 --hue-step 30")',
          );
        }
        if (opts.hueVariants !== undefined && opts.hueVariants < 1) {
          fail(`--hue-variants: expected a count of 1 or more, got "${opts.hueVariants}"`);
        }

        // Read the variant set before extracting, so its optional "colors" can
        // pin the palette size the set was authored against — an explicit
        // --colors still wins.
        const variantSet = opts.variants ? readVariantSet(opts.variants) : undefined;
        const colors =
          variantSet?.colors !== undefined && cmd.getOptionValueSource("colors") === "default"
            ? variantSet.colors
            : opts.colors;

        const { image, frames, grid } = loadSheet(
          input,
          opts.cols,
          opts.rows,
          gridPaddingFromOpts(opts),
        );

        // Build a merged ImageData over ALL frames to extract a shared palette:
        // one palette for the whole animation, so a variant recolors every
        // frame the same way.
        const total = frames.reduce((n, f) => n + f.width * f.height, 0);
        const merged = new ImageData(total, 1);
        let off = 0;
        for (const f of frames) {
          merged.data.set(f.data, off);
          off += f.data.length;
        }
        const palette = extractPalette(merged, colors);
        const paletteHex = palette.map(rgbToHex);

        const rampArgs = opts.ramp.map((s) => parsePair("--ramp", s));
        const specs = variantSet
          ? variantSet.variants
          : opts.hueVariants !== undefined
            ? hueShiftVariants(opts.hueVariants, { stepDeg: opts.hueStep })
            : [];
        const wantsRamps = opts.ramps || rampArgs.length > 0 || specs.length > 0;

        if (wantsRamps && palette.length === 0) {
          fail(`no colors found in ${input} — every pixel is transparent`);
        }

        const ramps = wantsRamps ? detectRamps(palette, { hueTolerance: opts.rampTolerance }) : [];

        // Parse individual swaps.
        const swapMap = new Map<string, string>();
        for (const s of opts.swap) {
          const [from, to] = parsePair("--swap", s);
          swapMap.set(from, to);
        }
        const explicitSwaps = palette
          .map((p) => {
            const key = rgbToHex(p).toLowerCase();
            const to = swapMap.get(key);
            if (!to) return null;
            return { from: p, to: hexToRgb(to) };
          })
          .filter((s): s is { from: RGB; to: RGB } => s !== null);

        // --ramp remaps are the ramp-level sibling of --swap: they feed the same
        // recolored --image and the same "swaps" output key. Ramps first, then
        // individual swaps, so an explicit --swap always wins (same stage order
        // resolveVariant uses for variants). With no --ramp the legacy list is
        // passed through untouched, duplicate palette entries and all.
        const swaps =
          rampArgs.length === 0
            ? explicitSwaps
            : mergeSwaps(
                resolveVariant(
                  { name: "cli", ramps: rampArgs.map(([base, to]) => ({ base, to })) },
                  palette,
                  ramps,
                ),
                explicitSwaps,
              );

        // Optional: write a recolored sheet.
        if (opts.image && swaps.length > 0) {
          const recolored = frames.map((f) => applyPaletteSwap(f, palette, swaps));
          const out =
            recolored.length === 1 ? recolored[0] : stitchSheet(recolored, grid.cols, grid.rows);
          writeBinaryOutput(imageToPngBuffer(out), opts.image);
        }

        const base = opts.name ?? baseName(input);
        const variants: VariantManifestEntry[] = [];
        if (specs.length > 0) {
          // parseVariantSet already rejects colliding names, but a --hue-step
          // that repeats a rotation (e.g. 4 x 90 with --hue-step 180) would
          // quietly overwrite the same PNG instead of writing n files.
          const byFile = new Map<string, string>();
          for (const spec of specs) {
            const file = variantFileName(base, spec.name);
            const prior = byFile.get(file);
            if (prior !== undefined) {
              fail(
                `variants "${prior}" and "${spec.name}" both write ${file} — ` +
                  "pick a --hue-step that yields distinct rotations",
              );
            }
            byFile.set(file, spec.name);
          }
          mkdirSync(opts.outDir, { recursive: true });
          for (const spec of specs) {
            variants.push(
              writeVariant(spec, { base, outDir: opts.outDir, frames, grid, palette, ramps }),
            );
          }
          process.stderr.write(`wrote ${variants.length} variants → ${opts.outDir}\n`);
        }

        if (opts.manifest) {
          if (specs.length === 0) {
            fail("--manifest needs variants — add --hue-variants <n> or --variants <file>");
          }
          const manifest: VariantManifest = {
            version: VARIANT_MANIFEST_VERSION,
            source: input,
            frameWidth: frames[0]?.width ?? 0,
            frameHeight: frames[0]?.height ?? 0,
            grid: { cols: grid.cols, rows: grid.rows, detected: grid.detected },
            options: {
              colors,
              mode: opts.hueVariants !== undefined ? "hue" : "defs",
              rampTolerance: opts.rampTolerance,
            },
            palette: paletteHex,
            ramps: describeRamps(ramps),
            variants,
          };
          mkdirSync(dirname(opts.manifest), { recursive: true });
          writeJsonOutput(manifest, opts.manifest);
        }

        writeJsonOutput(
          {
            ...sheetHeader(input, image, grid, frames),
            options: wantsRamps ? { colors, rampTolerance: opts.rampTolerance } : { colors },
            palette: paletteHex,
            swaps: swaps.map((s) => ({ from: rgbToHex(s.from), to: rgbToHex(s.to) })),
            ...(wantsRamps ? { ramps: describeRamps(ramps) } : {}),
            ...(variants.length > 0 ? { variants } : {}),
          },
          opts.output,
        );
      } catch (e) {
        fail(e instanceof Error ? e.message : String(e));
      }
    },
  );
}

function collectArg(value: string, prev: string[]): string[] {
  return [...prev, value];
}

/** Parse a `hex=hex` flag value into a normalized [from, to] pair. */
function parsePair(flag: string, raw: string): [string, string] {
  const m = /^(#?[0-9a-f]{6})\s*=\s*(#?[0-9a-f]{6})$/i.exec(raw.trim());
  if (!m) fail(`invalid ${flag} "${raw}" (expected "#rrggbb=#rrggbb")`);
  return [normalizeHex(m![1]), normalizeHex(m![2])];
}

function normalizeHex(s: string): string {
  return (s.startsWith("#") ? s : `#${s}`).toLowerCase();
}

function readVariantSet(path: string) {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    return fail(`--variants ${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return fail(`--variants ${path}: not valid JSON (${e instanceof Error ? e.message : e})`);
  }
  try {
    return parseVariantSet(parsed);
  } catch (e) {
    return fail(`--variants ${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Later entries win for the same source color. */
function mergeSwaps(...stages: SwapEntry[][]): SwapEntry[] {
  const byFrom = new Map<string, SwapEntry>();
  for (const stage of stages) {
    for (const s of stage) byFrom.set(rgbToHex(s.from), s);
  }
  return [...byFrom.values()];
}

function writeVariant(
  spec: VariantSpec,
  ctx: {
    base: string;
    outDir: string;
    frames: ImageData[];
    grid: { cols: number; rows: number };
    palette: RGB[];
    ramps: ReturnType<typeof detectRamps>;
  },
): VariantManifestEntry {
  const swaps = resolveVariant(spec, ctx.palette, ctx.ramps);
  const recolored = ctx.frames.map((f) => applyPaletteSwap(f, ctx.palette, swaps));
  const sheet =
    recolored.length === 1 ? recolored[0] : stitchSheet(recolored, ctx.grid.cols, ctx.grid.rows);

  const slug = slugifyVariantName(spec.name);
  const file = variantFileName(ctx.base, spec.name);
  savePng(sheet, join(ctx.outDir, file));

  return {
    name: spec.name,
    slug,
    file,
    ...(spec.hueShift !== undefined ? { hueShift: spec.hueShift } : {}),
    swaps: swaps.map((s) => ({ from: rgbToHex(s.from), to: rgbToHex(s.to) })),
  };
}
