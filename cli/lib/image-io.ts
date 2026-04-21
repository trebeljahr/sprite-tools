// Node PNG I/O + sprite-sheet slicing / stitching. Pure JS via pngjs so
// there are no native dependencies to install.

import { readFileSync, writeFileSync, statSync } from "node:fs";
import { PNG } from "pngjs";

export function loadPng(path: string): ImageData {
  if (!statSync(path).isFile()) {
    throw new Error(`Not a file: ${path}`);
  }
  const buf = readFileSync(path);
  const png = PNG.sync.read(buf);
  // pngjs gives a Buffer (RGBA) — copy into a Uint8ClampedArray so downstream
  // ImageData-based code sees the exact shape it expects.
  const out = new Uint8ClampedArray(png.data.length);
  out.set(png.data);
  return new ImageData(out, png.width, png.height);
}

export function savePng(img: ImageData, path: string): void {
  const png = new PNG({ width: img.width, height: img.height });
  png.data = Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength);
  writeFileSync(path, PNG.sync.write(png));
}

export function imageToPngBuffer(img: ImageData): Buffer {
  const png = new PNG({ width: img.width, height: img.height });
  png.data = Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength);
  return PNG.sync.write(png);
}

/** Slice a sheet image into cellW×cellH frames in row-major order. */
export function sliceSheet(img: ImageData, cols: number, rows: number): ImageData[] {
  if (cols <= 0 || rows <= 0) return [];
  const cellW = Math.floor(img.width / cols);
  const cellH = Math.floor(img.height / rows);
  if (cellW <= 0 || cellH <= 0) return [];

  const frames: ImageData[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const sub = new ImageData(cellW, cellH);
      for (let y = 0; y < cellH; y++) {
        const srcRowOffset = ((r * cellH + y) * img.width + c * cellW) * 4;
        const dstRowOffset = y * cellW * 4;
        // Row-wise copy: much faster than per-pixel.
        sub.data.set(
          img.data.subarray(srcRowOffset, srcRowOffset + cellW * 4),
          dstRowOffset,
        );
      }
      frames.push(sub);
    }
  }
  return frames;
}

/** Place frames back into a cols×rows grid image. */
export function stitchSheet(
  frames: ImageData[],
  cols: number,
  rows: number,
): ImageData {
  if (frames.length === 0) return new ImageData(1, 1);
  const cellW = frames[0].width;
  const cellH = frames[0].height;
  const out = new ImageData(cellW * cols, cellH * rows);
  for (let i = 0; i < frames.length && i < cols * rows; i++) {
    const r = Math.floor(i / cols);
    const c = i % cols;
    const f = frames[i];
    for (let y = 0; y < cellH; y++) {
      const srcRowOffset = y * cellW * 4;
      const dstRowOffset = ((r * cellH + y) * out.width + c * cellW) * 4;
      out.data.set(
        f.data.subarray(srcRowOffset, srcRowOffset + cellW * 4),
        dstRowOffset,
      );
    }
  }
  return out;
}

/** Upscale an ImageData by an integer factor via nearest-neighbor. */
export function upscaleNearest(img: ImageData, factor: number): ImageData {
  const f = Math.max(1, Math.floor(factor));
  if (f === 1) {
    const clone = new ImageData(img.width, img.height);
    clone.data.set(img.data);
    return clone;
  }
  const out = new ImageData(img.width * f, img.height * f);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const si = (y * img.width + x) * 4;
      const r = img.data[si];
      const g = img.data[si + 1];
      const b = img.data[si + 2];
      const a = img.data[si + 3];
      for (let dy = 0; dy < f; dy++) {
        for (let dx = 0; dx < f; dx++) {
          const di = ((y * f + dy) * out.width + (x * f + dx)) * 4;
          out.data[di] = r;
          out.data[di + 1] = g;
          out.data[di + 2] = b;
          out.data[di + 3] = a;
        }
      }
    }
  }
  return out;
}
