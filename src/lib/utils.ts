import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export interface ChromaKeySettings {
  similarity: number;
  softness: number;
  spill: number;
  choke: number;
}

export function sampleBackground(image: HTMLImageElement, points?: { x: number, y: number }[]) {
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return { r: 255, g: 255, b: 255 };
  ctx.drawImage(image, 0, 0);

  let samples: Uint8ClampedArray[] = [];

  if (points && points.length > 0) {
    points.forEach(p => {
      const x = Math.max(0, Math.min(image.width - 1, Math.round(p.x)));
      const y = Math.max(0, Math.min(image.height - 1, Math.round(p.y)));
      samples.push(ctx.getImageData(x, y, 1, 1).data);
    });
  } else {
    samples = [
      ctx.getImageData(0, 0, 1, 1).data,
      ctx.getImageData(image.width - 1, 0, 1, 1).data,
      ctx.getImageData(0, image.height - 1, 1, 1).data,
      ctx.getImageData(image.width - 1, image.height - 1, 1, 1).data
    ];
  }

  const r = Math.round(samples.reduce((acc, c) => acc + c[0], 0) / samples.length);
  const g = Math.round(samples.reduce((acc, c) => acc + c[1], 0) / samples.length);
  const b = Math.round(samples.reduce((acc, c) => acc + c[2], 0) / samples.length);

  return { r, g, b };
}

export function applyChromaKey(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  target: { r: number, g: number, b: number },
  settings: ChromaKeySettings
) {
  const imageData = ctx.getImageData(0, 0, width, height);
  const data = imageData.data;
  const { similarity, softness, spill, choke } = settings;
  const targetR = target.r, targetG = target.g, targetB = target.b;

  for (let j = 0; j < data.length; j += 4) {
    const r = data[j], g = data[j + 1], b = data[j + 2];
    const dist = Math.sqrt(
      Math.pow(r - targetR, 2) + Math.pow(g - targetG, 2) + Math.pow(b - targetB, 2)
    );
    if (dist < similarity) data[j + 3] = 0;
    else if (dist < similarity + softness) {
      data[j + 3] = Math.min(data[j + 3], ((dist - similarity) / softness) * 255);
    }
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
            const ny = y + dy, nx = x + dx;
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

