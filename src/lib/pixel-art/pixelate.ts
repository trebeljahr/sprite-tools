// Convert a regular image into a pixel-art style render.
//
// Pipeline:
//   1. Downscale by `pixelSize` via box-average (preserves alpha correctly).
//   2. (Optional) Quantize to N colors via median-cut.
//   3. (Optional) Snap to a fixed palette.
//   4. (Optional) Floyd–Steinberg dither during the palette-mapping step.

export interface RGB {
  r: number;
  g: number;
  b: number;
}

export type DitherMode = "none" | "floyd-steinberg";

export interface PixelateOptions {
  /** How many source pixels map to one output pixel. 1 = no downscale. */
  pixelSize: number;
  /** 0 = no color quantization. Otherwise the target palette size (ignored if `palette` is set). */
  colorCount: number;
  /** Optional fixed palette to snap to. Overrides colorCount. */
  palette?: RGB[];
  /** Dither during palette mapping — only meaningful when quantizing. */
  dither: DitherMode;
  /** Alpha above this stays opaque; below becomes fully transparent (0 to disable). */
  alphaThreshold: number;
}

export const DEFAULT_PIXELATE_OPTIONS: PixelateOptions = {
  pixelSize: 4,
  colorCount: 16,
  dither: "none",
  alphaThreshold: 0,
};

export function pixelate(imageData: ImageData, opts: Partial<PixelateOptions> = {}): ImageData {
  const options = { ...DEFAULT_PIXELATE_OPTIONS, ...opts };
  let small = downscale(imageData, Math.max(1, Math.floor(options.pixelSize)));
  if (options.alphaThreshold > 0) small = thresholdAlpha(small, options.alphaThreshold);

  const palette =
    options.palette && options.palette.length > 0
      ? options.palette
      : options.colorCount > 0
        ? medianCut(collectOpaquePixels(small), options.colorCount)
        : null;

  if (palette && palette.length > 0) {
    small = applyPalette(small, palette, options.dither === "floyd-steinberg");
  }
  return small;
}

/** Box-average downscale. Each output pixel averages a `ps×ps` source block. */
export function downscale(src: ImageData, ps: number): ImageData {
  if (ps <= 1) return cloneImageData(src);
  const W = src.width;
  const H = src.height;
  const ow = Math.max(1, Math.floor(W / ps));
  const oh = Math.max(1, Math.floor(H / ps));
  const out = new ImageData(ow, oh);
  const sd = src.data;
  const od = out.data;

  for (let oy = 0; oy < oh; oy++) {
    for (let ox = 0; ox < ow; ox++) {
      let rSum = 0;
      let gSum = 0;
      let bSum = 0;
      let aSum = 0;
      let count = 0;
      const x0 = ox * ps;
      const y0 = oy * ps;
      for (let dy = 0; dy < ps; dy++) {
        const sy = y0 + dy;
        if (sy >= H) break;
        for (let dx = 0; dx < ps; dx++) {
          const sx = x0 + dx;
          if (sx >= W) break;
          const i = (sy * W + sx) * 4;
          const a = sd[i + 3];
          // Pre-multiply by alpha so fully-transparent pixels don't pollute color.
          rSum += sd[i] * a;
          gSum += sd[i + 1] * a;
          bSum += sd[i + 2] * a;
          aSum += a;
          count += 1;
        }
      }
      const oi = (oy * ow + ox) * 4;
      if (aSum > 0) {
        od[oi] = Math.round(rSum / aSum);
        od[oi + 1] = Math.round(gSum / aSum);
        od[oi + 2] = Math.round(bSum / aSum);
        od[oi + 3] = Math.round(aSum / count);
      } else {
        od[oi] = 0;
        od[oi + 1] = 0;
        od[oi + 2] = 0;
        od[oi + 3] = 0;
      }
    }
  }
  return out;
}

function thresholdAlpha(src: ImageData, thresh: number): ImageData {
  const out = cloneImageData(src);
  const d = out.data;
  for (let i = 3; i < d.length; i += 4) {
    d[i] = d[i] > thresh ? 255 : 0;
  }
  return out;
}

function cloneImageData(src: ImageData): ImageData {
  const out = new ImageData(src.width, src.height);
  out.data.set(src.data);
  return out;
}

function collectOpaquePixels(src: ImageData): RGB[] {
  const out: RGB[] = [];
  const d = src.data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] > 0) {
      out.push({ r: d[i], g: d[i + 1], b: d[i + 2] });
    }
  }
  return out;
}

/**
 * Median-cut color quantization. Iteratively splits the largest-range box
 * along its widest channel until we have `target` buckets; each bucket's
 * average is a palette entry.
 */
export function medianCut(pixels: RGB[], target: number): RGB[] {
  if (pixels.length === 0) return [];
  if (target <= 1 || pixels.length <= target) {
    return pixels.length <= target ? [...pixels] : [averageColor(pixels)];
  }

  let boxes: RGB[][] = [pixels];
  while (boxes.length < target) {
    // Pick the box with the biggest channel range.
    let bestIdx = -1;
    let bestRange = -1;
    let bestChan: 0 | 1 | 2 = 0;
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      if (b.length < 2) continue;
      const { chan, range } = widestChannel(b);
      if (range > bestRange) {
        bestRange = range;
        bestIdx = i;
        bestChan = chan;
      }
    }
    if (bestIdx < 0 || bestRange === 0) break;

    const box = boxes[bestIdx];
    const key: "r" | "g" | "b" = bestChan === 0 ? "r" : bestChan === 1 ? "g" : "b";
    box.sort((a, b) => a[key] - b[key]);
    const mid = box.length >> 1;
    const left = box.slice(0, mid);
    const right = box.slice(mid);
    boxes = boxes.slice(0, bestIdx).concat([left, right], boxes.slice(bestIdx + 1));
  }

  return boxes.map(averageColor);
}

function widestChannel(pixels: RGB[]): { chan: 0 | 1 | 2; range: number } {
  let minR = 255,
    maxR = 0,
    minG = 255,
    maxG = 0,
    minB = 255,
    maxB = 0;
  for (const p of pixels) {
    if (p.r < minR) minR = p.r;
    if (p.r > maxR) maxR = p.r;
    if (p.g < minG) minG = p.g;
    if (p.g > maxG) maxG = p.g;
    if (p.b < minB) minB = p.b;
    if (p.b > maxB) maxB = p.b;
  }
  const rRange = maxR - minR;
  const gRange = maxG - minG;
  const bRange = maxB - minB;
  if (rRange >= gRange && rRange >= bRange) return { chan: 0, range: rRange };
  if (gRange >= bRange) return { chan: 1, range: gRange };
  return { chan: 2, range: bRange };
}

function averageColor(pixels: RGB[]): RGB {
  let r = 0;
  let g = 0;
  let b = 0;
  for (const p of pixels) {
    r += p.r;
    g += p.g;
    b += p.b;
  }
  const n = pixels.length || 1;
  return {
    r: Math.round(r / n),
    g: Math.round(g / n),
    b: Math.round(b / n),
  };
}

/**
 * Snap each pixel to the nearest palette color. With dithering, propagates
 * quantization error to neighboring pixels via the Floyd–Steinberg matrix.
 */
export function applyPalette(src: ImageData, palette: RGB[], dither = false): ImageData {
  if (palette.length === 0) return cloneImageData(src);
  const W = src.width;
  const H = src.height;
  const out = new ImageData(W, H);
  const od = out.data;

  // Dithering works on a float buffer so error values can go negative or > 255.
  const buf = new Float32Array(W * H * 3);
  const sd = src.data;
  for (let y = 0, i = 0; y < H; y++) {
    for (let x = 0; x < W; x++, i++) {
      const j = i * 4;
      buf[i * 3] = sd[j];
      buf[i * 3 + 1] = sd[j + 1];
      buf[i * 3 + 2] = sd[j + 2];
      od[j + 3] = sd[j + 3];
    }
  }

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const j = i * 4;
      if (od[j + 3] === 0) {
        od[j] = 0;
        od[j + 1] = 0;
        od[j + 2] = 0;
        continue;
      }
      const r = buf[i * 3];
      const g = buf[i * 3 + 1];
      const b = buf[i * 3 + 2];
      const nearest = nearestColor(r, g, b, palette);
      od[j] = nearest.r;
      od[j + 1] = nearest.g;
      od[j + 2] = nearest.b;

      if (!dither) continue;
      // Floyd–Steinberg: 7/16 right, 3/16 down-left, 5/16 down, 1/16 down-right.
      const errR = r - nearest.r;
      const errG = g - nearest.g;
      const errB = b - nearest.b;
      distribute(buf, W, H, x + 1, y, errR, errG, errB, 7 / 16);
      distribute(buf, W, H, x - 1, y + 1, errR, errG, errB, 3 / 16);
      distribute(buf, W, H, x, y + 1, errR, errG, errB, 5 / 16);
      distribute(buf, W, H, x + 1, y + 1, errR, errG, errB, 1 / 16);
    }
  }

  return out;
}

function distribute(
  buf: Float32Array,
  W: number,
  H: number,
  x: number,
  y: number,
  er: number,
  eg: number,
  eb: number,
  f: number,
) {
  if (x < 0 || x >= W || y < 0 || y >= H) return;
  const i = (y * W + x) * 3;
  buf[i] += er * f;
  buf[i + 1] += eg * f;
  buf[i + 2] += eb * f;
}

function nearestColor(r: number, g: number, b: number, palette: RGB[]): RGB {
  let bestD = Infinity;
  let best = palette[0];
  for (const p of palette) {
    const dr = p.r - r;
    const dg = p.g - g;
    const db = p.b - b;
    const d = dr * dr + dg * dg + db * db;
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return best;
}

/** Upscale an ImageData by integer factor via nearest-neighbor. */
export function upscaleNearest(src: ImageData, factor: number): ImageData {
  const f = Math.max(1, Math.floor(factor));
  if (f === 1) return cloneImageData(src);
  const W = src.width;
  const H = src.height;
  const out = new ImageData(W * f, H * f);
  const sd = src.data;
  const od = out.data;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const si = (y * W + x) * 4;
      const r = sd[si];
      const g = sd[si + 1];
      const b = sd[si + 2];
      const a = sd[si + 3];
      for (let dy = 0; dy < f; dy++) {
        const oy = y * f + dy;
        for (let dx = 0; dx < f; dx++) {
          const ox = x * f + dx;
          const oi = (oy * out.width + ox) * 4;
          od[oi] = r;
          od[oi + 1] = g;
          od[oi + 2] = b;
          od[oi + 3] = a;
        }
      }
    }
  }
  return out;
}

export function hexToRgb(hex: string): RGB {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!m) return { r: 0, g: 0, b: 0 };
  return {
    r: parseInt(m[1], 16),
    g: parseInt(m[2], 16),
    b: parseInt(m[3], 16),
  };
}
