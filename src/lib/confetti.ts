"use client";

import confetti from "canvas-confetti";

// canvas-confetti's default export animates in a Web Worker on an
// OffscreenCanvas. When the viewport measures 0×0 during a shot (a hidden
// tab or embedding pane, a minimised window, a resize mid-animation), the
// worker falls back to `setCanvasRectSize(canvas)`, which calls
// `getBoundingClientRect()` on the OffscreenCanvas and throws
// "e.getBoundingClientRect is not a function" (catdad/canvas-confetti#164).
// A main-thread cannon on the library-owned canvas sizes itself from
// `document.documentElement` instead and never takes that path; 150
// particles for a few seconds cost nothing on the main thread.
let cannon: confetti.CreateTypes | null = null;

export function fireConfetti(options: confetti.Options): void {
  cannon ??= confetti.create(undefined, { resize: true, useWorker: false });
  void cannon(options);
}
