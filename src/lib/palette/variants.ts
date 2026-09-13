// Named palette variants: one sprite sheet, many recolors.
//
// A variant is a declarative recipe (hue rotation / ramp re-tints / individual
// swaps) that resolves against a concrete extracted palette into plain
// SwapEntry[], so the web app, the CLI and the MCP server all produce identical
// pixels from the same spec. Stages apply coarse-to-fine — whole-palette hue
// shift, then ramps, then single colors — so a hand-picked swap always wins
// over the broad strokes underneath it.

import type { RGB } from "../pixel-art/pixelate";
import { hexToRgb, rgbToHex, type SwapEntry } from "./extract";
import { rotateHue } from "./oklab";
import { type Ramp, remapRamp } from "./ramps";

export interface VariantSpec {
  name: string;
  /** "#rrggbb" -> "#rrggbb", individual colors. */
  swaps?: Record<string, string>;
  /** `base` is ANY member hex of the target ramp, not necessarily its anchor. */
  ramps?: { base: string; to: string }[];
  /** Degrees, applied to the whole palette. */
  hueShift?: number;
}

export interface VariantSetFile {
  version: number;
  colors?: number;
  variants: VariantSpec[];
}

export const VARIANT_SET_VERSION = 1;

const HEX_RE = /^#?([0-9a-f]{6})$/i;

function normalizeHex(value: unknown, where: string): string {
  if (typeof value !== "string") {
    return fail(`${where}: expected a hex color string, got ${describe(value)}`);
  }
  const m = HEX_RE.exec(value.trim());
  if (!m) {
    return fail(`${where}: "${value}" is not a valid hex color (expected #rrggbb)`);
  }
  return `#${m[1].toLowerCase()}`;
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value;
}

function fail(message: string): never {
  throw new Error(message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseVariantSet(input: unknown): VariantSetFile {
  if (!isPlainObject(input)) {
    fail(`Variant set must be a JSON object, got ${describe(input)}`);
  }
  if (input.version !== VARIANT_SET_VERSION) {
    fail(
      `Unsupported variant set version ${JSON.stringify(input.version)} ` +
        `(expected ${VARIANT_SET_VERSION})`,
    );
  }

  let colors: number | undefined;
  if (input.colors !== undefined) {
    if (typeof input.colors !== "number" || !Number.isInteger(input.colors) || input.colors < 1) {
      fail(`"colors" must be a positive integer, got ${JSON.stringify(input.colors)}`);
    }
    colors = input.colors;
  }

  if (!Array.isArray(input.variants) || input.variants.length === 0) {
    fail('"variants" must be a non-empty array');
  }

  const seen = new Map<string, string>();
  const variants: VariantSpec[] = input.variants.map((raw, i) => {
    const where = `variants[${i}]`;
    if (!isPlainObject(raw)) fail(`${where}: must be an object, got ${describe(raw)}`);
    if (typeof raw.name !== "string" || raw.name.trim() === "") {
      fail(`${where}: "name" must be a non-empty string`);
    }
    const name = raw.name.trim();
    const slug = slugifyVariantName(name);
    const prior = seen.get(slug);
    if (prior !== undefined) {
      fail(`${where}: duplicate variant name "${name}" (collides with "${prior}" as "${slug}")`);
    }
    seen.set(slug, name);

    const spec: VariantSpec = { name };

    if (raw.swaps !== undefined) {
      if (!isPlainObject(raw.swaps)) {
        fail(`${where}.swaps: must be an object of "#rrggbb": "#rrggbb" pairs`);
      }
      const swaps: Record<string, string> = {};
      for (const [from, to] of Object.entries(raw.swaps)) {
        const key = normalizeHex(from, `${where}.swaps key`);
        swaps[key] = normalizeHex(to, `${where}.swaps["${from}"]`);
      }
      if (Object.keys(swaps).length > 0) spec.swaps = swaps;
    }

    if (raw.ramps !== undefined) {
      if (!Array.isArray(raw.ramps)) fail(`${where}.ramps: must be an array`);
      const ramps = raw.ramps.map((entry, j) => {
        if (!isPlainObject(entry)) {
          fail(`${where}.ramps[${j}]: must be an object with "base" and "to"`);
        }
        return {
          base: normalizeHex(entry.base, `${where}.ramps[${j}].base`),
          to: normalizeHex(entry.to, `${where}.ramps[${j}].to`),
        };
      });
      if (ramps.length > 0) spec.ramps = ramps;
    }

    if (raw.hueShift !== undefined) {
      if (typeof raw.hueShift !== "number" || !Number.isFinite(raw.hueShift)) {
        fail(`${where}.hueShift: must be a finite number of degrees`);
      }
      spec.hueShift = raw.hueShift;
    }

    if (!spec.swaps && !spec.ramps && spec.hueShift === undefined) {
      fail(`${where}: variant "${name}" is empty — needs at least one of swaps, ramps, hueShift`);
    }
    return spec;
  });

  return colors === undefined
    ? { version: VARIANT_SET_VERSION, variants }
    : { version: VARIANT_SET_VERSION, colors, variants };
}

export function hueShiftVariants(
  count: number,
  opts: { stepDeg?: number; startDeg?: number; prefix?: string } = {},
): VariantSpec[] {
  if (!Number.isFinite(count) || count < 1) return [];
  const n = Math.floor(count);
  const step = opts.stepDeg ?? 360 / n;
  const start = opts.startDeg ?? 0;
  const prefix = opts.prefix ?? "hue";

  // Emit all `n` rotations *including* the 0-degree one: asking for 8 enemy
  // tints means 8 files, and the untinted original is one of them.
  return Array.from({ length: n }, (_, i) => {
    const raw = start + i * step;
    const deg = ((raw % 360) + 360) % 360;
    // Zero-padded to 3 so the generated filenames sort in hue order.
    return { name: `${prefix}${String(Math.round(deg)).padStart(3, "0")}`, hueShift: deg };
  });
}

function sameRgb(a: RGB, b: RGB): boolean {
  return a.r === b.r && a.g === b.g && a.b === b.b;
}

/** Ramp whose members include the palette entry closest to `hex`. */
function findRampByMember(hex: string, palette: RGB[], ramps: Ramp[]): Ramp | undefined {
  if (palette.length === 0) return undefined;
  const target = hexToRgb(hex);
  let best = palette[0];
  let bestD = Infinity;
  for (const p of palette) {
    const dr = p.r - target.r;
    const dg = p.g - target.g;
    const db = p.b - target.b;
    const d = dr * dr + dg * dg + db * db;
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return ramps.find((ramp) => ramp.colors.some((c) => sameRgb(c, best)));
}

export function resolveVariant(spec: VariantSpec, palette: RGB[], ramps: Ramp[]): SwapEntry[] {
  // Keyed by source hex so a later stage simply overwrites an earlier one.
  const resolved = new Map<string, { from: RGB; to: RGB }>();

  if (spec.hueShift !== undefined) {
    for (const from of palette) {
      resolved.set(rgbToHex(from), { from, to: rotateHue(from, spec.hueShift) });
    }
  }

  for (const { base, to } of spec.ramps ?? []) {
    const ramp = findRampByMember(base, palette, ramps);
    if (!ramp) continue;
    for (const swap of remapRamp(ramp, hexToRgb(to))) {
      resolved.set(rgbToHex(swap.from), swap);
    }
  }

  for (const [from, to] of Object.entries(spec.swaps ?? {})) {
    // Kept even when `from` isn't in this palette: it is inert downstream, and
    // dropping it would silently discard what the user explicitly asked for.
    resolved.set(from, { from: hexToRgb(from), to: hexToRgb(to) });
  }

  const swaps: SwapEntry[] = [];
  for (const entry of resolved.values()) {
    if (!sameRgb(entry.from, entry.to)) swaps.push(entry);
  }
  return swaps;
}

export function slugifyVariantName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug === "" ? "variant" : slug;
}

export function variantFileName(base: string, variantName: string, ext = "png"): string {
  return `${base}_${slugifyVariantName(variantName)}.${ext}`;
}

export interface VariantManifestEntry {
  name: string;
  slug: string;
  /** Filename only, relative to the manifest. */
  file: string;
  hueShift?: number;
  swaps: { from: string; to: string }[];
}

export interface VariantManifest {
  version: number;
  source: string;
  frameWidth: number;
  frameHeight: number;
  grid: { cols: number; rows: number; detected: boolean };
  options: { colors: number; mode: "defs" | "hue"; rampTolerance: number };
  palette: string[];
  ramps: { index: number; base: string; colors: string[]; achromatic: boolean }[];
  variants: VariantManifestEntry[];
}

export const VARIANT_MANIFEST_VERSION = 1;

export function describeRamps(ramps: Ramp[]): VariantManifest["ramps"] {
  return ramps.map((ramp) => ({
    index: ramp.index,
    base: rgbToHex(ramp.colors[ramp.anchorIndex]),
    colors: ramp.colors.map(rgbToHex),
    achromatic: ramp.achromatic,
  }));
}
