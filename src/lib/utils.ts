import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export type BackgroundMode = "chroma-transparent" | "chroma-solid" | "transparent-cutout";

export interface ChromaKeySettings {
  similarity: number;
  softness: number;
  spill: number;
  choke: number;
  backgroundColor?: string;
}

export function sampleBackground(image: HTMLImageElement, points?: { x: number; y: number }[]) {
  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  const ctx = canvas.getContext("2d");
  if (!ctx)
    return {
      r: 255,
      g: 255,
      b: 255,
      corners: {
        tl: { r: 255, g: 255, b: 255 },
        tr: { r: 255, g: 255, b: 255 },
        bl: { r: 255, g: 255, b: 255 },
        br: { r: 255, g: 255, b: 255 },
      },
    };
  ctx.drawImage(image, 0, 0);

  const getPixel = (x: number, y: number) => {
    const d = ctx.getImageData(Math.floor(x), Math.floor(y), 1, 1).data;
    return { r: d[0], g: d[1], b: d[2] };
  };

  const corners = {
    tl: getPixel(0, 0),
    tr: getPixel(image.width - 1, 0),
    bl: getPixel(0, image.height - 1),
    br: getPixel(image.width - 1, image.height - 1),
  };

  let r, g, b;
  if (points && points.length > 0) {
    let sr = 0,
      sg = 0,
      sb = 0;
    points.forEach((p) => {
      const pix = getPixel(
        Math.max(0, Math.min(image.width - 1, p.x)),
        Math.max(0, Math.min(image.height - 1, p.y)),
      );
      sr += pix.r;
      sg += pix.g;
      sb += pix.b;
    });
    r = Math.round(sr / points.length);
    g = Math.round(sg / points.length);
    b = Math.round(sb / points.length);
  } else {
    r = Math.round((corners.tl.r + corners.tr.r + corners.bl.r + corners.br.r) / 4);
    g = Math.round((corners.tl.g + corners.tr.g + corners.bl.g + corners.br.g) / 4);
    b = Math.round((corners.tl.b + corners.tr.b + corners.bl.b + corners.br.b) / 4);
  }

  return { r, g, b, corners };
}

export function hexToRgb(hex: string) {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result
    ? {
        r: parseInt(result[1], 16),
        g: parseInt(result[2], 16),
        b: parseInt(result[3], 16),
      }
    : { r: 255, g: 255, b: 255 };
}

export function applyChromaKey(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  target: { r: number; g: number; b: number },
  settings: ChromaKeySettings,
) {
  const imageData = ctx.getImageData(0, 0, width, height);
  const data = imageData.data;
  const { similarity, softness, spill, choke } = settings;
  const targetR = target.r,
    targetG = target.g,
    targetB = target.b;

  for (let j = 0; j < data.length; j += 4) {
    const r = data[j],
      g = data[j + 1],
      b = data[j + 2];
    const dist = Math.sqrt((r - targetR) ** 2 + (g - targetG) ** 2 + (b - targetB) ** 2);

    let alpha = 1.0;
    if (dist < similarity) alpha = 0;
    else if (dist < similarity + softness) {
      alpha = (dist - similarity) / softness;
    }

    // Apply transparency to alpha channel
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
  ctx.putImageData(imageData, 0, 0);
}

export function applySolidFillChroma(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  source: { r: number; g: number; b: number },
  target: { r: number; g: number; b: number },
  settings: ChromaKeySettings,
) {
  const imageData = ctx.getImageData(0, 0, width, height);
  const data = imageData.data;
  const { similarity, softness, spill } = settings;
  const srcR = source.r,
    srcG = source.g,
    srcB = source.b;
  const tgtR = target.r,
    tgtG = target.g,
    tgtB = target.b;

  for (let j = 0; j < data.length; j += 4) {
    const r = data[j],
      g = data[j + 1],
      b = data[j + 2];
    const dist = Math.sqrt((r - srcR) ** 2 + (g - srcG) ** 2 + (b - srcB) ** 2);

    let alpha = 1.0;
    if (dist < similarity) alpha = 0;
    else if (dist < similarity + softness) {
      alpha = (dist - similarity) / softness;
    }

    // Apply spill reduction (to gray) before blending
    let finalR = r,
      finalG = g,
      finalB = b;
    if (dist < similarity + softness + spill) {
      const sf = 1 - Math.max(0, Math.min(1, (dist - similarity) / (softness + spill)));
      const gray = (r + g + b) / 3;
      finalR = r * (1 - sf) + gray * sf;
      finalG = g * (1 - sf) + gray * sf;
      finalB = b * (1 - sf) + gray * sf;
    }

    // Blend with target solid color
    data[j] = finalR * alpha + tgtR * (1 - alpha);
    data[j + 1] = finalG * alpha + tgtG * (1 - alpha);
    data[j + 2] = finalB * alpha + tgtB * (1 - alpha);
    data[j + 3] = 255; // Always solid
  }
  ctx.putImageData(imageData, 0, 0);
}
