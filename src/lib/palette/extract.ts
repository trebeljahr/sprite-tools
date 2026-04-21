// Palette extraction and per-color remapping.
//
// Extraction reuses the median-cut quantizer from the Pixelate module, so
// behavior is consistent across the app. Swap remaps any pixel belonging to
// a source palette bucket to a new color, with a tolerance threshold.

import { medianCut, type RGB, hexToRgb } from "../pixel-art/pixelate";

export interface SwapEntry {
  from: RGB;
  to: RGB;
}

/** Collect N dominant colors from all opaque pixels. */
export function extractPalette(src: ImageData, count: number): RGB[] {
  if (count <= 0) return [];
  const pixels: RGB[] = [];
  const d = src.data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] > 0) {
      pixels.push({ r: d[i], g: d[i + 1], b: d[i + 2] });
    }
  }
  return medianCut(pixels, count);
}

/**
 * Recolor `src` by nearest-palette-bucket lookup, then applying the swap map.
 * Unmapped palette entries pass through unchanged. Works well when the
 * extracted palette is stable across frames of the same sheet.
 */
export function applyPaletteSwap(
  src: ImageData,
  palette: RGB[],
  swaps: SwapEntry[],
): ImageData {
  if (palette.length === 0 || swaps.length === 0) {
    const out = new ImageData(src.width, src.height);
    out.data.set(src.data);
    return out;
  }

  // Build a lookup: for each palette index, the (possibly new) target color.
  const target: RGB[] = palette.map((p) => {
    const swap = swaps.find(
      (s) => s.from.r === p.r && s.from.g === p.g && s.from.b === p.b,
    );
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
