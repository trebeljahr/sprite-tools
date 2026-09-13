// Shading-ramp detection and re-tinting.
//
// A pixel-art palette is not a flat bag of colors: it is a handful of ramps,
// each a run of shades of "the same" material. Recoloring a sprite one entry at
// a time destroys that structure, so we group the palette by hue in OKLCH and
// move a whole ramp at once — offsetting lightness additively, scaling chroma
// multiplicatively and rotating hue rigidly — which keeps the artist's shading
// (including the deliberate blue-shadow / yellow-highlight drift) intact.

import type { RGB } from "../pixel-art/pixelate";
import type { SwapEntry } from "./extract";
import { hueDelta, hueDistance, type OKLCH, oklchToRgb, rgbToOklch } from "./oklab";

export interface Ramp {
  /** Stable index into the detectRamps() result. */
  index: number;
  /** Ascending Oklab L. Always at least one entry. */
  colors: RGB[];
  /** Index into `colors` of the representative (most saturated) entry. */
  anchorIndex: number;
  /** True for the greys / near-greys bucket, where hue carries no meaning. */
  achromatic: boolean;
}

export interface RampOptions {
  /** Degrees of hue slack for joining a cluster. */
  hueTolerance?: number;
  /** Below this Oklab chroma a color counts as grey. */
  chromaThreshold?: number;
}

export const DEFAULT_HUE_TOLERANCE = 25;
export const DEFAULT_CHROMA_THRESHOLD = 0.03;

interface Sample {
  rgb: RGB;
  lch: OKLCH;
}

/**
 * Running circular mean of a cluster's hues. A plain arithmetic mean is wrong
 * on a circle: a red ramp at 355 and 5 degrees would average to 180 (cyan) and
 * the ramp would split in two at the 0/360 wrap.
 */
class Cluster {
  samples: Sample[] = [];
  private sumSin = 0;
  private sumCos = 0;

  add(s: Sample) {
    this.samples.push(s);
    const rad = (s.lch.h * Math.PI) / 180;
    this.sumSin += Math.sin(rad);
    this.sumCos += Math.cos(rad);
  }

  get meanHue(): number {
    const deg = (Math.atan2(this.sumSin, this.sumCos) * 180) / Math.PI;
    return deg < 0 ? deg + 360 : deg;
  }
}

function medianOfSorted(values: number[]): number {
  const n = values.length;
  if (n === 0) return 0;
  const mid = n >> 1;
  return n % 2 === 1 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
}

function buildRamp(samples: Sample[], achromatic: boolean): Omit<Ramp, "index"> {
  const sorted = [...samples].sort((a, b) => a.lch.l - b.lch.l);
  const medianL = medianOfSorted(sorted.map((s) => s.lch.l));

  // The anchor is the color a user pictures when naming the ramp: its most
  // saturated shade. Ties (all of an achromatic ramp) fall back to the entry
  // nearest the ramp's median lightness, i.e. its mid-tone.
  let anchorIndex = 0;
  for (let i = 1; i < sorted.length; i++) {
    const cur = sorted[i].lch;
    const best = sorted[anchorIndex].lch;
    if (cur.c > best.c) {
      anchorIndex = i;
    } else if (cur.c === best.c) {
      if (Math.abs(cur.l - medianL) < Math.abs(best.l - medianL)) anchorIndex = i;
    }
  }

  return { colors: sorted.map((s) => s.rgb), anchorIndex, achromatic };
}

export function detectRamps(palette: RGB[], opts: RampOptions = {}): Ramp[] {
  if (palette.length === 0) return [];
  const hueTolerance = opts.hueTolerance ?? DEFAULT_HUE_TOLERANCE;
  const chromaThreshold = opts.chromaThreshold ?? DEFAULT_CHROMA_THRESHOLD;

  const greys: Sample[] = [];
  const chromatic: Sample[] = [];
  for (const rgb of palette) {
    const sample: Sample = { rgb, lch: rgbToOklch(rgb) };
    if (sample.lch.c < chromaThreshold) greys.push(sample);
    else chromatic.push(sample);
  }

  // Seed clusters from the most saturated colors first: they carry the most
  // reliable hue, and it makes the result independent of palette input order.
  const seeded = [...chromatic].sort(
    (a, b) => b.lch.c - a.lch.c || a.lch.h - b.lch.h || a.lch.l - b.lch.l,
  );

  const clusters: Cluster[] = [];
  for (const sample of seeded) {
    let best: Cluster | null = null;
    let bestDist = Infinity;
    for (const cluster of clusters) {
      const dist = hueDistance(cluster.meanHue, sample.lch.h);
      if (dist <= hueTolerance && dist < bestDist) {
        best = cluster;
        bestDist = dist;
      }
    }
    if (!best) {
      best = new Cluster();
      clusters.push(best);
    }
    best.add(sample);
  }

  const ramps = clusters.map((c) => buildRamp(c.samples, false));
  if (greys.length > 0) ramps.push(buildRamp(greys, true));

  // Largest first, then by anchor hue, so a given palette always yields the
  // same indices — CLI flags and manifests reference ramps by index.
  ramps.sort((a, b) => {
    if (b.colors.length !== a.colors.length) return b.colors.length - a.colors.length;
    const ah = rgbToOklch(a.colors[a.anchorIndex]);
    const bh = rgbToOklch(b.colors[b.anchorIndex]);
    return ah.h - bh.h || ah.l - bh.l;
  });

  return ramps.map((r, index) => ({ index, ...r }));
}

export function rampBaseColor(ramp: Ramp): RGB {
  return ramp.colors[ramp.anchorIndex];
}

/** Below this the anchor has no usable chroma to scale, so we offset instead. */
const CHROMA_RATIO_FLOOR = 1e-4;

export function remapRamp(ramp: Ramp, newBase: RGB): SwapEntry[] {
  if (ramp.colors.length === 0) return [];

  const anchor = rgbToOklch(ramp.colors[ramp.anchorIndex]);
  const target = rgbToOklch(newBase);

  let dL = target.l - anchor.l;
  const dH = hueDelta(anchor.h, target.h);
  // A grey ramp has no chroma to scale — a ratio against ~0 would explode — so
  // tinting one means *adding* chroma. The achromatic bucket also covers
  // near-greys well above the float floor, so trust the flag, not just the math.
  const useRatio = !ramp.achromatic && anchor.c > CHROMA_RATIO_FLOOR;
  const cRatio = useRatio ? target.c / anchor.c : 1;
  const dC = useRatio ? 0 : target.c - anchor.c;

  // Remapping a ramp onto its own base is an explicit no-op: short-circuit so
  // it can never emit swaps from conversion round-off.
  if (dL === 0 && dH === 0 && cRatio === 1 && dC === 0) return [];

  const shades = ramp.colors.map((rgb) => rgbToOklch(rgb));

  // Clamp the *offset* against the whole ramp rather than clamping each entry:
  // per-entry clamping would pile several shades onto L=0 or L=1 and collapse
  // the ramp into a flat blob.
  let minL = Infinity;
  let maxL = -Infinity;
  for (const s of shades) {
    if (s.l < minL) minL = s.l;
    if (s.l > maxL) maxL = s.l;
  }
  dL = Math.max(-minL, Math.min(1 - maxL, dL));

  const swaps: SwapEntry[] = [];
  for (let i = 0; i < shades.length; i++) {
    const s = shades[i];
    const c = useRatio ? s.c * cRatio : Math.max(0, s.c + dC);
    const to = oklchToRgb({ l: s.l + dL, c, h: s.h + dH });
    const from = ramp.colors[i];
    if (to.r === from.r && to.g === from.g && to.b === from.b) continue;
    swaps.push({ from, to });
  }
  return swaps;
}
