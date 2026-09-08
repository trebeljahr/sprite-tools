// Raster outline + drop shadow off a single alpha pass.
//
// Deliberately NOT built on generateOutline() from ../collision/outline.ts. That
// one does Moore-neighbour contour tracing and returns a *simplified polygon* for
// the first connected component only — it drops interior holes and disconnected
// islands, and it lives in vector space. A raster outline has to cover every
// component and every hole at exact pixel distances, so the right primitive is a
// bounded multi-source BFS over the alpha mask (a distance transform capped at the
// outline width). One pass yields the outer band, the inner band and the shadow
// silhouette. Same boundary concept, different consumer.
//
// Anti-aliasing: the outer band is painted first and the sprite is composited
// source-over on top, so soft edge pixels (alpha below the mask threshold but
// above 0) blend over the outline instead of punching a hole in it — no dark
// halo, no hard AA cut. Raise alphaThreshold to pull the outline inward past soft
// edges, lower it to hug them.
//
// Overflow: outer outlines and shadows grow the sprite, and silently cropping
// someone's art is the worst possible default, so "expand" pads the canvas by
// requiredMargin(). "clip" keeps the original size and lets the effect run off
// the edge — which is what you want when a frame has to stay a fixed cell size.
// requiredMargin() depends only on the options, never on the pixels, so every
// frame of a sheet expands identically.
//
// No DOM here: structurally typed on {width, height, data} like ../pipeline/chroma-core.ts.

export interface ImageDataLike {
  width: number;
  height: number;
  data: Uint8ClampedArray | Uint8Array;
}

export type Connectivity = 4 | 8;
export type OutlineStyle = "outer" | "inner";
export type OverflowMode = "expand" | "clip";

export interface Margin {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface OutlineOptions {
  /** "outer" grows past the silhouette, "inner" eats into it. */
  style: OutlineStyle;
  /** Band thickness in pixels. 0 disables the band. */
  width: number;
  /** Band colour as hex. */
  color: string;
  /** 0..1, applied when the band is composited. */
  opacity: number;
  /** 4 = Manhattan growth (mitred corners), 8 = Chebyshev (square corners). */
  connectivity: Connectivity;
  /** A pixel counts as sprite when alpha > this. */
  alphaThreshold: number;
}

export interface ShadowOptions {
  offsetX: number;
  offsetY: number;
  color: string;
  /** 0..1 multiplier on the blurred silhouette. */
  opacity: number;
  /** Box-blur radius in pixels. 0 = hard shadow. */
  blur: number;
  alphaThreshold: number;
}

export const DEFAULT_OUTLINE_FX_OPTIONS: OutlineOptions = {
  style: "outer",
  width: 1,
  color: "#000000",
  opacity: 1,
  connectivity: 8,
  alphaThreshold: 8,
};

export const DEFAULT_SHADOW_OPTIONS: ShadowOptions = {
  offsetX: 2,
  offsetY: 2,
  color: "#000000",
  opacity: 0.5,
  blur: 0,
  alphaThreshold: 8,
};

export interface OutlineFxConfig {
  /** null/undefined = no outline. */
  outline?: Partial<OutlineOptions> | null;
  /** null/undefined = no shadow. */
  shadow?: Partial<ShadowOptions> | null;
  overflow?: OverflowMode;
  /** Override the computed margin — callers pass one margin for every frame of a
   *  sheet so all cells stay the same size. Ignored when overflow === "clip". */
  margin?: Margin;
}

export interface OutlineFxResult {
  width: number;
  height: number;
  data: Uint8ClampedArray;
  /** Where the source sprite's (0,0) landed in the output. */
  offsetX: number;
  offsetY: number;
  margin: Margin;
}

/** Sentinel for "further than maxDist" in the bounded distance transform. */
const UNREACHED = 0xffff;

const OFFSETS_4 = new Int8Array([0, -1, -1, 0, 1, 0, 0, 1]);
const OFFSETS_8 = new Int8Array([0, -1, -1, 0, 1, 0, 0, 1, -1, -1, 1, -1, -1, 1, 1, 1]);

const ZERO_MARGIN: Margin = { left: 0, top: 0, right: 0, bottom: 0 };

export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const s = hex.trim().replace(/^#/, "");
  if (/^[a-f\d]{3}$/i.test(s)) {
    const r = parseInt(s[0] + s[0], 16);
    const g = parseInt(s[1] + s[1], 16);
    const b = parseInt(s[2] + s[2], 16);
    return { r, g, b };
  }
  if (/^[a-f\d]{6}$/i.test(s)) {
    return {
      r: parseInt(s.slice(0, 2), 16),
      g: parseInt(s.slice(2, 4), 16),
      b: parseInt(s.slice(4, 6), 16),
    };
  }
  // Outline/shadow colours default to black, so an unparseable hex falls back there.
  return { r: 0, g: 0, b: 0 };
}

export function buildAlphaMask(img: ImageDataLike, alphaThreshold: number): Uint8Array {
  return alphaMaskInto(img, alphaThreshold, img.width, img.height, 0, 0);
}

/**
 * Bounded multi-source BFS. Returns per-pixel distance (in steps) from the nearest
 * mask pixel, 0 inside the mask, 0xffff beyond maxDist.
 */
export function distanceFromMask(
  mask: Uint8Array,
  width: number,
  height: number,
  maxDist: number,
  connectivity: Connectivity,
): Uint16Array {
  const n = Math.max(0, width * height);
  const dist = new Uint16Array(n);
  dist.fill(UNREACHED);
  if (n === 0) return dist;

  const queue = new Int32Array(n);
  let tail = 0;
  for (let i = 0; i < n; i++) {
    if (mask[i]) {
      dist[i] = 0;
      queue[tail++] = i;
    }
  }
  runBfs(dist, queue, tail, width, height, maxDist, connectivity);
  return dist;
}

/** Margin needed so nothing is clipped. Depends only on options, never on pixels —
 *  so every frame in a sheet expands identically. */
export function requiredMargin(cfg: OutlineFxConfig): Margin {
  const outline = cfg.outline ? normalizeOutline(cfg.outline) : null;
  const shadow = cfg.shadow ? normalizeShadow(cfg.shadow) : null;

  // Only an outer band pushes past the silhouette; an inner one never does.
  const footprint = outline && outline.style === "outer" ? outline.width : 0;

  let left = footprint;
  let top = footprint;
  let right = footprint;
  let bottom = footprint;

  if (shadow) {
    const spread = shadow.blur + footprint;
    left = Math.max(left, Math.max(0, -shadow.offsetX) + spread);
    right = Math.max(right, Math.max(0, shadow.offsetX) + spread);
    top = Math.max(top, Math.max(0, -shadow.offsetY) + spread);
    bottom = Math.max(bottom, Math.max(0, shadow.offsetY) + spread);
  }

  return {
    left: Math.ceil(left),
    top: Math.ceil(top),
    right: Math.ceil(right),
    bottom: Math.ceil(bottom),
  };
}

/** The one entry point. Never mutates the input. */
export function applyOutlineFx(img: ImageDataLike, cfg: OutlineFxConfig): OutlineFxResult {
  if (img.width <= 0 || img.height <= 0) {
    return {
      width: 0,
      height: 0,
      data: new Uint8ClampedArray(0),
      offsetX: 0,
      offsetY: 0,
      margin: { ...ZERO_MARGIN },
    };
  }

  const outline = cfg.outline ? normalizeOutline(cfg.outline) : null;
  const shadow = cfg.shadow ? normalizeShadow(cfg.shadow) : null;
  const overflow: OverflowMode = cfg.overflow === "clip" ? "clip" : "expand";

  const margin =
    overflow === "clip"
      ? { ...ZERO_MARGIN }
      : cfg.margin
        ? sanitizeMargin(cfg.margin)
        : requiredMargin({ outline: cfg.outline, shadow: cfg.shadow });

  const outW = img.width + margin.left + margin.right;
  const outH = img.height + margin.top + margin.bottom;
  const ox = margin.left;
  const oy = margin.top;
  const out = new Uint8ClampedArray(outW * outH * 4);

  const drawsBand = outline !== null && outline.width > 0 && outline.opacity > 0;
  const outerWidth = outline && outline.style === "outer" ? outline.width : 0;

  // The outline mask doubles as the inner-band source, so build it once.
  const outlineMask = outline
    ? alphaMaskInto(img, outline.alphaThreshold, outW, outH, ox, oy)
    : null;

  // 1. Shadow, underneath everything.
  if (shadow && shadow.opacity > 0) {
    const base =
      outline && outline.alphaThreshold === shadow.alphaThreshold && outlineMask
        ? outlineMask
        : alphaMaskInto(img, shadow.alphaThreshold, outW, outH, ox, oy);
    const conn: Connectivity = outline ? outline.connectivity : 8;
    // The silhouette is the final opaque footprint: sprite grown by the outer band.
    const grown =
      outerWidth > 0 && drawsBand ? distanceFromMask(base, outW, outH, outerWidth, conn) : null;

    const field = new Float32Array(outW * outH);
    for (let y = 0; y < outH; y++) {
      const sy = y - shadow.offsetY;
      if (sy < 0 || sy >= outH) continue;
      for (let x = 0; x < outW; x++) {
        const sx = x - shadow.offsetX;
        if (sx < 0 || sx >= outW) continue;
        const si = sy * outW + sx;
        const inside = grown ? grown[si] <= outerWidth : base[si] === 1;
        if (inside) field[y * outW + x] = 1;
      }
    }
    if (shadow.blur > 0) boxBlur(field, outW, outH, shadow.blur);

    const { r, g, b } = hexToRgb(shadow.color);
    for (let i = 0, j = 0; i < field.length; i++, j += 4) {
      const a = field[i] * shadow.opacity;
      if (a <= 0) continue;
      out[j] = r;
      out[j + 1] = g;
      out[j + 2] = b;
      out[j + 3] = Math.round(Math.min(1, a) * 255);
    }
  }

  // 2. Outer band, under the sprite so anti-aliased edges blend over it.
  if (drawsBand && outline && outlineMask && outline.style === "outer") {
    const dist = distanceFromMask(outlineMask, outW, outH, outline.width, outline.connectivity);
    const { r, g, b } = hexToRgb(outline.color);
    for (let i = 0; i < dist.length; i++) {
      const d = dist[i];
      if (d >= 1 && d <= outline.width) compositeOver(out, i * 4, r, g, b, outline.opacity);
    }
  }

  // 3. The sprite itself.
  const src = img.data;
  for (let y = 0; y < img.height; y++) {
    const srcRow = y * img.width * 4;
    const dstRow = (y + oy) * outW + ox;
    for (let x = 0; x < img.width; x++) {
      const si = srcRow + x * 4;
      const a = src[si + 3];
      if (a === 0) continue;
      compositeOver(out, (dstRow + x) * 4, src[si], src[si + 1], src[si + 2], a / 255);
    }
  }

  // 4. Inner band, over the sprite edge. Never touches the bounding box.
  if (drawsBand && outline && outlineMask && outline.style === "inner") {
    const dist = distanceFromOutside(outlineMask, outW, outH, outline.width, outline.connectivity);
    const { r, g, b } = hexToRgb(outline.color);
    for (let i = 0; i < dist.length; i++) {
      const d = dist[i];
      if (d >= 1 && d <= outline.width) compositeOver(out, i * 4, r, g, b, outline.opacity);
    }
  }

  return { width: outW, height: outH, data: out, offsetX: ox, offsetY: oy, margin };
}

// --- internals ---------------------------------------------------------------

function normalizeOutline(opts: Partial<OutlineOptions>): OutlineOptions {
  const merged = { ...DEFAULT_OUTLINE_FX_OPTIONS, ...opts };
  return {
    style: merged.style === "inner" ? "inner" : "outer",
    width: Math.max(0, Math.round(toNumber(merged.width, DEFAULT_OUTLINE_FX_OPTIONS.width))),
    color: typeof merged.color === "string" ? merged.color : DEFAULT_OUTLINE_FX_OPTIONS.color,
    opacity: clamp(toNumber(merged.opacity, DEFAULT_OUTLINE_FX_OPTIONS.opacity), 0, 1),
    connectivity: merged.connectivity === 4 ? 4 : 8,
    alphaThreshold: clamp(
      Math.round(toNumber(merged.alphaThreshold, DEFAULT_OUTLINE_FX_OPTIONS.alphaThreshold)),
      0,
      255,
    ),
  };
}

function normalizeShadow(opts: Partial<ShadowOptions>): ShadowOptions {
  const merged = { ...DEFAULT_SHADOW_OPTIONS, ...opts };
  return {
    offsetX: Math.round(toNumber(merged.offsetX, DEFAULT_SHADOW_OPTIONS.offsetX)),
    offsetY: Math.round(toNumber(merged.offsetY, DEFAULT_SHADOW_OPTIONS.offsetY)),
    color: typeof merged.color === "string" ? merged.color : DEFAULT_SHADOW_OPTIONS.color,
    opacity: clamp(toNumber(merged.opacity, DEFAULT_SHADOW_OPTIONS.opacity), 0, 1),
    blur: Math.max(0, Math.round(toNumber(merged.blur, DEFAULT_SHADOW_OPTIONS.blur))),
    alphaThreshold: clamp(
      Math.round(toNumber(merged.alphaThreshold, DEFAULT_SHADOW_OPTIONS.alphaThreshold)),
      0,
      255,
    ),
  };
}

function toNumber(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, lo: number, hi: number): number {
  return value < lo ? lo : value > hi ? hi : value;
}

function sanitizeMargin(m: Margin): Margin {
  return {
    left: Math.max(0, Math.ceil(toNumber(m.left, 0))),
    top: Math.max(0, Math.ceil(toNumber(m.top, 0))),
    right: Math.max(0, Math.ceil(toNumber(m.right, 0))),
    bottom: Math.max(0, Math.ceil(toNumber(m.bottom, 0))),
  };
}

/** Alpha mask of `img` painted into an (outW × outH) grid at (ox, oy). */
function alphaMaskInto(
  img: ImageDataLike,
  alphaThreshold: number,
  outW: number,
  outH: number,
  ox: number,
  oy: number,
): Uint8Array {
  const mask = new Uint8Array(Math.max(0, outW * outH));
  const d = img.data;
  for (let y = 0; y < img.height; y++) {
    const dy = y + oy;
    if (dy < 0 || dy >= outH) continue;
    const srcRow = y * img.width * 4;
    const dstRow = dy * outW;
    for (let x = 0; x < img.width; x++) {
      const dx = x + ox;
      if (dx < 0 || dx >= outW) continue;
      if (d[srcRow + x * 4 + 3] > alphaThreshold) mask[dstRow + dx] = 1;
    }
  }
  return mask;
}

/**
 * Distance from the background into the mask — the mirror of distanceFromMask.
 * Off-canvas counts as background, so a sprite touching the frame edge still gets
 * an inner outline there; that keeps the result identical whether or not an
 * unrelated shadow happened to expand the canvas.
 */
function distanceFromOutside(
  mask: Uint8Array,
  width: number,
  height: number,
  maxDist: number,
  connectivity: Connectivity,
): Uint16Array {
  const n = Math.max(0, width * height);
  const dist = new Uint16Array(n);
  dist.fill(UNREACHED);
  if (n === 0) return dist;

  const queue = new Int32Array(n);
  let tail = 0;
  for (let i = 0; i < n; i++) {
    if (!mask[i]) {
      dist[i] = 0;
      queue[tail++] = i;
    }
  }
  // Border seeds go in after every distance-0 seed so the queue stays sorted by
  // distance, which is what makes the plain FIFO BFS correct.
  if (maxDist > 0) {
    const seedBorder = (i: number) => {
      if (mask[i] && dist[i] === UNREACHED) {
        dist[i] = 1;
        queue[tail++] = i;
      }
    };
    for (let x = 0; x < width; x++) {
      seedBorder(x);
      seedBorder((height - 1) * width + x);
    }
    for (let y = 0; y < height; y++) {
      seedBorder(y * width);
      seedBorder(y * width + width - 1);
    }
  }
  runBfs(dist, queue, tail, width, height, maxDist, connectivity);
  return dist;
}

/** Flat-queue BFS over a pre-seeded distance field. Stops growing at maxDist. */
function runBfs(
  dist: Uint16Array,
  queue: Int32Array,
  tail: number,
  width: number,
  height: number,
  maxDist: number,
  connectivity: Connectivity,
): void {
  if (maxDist <= 0) return;
  const offsets = connectivity === 4 ? OFFSETS_4 : OFFSETS_8;
  let head = 0;
  let end = tail;
  while (head < end) {
    const idx = queue[head++];
    const d = dist[idx];
    if (d >= maxDist) continue;
    const x = idx % width;
    const y = (idx - x) / width;
    const nd = d + 1;
    for (let k = 0; k < offsets.length; k += 2) {
      const nx = x + offsets[k];
      const ny = y + offsets[k + 1];
      if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
      const ni = ny * width + nx;
      if (dist[ni] !== UNREACHED) continue;
      dist[ni] = nd;
      queue[end++] = ni;
    }
  }
}

/**
 * Three separable box passes ≈ a gaussian. The radii sum to `radius` so the
 * shadow's total support is exactly `radius` px — which is what requiredMargin
 * reserves for it. Mutates `field` in place.
 */
function boxBlur(field: Float32Array, width: number, height: number, radius: number): void {
  const base = Math.floor(radius / 3);
  const rest = radius - base * 3;
  const radii = [base + (rest > 0 ? 1 : 0), base + (rest > 1 ? 1 : 0), base];
  const scratch = new Float32Array(field.length);
  for (const r of radii) {
    if (r <= 0) continue;
    boxPassH(field, scratch, width, height, r);
    boxPassV(scratch, field, width, height, r);
  }
}

// Both passes treat everything outside the canvas as 0 (transparent), so a shadow
// fades out at the border instead of smearing the edge value.
function boxPassH(
  src: Float32Array,
  dst: Float32Array,
  width: number,
  height: number,
  r: number,
): void {
  const win = 2 * r + 1;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    let sum = 0;
    for (let i = 0; i <= r && i < width; i++) sum += src[row + i];
    for (let x = 0; x < width; x++) {
      dst[row + x] = sum / win;
      const add = x + r + 1;
      const drop = x - r;
      if (add < width) sum += src[row + add];
      if (drop >= 0) sum -= src[row + drop];
    }
  }
}

function boxPassV(
  src: Float32Array,
  dst: Float32Array,
  width: number,
  height: number,
  r: number,
): void {
  const win = 2 * r + 1;
  for (let x = 0; x < width; x++) {
    let sum = 0;
    for (let i = 0; i <= r && i < height; i++) sum += src[i * width + x];
    for (let y = 0; y < height; y++) {
      dst[y * width + x] = sum / win;
      const add = y + r + 1;
      const drop = y - r;
      if (add < height) sum += src[add * width + x];
      if (drop >= 0) sum -= src[drop * width + x];
    }
  }
}

/** Straight-alpha source-over of one colour onto the RGBA buffer at byte `i`. */
function compositeOver(
  dst: Uint8ClampedArray,
  i: number,
  r: number,
  g: number,
  b: number,
  alpha: number,
): void {
  if (alpha <= 0) return;
  const da = dst[i + 3] / 255;
  const oa = alpha + da * (1 - alpha);
  if (oa <= 0) return;
  const keep = (da * (1 - alpha)) / oa;
  const take = alpha / oa;
  dst[i] = r * take + dst[i] * keep;
  dst[i + 1] = g * take + dst[i + 1] * keep;
  dst[i + 2] = b * take + dst[i + 2] * keep;
  dst[i + 3] = Math.round(oa * 255);
}
