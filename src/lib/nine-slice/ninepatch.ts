// Android .9.png border encoding/decoding on a plain ImageData-like shape.
//
// The convention (as implemented by AAPT):
//   * A .9.png is the content image plus a 1px border on all four sides, so the
//     encoded size is content (w+2) x (h+2).
//   * Border marks are opaque black (0,0,0,255); every other border pixel is
//     fully transparent. The four corner pixels of the border are unused and
//     must stay transparent.
//   * TOP border row: a black run marks the horizontally stretchable X range.
//   * LEFT border column: a black run marks the vertically stretchable Y range.
//   * BOTTOM border row: a black run marks the horizontal padding/content box.
//   * RIGHT border column: a black run marks the vertical padding/content box.
//     Both padding edges are optional.
//
// LIMITATION: AAPT allows several stretch runs per edge. We support exactly ONE
// contiguous run per edge, because that is what maps onto the four insets this
// toolkit works with. A multi-run .9.png is rejected rather than silently
// reinterpreted.

import { clampInsets, type ImageDataLike, type NineSliceInsets } from "./nine-slice";

export interface NinePatchDecodeResult {
  /** The (w-2) x (h-2) interior. */
  content: ImageData;
  /** Derived from the top row + left column runs. */
  insets: NineSliceInsets;
  /** From the bottom row + right column, null if unmarked. */
  padding: NineSliceInsets | null;
}

type BorderPixel = "transparent" | "mark" | "invalid";

/**
 * Alpha 0 counts as transparent whatever the RGB says (exporters happily leave
 * garbage colour under transparent pixels); a mark has to be exactly opaque
 * black.
 */
function classify(data: Uint8ClampedArray | Uint8Array, i: number): BorderPixel {
  const a = data[i + 3];
  if (a === 0) return "transparent";
  if (a === 255 && data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 0) return "mark";
  return "invalid";
}

/** Contiguous runs of `true` in a flag array. */
function runsOf(flags: boolean[]): Array<{ start: number; end: number }> {
  const runs: Array<{ start: number; end: number }> = [];
  let start = -1;
  for (let i = 0; i <= flags.length; i++) {
    if (i < flags.length && flags[i]) {
      if (start < 0) start = i;
      continue;
    }
    if (start >= 0) {
      runs.push({ start, end: i - 1 });
      start = -1;
    }
  }
  return runs;
}

/** Marker flags along the top (y=0) or bottom (y=h-1) border row, in content coords. */
function rowMarks(img: ImageDataLike, y: number): BorderPixel[] {
  const out: BorderPixel[] = [];
  for (let x = 1; x < img.width - 1; x++) out.push(classify(img.data, (y * img.width + x) * 4));
  return out;
}

/** Marker flags along the left (x=0) or right (x=w-1) border column, in content coords. */
function columnMarks(img: ImageDataLike, x: number): BorderPixel[] {
  const out: BorderPixel[] = [];
  for (let y = 1; y < img.height - 1; y++) out.push(classify(img.data, (y * img.width + x) * 4));
  return out;
}

/**
 * True if the image plausibly carries a .9.png border (>=3x3, every border
 * pixel either fully transparent or opaque black, and at least one marker on
 * the top row and on the left column). Cheap pre-check before decodeNinePatch —
 * the marker requirement is what keeps an ordinary sprite with transparent
 * padding from looking like a nine-patch.
 */
export function isNinePatchCandidate(img: ImageDataLike): boolean {
  const { width: w, height: h } = img;
  if (w < 3 || h < 3) return false;

  const edges = [
    rowMarks(img, 0),
    rowMarks(img, h - 1),
    columnMarks(img, 0),
    columnMarks(img, w - 1),
  ];
  for (const edge of edges) {
    if (edge.some((p) => p === "invalid")) return false;
  }
  const corners = [0, (w - 1) * 4, (h - 1) * w * 4, (h * w - 1) * 4];
  for (const i of corners) {
    if (classify(img.data, i) !== "transparent") return false;
  }
  return edges[0].includes("mark") && edges[2].includes("mark");
}

type Run = { start: number; end: number };

function singleRun(marks: BorderPixel[], edgeName: string): Run | null {
  const invalid = marks.indexOf("invalid");
  if (invalid >= 0) {
    throw new Error(
      `decodeNinePatch: ${edgeName} border pixel ${invalid} is neither fully transparent nor opaque black`,
    );
  }
  const runs = runsOf(marks.map((m) => m === "mark"));
  if (runs.length === 0) return null;
  if (runs.length > 1) {
    throw new Error(
      `decodeNinePatch: ${edgeName} border has ${runs.length} black runs; only a single contiguous run is supported`,
    );
  }
  return runs[0];
}

function requiredRun(marks: BorderPixel[], edgeName: string): Run {
  const run = singleRun(marks, edgeName);
  if (!run) {
    throw new Error(`decodeNinePatch: ${edgeName} border has no black stretch run`);
  }
  return run;
}

/** Throws a descriptive Error if the border is malformed or has no stretch run. */
export function decodeNinePatch(img: ImageDataLike): NinePatchDecodeResult {
  const { width: w, height: h } = img;
  if (w < 3 || h < 3) {
    throw new Error(
      `decodeNinePatch: image is ${w}x${h}; a .9.png needs at least 3x3 (1px border + 1px content)`,
    );
  }

  const cornerNames = ["top-left", "top-right", "bottom-left", "bottom-right"];
  const corners = [0, (w - 1) * 4, (h - 1) * w * 4, (h * w - 1) * 4];
  for (let i = 0; i < corners.length; i++) {
    if (classify(img.data, corners[i]) !== "transparent") {
      throw new Error(
        `decodeNinePatch: ${cornerNames[i]} border corner is not transparent; corner pixels are unused in a .9.png`,
      );
    }
  }

  const contentWidth = w - 2;
  const contentHeight = h - 2;
  const xRun = requiredRun(rowMarks(img, 0), "top");
  const yRun = requiredRun(columnMarks(img, 0), "left");
  const padXRun = singleRun(rowMarks(img, h - 1), "bottom");
  const padYRun = singleRun(columnMarks(img, w - 1), "right");

  const insets: NineSliceInsets = {
    left: xRun.start,
    right: contentWidth - (xRun.end + 1),
    top: yRun.start,
    bottom: contentHeight - (yRun.end + 1),
  };

  const padding: NineSliceInsets | null =
    padXRun || padYRun
      ? {
          left: padXRun ? padXRun.start : 0,
          right: padXRun ? contentWidth - (padXRun.end + 1) : 0,
          top: padYRun ? padYRun.start : 0,
          bottom: padYRun ? contentHeight - (padYRun.end + 1) : 0,
        }
      : null;

  const content = new ImageData(contentWidth, contentHeight);
  for (let y = 0; y < contentHeight; y++) {
    for (let x = 0; x < contentWidth; x++) {
      const s = ((y + 1) * w + (x + 1)) * 4;
      const d = (y * contentWidth + x) * 4;
      content.data[d] = img.data[s];
      content.data[d + 1] = img.data[s + 1];
      content.data[d + 2] = img.data[s + 2];
      content.data[d + 3] = img.data[s + 3];
    }
  }

  return { content, insets, padding };
}

/** Paint an opaque-black run of border pixels. */
function paintRun(out: ImageData, from: number, to: number, toIndex: (i: number) => number): void {
  for (let i = from; i <= to; i++) {
    const d = toIndex(i);
    out.data[d] = 0;
    out.data[d + 1] = 0;
    out.data[d + 2] = 0;
    out.data[d + 3] = 255;
  }
}

/**
 * Wrap content in a 1px marker border encoding insets (and padding if given).
 * Insets are clamped so the stretch run always keeps at least one pixel —
 * otherwise the result would be a .9.png that decodeNinePatch rejects.
 */
export function encodeNinePatch(
  content: ImageDataLike,
  insets: NineSliceInsets,
  padding?: NineSliceInsets | null,
): ImageData {
  const cw = content.width;
  const ch = content.height;
  const w = cw + 2;
  const h = ch + 2;
  const out = new ImageData(w, h);

  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const s = (y * cw + x) * 4;
      const d = ((y + 1) * w + (x + 1)) * 4;
      out.data[d] = content.data[s];
      out.data[d + 1] = content.data[s + 1];
      out.data[d + 2] = content.data[s + 2];
      out.data[d + 3] = content.data[s + 3];
    }
  }

  const fitted = clampInsets(insets, cw, ch, 1);
  // Top row: horizontal stretch range. Left column: vertical stretch range.
  paintRun(out, fitted.left, cw - fitted.right - 1, (x) => (x + 1) * 4);
  paintRun(out, fitted.top, ch - fitted.bottom - 1, (y) => (y + 1) * w * 4);

  if (padding) {
    const pad = clampInsets(padding, cw, ch, 1);
    // Bottom row: horizontal padding box. Right column: vertical padding box.
    paintRun(out, pad.left, cw - pad.right - 1, (x) => ((h - 1) * w + (x + 1)) * 4);
    paintRun(out, pad.top, ch - pad.bottom - 1, (y) => ((y + 1) * w + (w - 1)) * 4);
  }

  return out;
}
