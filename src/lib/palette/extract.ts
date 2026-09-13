// Palette extraction and per-color remapping.
//
// Extraction reuses the median-cut quantizer from the Pixelate module, so
// behavior is consistent across the app. Swap remaps any pixel belonging to
// a source palette bucket to a new color, with a tolerance threshold.
//
// One deliberate departure from plain median-cut: when a sprite has no more
// distinct colors than the caller asked for, we return those colors verbatim
// instead of quantizing. Median-cut splits boxes by PIXEL COUNT, so on flat
// pixel art a large single-color region gets carved into several boxes that
// all average back to the same hex, while a small but distinct color (a face,
// a trim) never earns a box of its own and falls into a neighbour's bucket.
// That is merely wasteful for a preview, but actively wrong for ramp
// re-tinting: applyPaletteSwap keys every pixel on its nearest bucket, so a
// skin tone sharing the shirt's bucket turns blue when the shirt is re-tinted.
// Pixel art almost always lands in the exact-palette path, which makes
// "colors outside the targeted ramp are unchanged" hold exactly.

import { medianCut, type RGB, hexToRgb } from "../pixel-art/pixelate";

export interface SwapEntry {
  from: RGB;
  to: RGB;
}

/**
 * Collect up to N dominant colors from all opaque pixels, most-used first.
 *
 * Never returns duplicate entries: a duplicate wastes a palette slot, produces
 * nonsense single-color "ramps", and silently shadows any swap targeting the
 * second copy (nearest-bucket lookup always resolves to the first).
 */
export function extractPalette(src: ImageData, count: number): RGB[] {
  if (count <= 0) return [];

  // Population per distinct color, so both paths can order by dominance.
  const counts = new Map<number, number>();
  const d = src.data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] > 0) {
      const key = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2];
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  if (counts.size === 0) return [];

  const unkey = (k: number): RGB => ({ r: (k >> 16) & 255, g: (k >> 8) & 255, b: k & 255 });
  const byPopulation = [...counts.entries()].sort((a, b) => b[1] - a[1]);

  // Exact palette — the sprite has no more colors than were asked for, so
  // quantizing could only lose information.
  if (counts.size <= count) return byPopulation.map(([k]) => unkey(k));

  const pixels: RGB[] = [];
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] > 0) pixels.push({ r: d[i], g: d[i + 1], b: d[i + 2] });
  }

  const seen = new Set<number>();
  const out: RGB[] = [];
  for (const c of medianCut(pixels, count)) {
    const key = (c.r << 16) | (c.g << 8) | c.b;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

/**
 * Recolor `src` by nearest-palette-bucket lookup, then applying the swap map.
 * Unmapped palette entries pass through unchanged. Works well when the
 * extracted palette is stable across frames of the same sheet.
 */
export function applyPaletteSwap(src: ImageData, palette: RGB[], swaps: SwapEntry[]): ImageData {
  if (palette.length === 0 || swaps.length === 0) {
    const out = new ImageData(src.width, src.height);
    out.data.set(src.data);
    return out;
  }

  // Build a lookup: for each palette index, the (possibly new) target color.
  const target: RGB[] = palette.map((p) => {
    const swap = swaps.find((s) => s.from.r === p.r && s.from.g === p.g && s.from.b === p.b);
    return swap ? swap.to : p;
  });

  const out = new ImageData(src.width, src.height);
  const od = out.data;
  const sd = src.data;

  for (let i = 0; i < sd.length; i += 4) {
    const a = sd[i + 3];
    if (a === 0) {
      od[i + 3] = 0;
      continue;
    }
    const r = sd[i];
    const g = sd[i + 1];
    const b = sd[i + 2];
    // Nearest palette index (squared distance).
    let bestIdx = 0;
    let bestD = Infinity;
    for (let k = 0; k < palette.length; k++) {
      const dr = palette[k].r - r;
      const dg = palette[k].g - g;
      const db = palette[k].b - b;
      const d = dr * dr + dg * dg + db * db;
      if (d < bestD) {
        bestD = d;
        bestIdx = k;
      }
    }
    const t = target[bestIdx];
    od[i] = t.r;
    od[i + 1] = t.g;
    od[i + 2] = t.b;
    od[i + 3] = a;
  }
  return out;
}

export function rgbToHex(c: RGB): string {
  const toHex = (n: number) => n.toString(16).padStart(2, "0");
  return `#${toHex(c.r)}${toHex(c.g)}${toHex(c.b)}`;
}

export { hexToRgb };
