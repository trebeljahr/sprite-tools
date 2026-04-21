// Generate a tangent-space normal map from a sprite. Two source signals:
//
//   - "alpha":     Chamfer distance transform from the sprite's edges. The
//                  interior peaks; gradient points outward. Great for a
//                  rounded/puffy look on hand-drawn characters.
//   - "luminance": Sobel on the perceived brightness. Picks up the sprite's
//                  own highlights and shadows as if they were height.
//
// Modes blend the two via `mix` in [0, 1]. Output is OpenGL-style (Y up) by
// default; set `flipY` for DirectX-style.

export type NormalSource = "alpha" | "luminance" | "mixed";

export interface NormalMapOptions {
  source: NormalSource;
  /** Height scale — larger values = steeper normals. */
  strength: number;
  /** 0 = pure source A, 1 = pure source B; only used when source === "mixed". */
  mix: number;
  /** Flip Y for DirectX-style normal maps. */
  flipY: boolean;
  /** Blur radius in pixels applied to the height map before gradient. */
  blur: number;
}

export const DEFAULT_NORMAL_OPTIONS: NormalMapOptions = {
  source: "alpha",
  strength: 1.0,
  mix: 0.5,
  flipY: false,
  blur: 0,
};

export function generateNormalMap(src: ImageData, opts: Partial<NormalMapOptions> = {}): ImageData {
  const options = { ...DEFAULT_NORMAL_OPTIONS, ...opts };
  const W = src.width;
  const H = src.height;

  let height: Float32Array;
  if (options.source === "alpha") {
    height = alphaDistance(src);
  } else if (options.source === "luminance") {
    height = luminance(src);
  } else {
    const ha = alphaDistance(src);
    const hl = luminance(src);
    height = new Float32Array(W * H);
    const m = options.mix;
    for (let i = 0; i < height.length; i++) {
      height[i] = ha[i] * (1 - m) + hl[i] * m;
    }
  }

  if (options.blur > 0) {
    height = boxBlur(height, W, H, Math.max(1, Math.floor(options.blur)));
  }

  return heightToNormal(height, W, H, src, options.strength, options.flipY);
}

/**
 * Two-pass Chamfer (3-4) distance transform: for each opaque pixel, the
 * approximate Euclidean distance to the nearest transparent pixel, then
 * normalized to [0, 1] by dividing by the max distance.
 */
export function alphaDistance(src: ImageData): Float32Array {
  const W = src.width;
  const H = src.height;
  const d = src.data;
  const INF = 1e9;
  const out = new Float32Array(W * H);
  // Initialize: transparent = 0, opaque = INF.
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    out[p] = d[i + 3] > 10 ? INF : 0;
  }
  // Forward pass (top-left to bottom-right).
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (out[i] === 0) continue;
      let v = out[i];
      if (x > 0) v = Math.min(v, out[i - 1] + 3);
      if (y > 0) v = Math.min(v, out[i - W] + 3);
      if (x > 0 && y > 0) v = Math.min(v, out[i - W - 1] + 4);
      if (x < W - 1 && y > 0) v = Math.min(v, out[i - W + 1] + 4);
      out[i] = v;
    }
  }
  // Backward pass (bottom-right to top-left).
  for (let y = H - 1; y >= 0; y--) {
    for (let x = W - 1; x >= 0; x--) {
      const i = y * W + x;
      if (out[i] === 0) continue;
      let v = out[i];
      if (x < W - 1) v = Math.min(v, out[i + 1] + 3);
      if (y < H - 1) v = Math.min(v, out[i + W] + 3);
      if (x < W - 1 && y < H - 1) v = Math.min(v, out[i + W + 1] + 4);
      if (x > 0 && y < H - 1) v = Math.min(v, out[i + W - 1] + 4);
      out[i] = v;
    }
  }
  // Normalize.
  let max = 0;
  for (let i = 0; i < out.length; i++) if (out[i] > max) max = out[i];
  if (max > 0) for (let i = 0; i < out.length; i++) out[i] /= max;
  return out;
}

export function luminance(src: ImageData): Float32Array {
  const W = src.width;
  const H = src.height;
  const d = src.data;
  const out = new Float32Array(W * H);
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    const a = d[i + 3] / 255;
    // Rec. 709 luma
    const l = (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
    out[p] = l * a; // premul by alpha so transparent pixels stay flat
  }
  return out;
}

function boxBlur(src: Float32Array, W: number, H: number, radius: number): Float32Array {
  const r = radius;
  const tmp = new Float32Array(W * H);
  const out = new Float32Array(W * H);
  // Horizontal.
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let sum = 0;
      let count = 0;
      for (let dx = -r; dx <= r; dx++) {
        const xx = x + dx;
        if (xx < 0 || xx >= W) continue;
        sum += src[y * W + xx];
        count++;
      }
      tmp[y * W + x] = count > 0 ? sum / count : 0;
    }
  }
  // Vertical.
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let sum = 0;
      let count = 0;
      for (let dy = -r; dy <= r; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= H) continue;
        sum += tmp[yy * W + x];
        count++;
      }
      out[y * W + x] = count > 0 ? sum / count : 0;
    }
  }
  return out;
}

/**
 * Convert a height field to an RGBA normal map. Uses central differences for
 * the gradient; encodes as 0x8080ff for flat interior.
 */
export function heightToNormal(
  height: Float32Array,
  W: number,
  H: number,
  src: ImageData,
  strength: number,
  flipY: boolean,
): ImageData {
  const out = new ImageData(W, H);
  const od = out.data;
  const sd = src.data;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const j = i * 4;
      const a = sd[j + 3];
      if (a === 0) {
        od[j] = 128;
        od[j + 1] = 128;
        od[j + 2] = 255;
        od[j + 3] = 0;
        continue;
      }
      const hL = x > 0 ? height[i - 1] : height[i];
      const hR = x < W - 1 ? height[i + 1] : height[i];
      const hU = y > 0 ? height[i - W] : height[i];
      const hD = y < H - 1 ? height[i + W] : height[i];
      const dx = (hR - hL) * 0.5 * strength;
      let dy = (hD - hU) * 0.5 * strength;
      if (flipY) dy = -dy;
      // Normal = normalize(-dx, -dy, 1)
      const nx = -dx;
      const ny = -dy;
      const nz = 1;
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
      od[j] = Math.round(((nx / len) * 0.5 + 0.5) * 255);
      od[j + 1] = Math.round(((ny / len) * 0.5 + 0.5) * 255);
      od[j + 2] = Math.round(((nz / len) * 0.5 + 0.5) * 255);
      od[j + 3] = a; // preserve alpha
    }
  }
  return out;
}
