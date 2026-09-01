// Chroma-key Web Worker.
//
// The main thread posts {bitmap, config}, the worker redraws onto an
// OffscreenCanvas, runs the chroma-key algorithm, and transfers a new
// ImageBitmap back. All heavy pixel work happens off-main.
//
// This file is transport only — the pixel math lives in chroma-core.ts so the
// CLI and MCP server can share it.

import {
  applyChromaKeyToImageData,
  applySolidFillToImageData,
  type ChromaCoreConfig,
  detectBackgroundColor,
} from "./chroma-core";

export { hexToRgb } from "./chroma-core";

export type ChromaWorkerConfig = ChromaCoreConfig;

export type ChromaWorkerRequest = {
  id: number;
  bitmap: ImageBitmap;
  config: ChromaWorkerConfig;
};

export type ChromaWorkerResponse =
  | { id: number; ok: true; bitmap: ImageBitmap }
  | { id: number; ok: false; error: string };

self.onmessage = async (e: MessageEvent<ChromaWorkerRequest>) => {
  const { id, bitmap, config } = e.data;
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("OffscreenCanvas 2D context unavailable");
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close?.();

    const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    if (config.mode === "chroma-solid") {
      applySolidFillToImageData(imgData, config);
    } else {
      applyChromaKeyToImageData(imgData, detectBackgroundColor(imgData), config);
    }
    ctx.putImageData(imgData, 0, 0);

    const out = canvas.transferToImageBitmap();
    const resp: ChromaWorkerResponse = { id, ok: true, bitmap: out };
    (self as unknown as Worker).postMessage(resp, [out]);
  } catch (err) {
    const resp: ChromaWorkerResponse = {
      id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
    (self as unknown as Worker).postMessage(resp);
  }
};
