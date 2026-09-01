// Pure chroma-key pixel math on a plain ImageData-like shape.
//
// Extracted from chroma.worker.ts so the algorithm can be shared between the
// browser worker (which draws onto an OffscreenCanvas) and the Node CLI/MCP
// (which loads via pngjs). No DOM dependencies here.

export type ChromaCoreConfig = {
  mode: "chroma-transparent" | "chroma-solid";
  similarity: number;
  softness: number;
  spill: number;
  choke: number;
  solidColor?: string;
  autoDetermineFillColor?: boolean;
};

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export interface ImageDataLike {
  width: number;
  height: number;
  data: Uint8ClampedArray | Uint8Array;
}

export function hexToRgb(hex: string): Rgb {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return m
    ? { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) }
    : { r: 255, g: 255, b: 255 };
}

// Corner voting: the colour appearing at the most corners wins, falling back
// to the top-left corner when all four differ.
export function detectBackgroundColor(imgData: ImageDataLike): Rgb {
  const d = imgData.data;
  const w = imgData.width;
  const corners = [
    { r: d[0], g: d[1], b: d[2] },
    { r: d[(w - 1) * 4], g: d[(w - 1) * 4 + 1], b: d[(w - 1) * 4 + 2] },
    {
      r: d[d.length - w * 4],
      g: d[d.length - w * 4 + 1],
      b: d[d.length - w * 4 + 2],
    },
    { r: d[d.length - 4], g: d[d.length - 3], b: d[d.length - 2] },
  ];
  const counts: Record<string, { r: number; g: number; b: number; n: number }> = {};
  for (const c of corners) {
    const k = `${c.r},${c.g},${c.b}`;
    counts[k] = counts[k] ? { ...c, n: counts[k].n + 1 } : { ...c, n: 1 };
  }
  let target = corners[0];
  let best = 0;
  for (const k of Object.keys(counts)) {
    if (counts[k].n > best) {
      best = counts[k].n;
      target = counts[k];
    }
  }
  return { r: target.r, g: target.g, b: target.b };
}

// Knocks the background out to transparency. Mutates `imgData.data` in place.
export function applyChromaKeyToImageData(
  imgData: ImageDataLike,
  target: Rgb,
  cfg: ChromaCoreConfig,
): void {
  const width = imgData.width;
  const height = imgData.height;
  const data = imgData.data;
  const { similarity, softness, spill, choke } = cfg;
  const { r: tR, g: tG, b: tB } = target;

  for (let j = 0; j < data.length; j += 4) {
    const r = data[j],
      g = data[j + 1],
      b = data[j + 2];
    const dr = r - tR,
      dg = g - tG,
      db = b - tB;
    const dist = Math.sqrt(dr * dr + dg * dg + db * db);

    let alpha = 1.0;
    if (dist < similarity) alpha = 0;
    else if (dist < similarity + softness) alpha = (dist - similarity) / softness;

    data[j + 3] = Math.min(data[j + 3], alpha * 255);

    if (dist < similarity + softness + spill) {
      const sf = 1 - Math.max(0, Math.min(1, (dist - similarity) / (softness + spill)));
      const gray = (r + g + b) / 3;
      data[j] = r * (1 - sf) + gray * sf;
      data[j + 1] = g * (1 - sf) + gray * sf;
      data[j + 2] = b * (1 - sf) + gray * sf;
    }
  }

  if (choke > 0) {
    const originalAlphas = new Uint8Array(data.length / 4);
    for (let k = 0; k < originalAlphas.length; k++) originalAlphas[k] = data[k * 4 + 3];
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = (y * width + x) * 4;
        if (data[idx + 3] === 0) continue;
        let minAlpha = data[idx + 3];
        for (let dy = -choke; dy <= choke; dy++) {
          for (let dx = -choke; dx <= choke; dx++) {
            const ny = y + dy,
              nx = x + dx;
            if (ny >= 0 && ny < height && nx >= 0 && nx < width) {
              const nAlpha = originalAlphas[ny * width + nx];
              if (nAlpha < minAlpha) minAlpha = nAlpha;
            }
          }
        }
        data[idx + 3] = minAlpha;
      }
    }
  }
}

// Replaces the background with a solid (or corner-sampled gradient) fill,
// keeping the image fully opaque. Mutates `imgData.data` in place.
export function applySolidFillToImageData(imgData: ImageDataLike, cfg: ChromaCoreConfig): void {
  const data = imgData.data;
  const W = imgData.width,
    H = imgData.height;
  const d = data;

  // Sample corner bg
  const tl = { r: d[0], g: d[1], b: d[2] };
  const trI = (W - 1) * 4;
  const tr = { r: d[trI], g: d[trI + 1], b: d[trI + 2] };
  const blI = (H - 1) * W * 4;
  const bl = { r: d[blI], g: d[blI + 1], b: d[blI + 2] };
  const brI = (H * W - 1) * 4;
  const br = { r: d[brI], g: d[brI + 1], b: d[brI + 2] };
  const srcR = Math.round((tl.r + tr.r + bl.r + br.r) / 4);
  const srcG = Math.round((tl.g + tr.g + bl.g + br.g) / 4);
  const srcB = Math.round((tl.b + tr.b + bl.b + br.b) / 4);

  const target = cfg.autoDetermineFillColor
    ? { tl, tr, bl, br }
    : (() => {
        const c = hexToRgb(cfg.solidColor ?? "#ffffff");
        return { tl: c, tr: c, bl: c, br: c };
      })();

  const { similarity, softness } = cfg;
  const mask = new Uint8Array(W * H);
  for (let j = 0, k = 0; j < data.length; j += 4, k++) {
    const dr = data[j] - srcR,
      dg = data[j + 1] - srcG,
      db = data[j + 2] - srcB;
    const dist = Math.sqrt(dr * dr + dg * dg + db * db);
    let m = 255;
    if (dist < similarity) m = 0;
    else if (dist < similarity + softness) m = Math.round(((dist - similarity) / softness) * 255);
    mask[k] = m;
  }

  for (let y = 0, k = 0; y < H; y++) {
    for (let x = 0; x < W; x++, k++) {
      const j = k * 4;
      const m = mask[k] / 255;
      const u = x / (W - 1 || 1);
      const v = y / (H - 1 || 1);
      const topR = target.tl.r * (1 - u) + target.tr.r * u;
      const topG = target.tl.g * (1 - u) + target.tr.g * u;
      const topB = target.tl.b * (1 - u) + target.tr.b * u;
      const botR = target.bl.r * (1 - u) + target.br.r * u;
      const botG = target.bl.g * (1 - u) + target.br.g * u;
      const botB = target.bl.b * (1 - u) + target.br.b * u;
      const fillR = topR * (1 - v) + botR * v;
      const fillG = topG * (1 - v) + botG * v;
      const fillB = topB * (1 - v) + botB * v;
      data[j] = data[j] * m + fillR * (1 - m);
      data[j + 1] = data[j + 1] * m + fillG * (1 - m);
      data[j + 2] = data[j + 2] * m + fillB * (1 - m);
      data[j + 3] = 255;
    }
  }
}
