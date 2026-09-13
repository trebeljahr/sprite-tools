// Tiny fixture builders for unit tests. Avoids a tests/fixtures/*.png tree —
// everything is constructed in-memory per test so a regression in one test
// doesn't affect others.

export function blank(w: number, h: number): ImageData {
  return new ImageData(w, h);
}

export function filledRect(
  w: number,
  h: number,
  x: number,
  y: number,
  rectW: number,
  rectH: number,
  color: [number, number, number, number] = [255, 0, 0, 255],
): ImageData {
  const img = new ImageData(w, h);
  for (let yy = y; yy < Math.min(h, y + rectH); yy++) {
    for (let xx = x; xx < Math.min(w, x + rectW); xx++) {
      const i = (yy * w + xx) * 4;
      img.data[i] = color[0];
      img.data[i + 1] = color[1];
      img.data[i + 2] = color[2];
      img.data[i + 3] = color[3];
    }
  }
  return img;
}

export function circle(
  w: number,
  h: number,
  cx: number,
  cy: number,
  radius: number,
  color: [number, number, number, number] = [255, 0, 0, 255],
): ImageData {
  const img = new ImageData(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy <= radius * radius) {
        const i = (y * w + x) * 4;
        img.data[i] = color[0];
        img.data[i + 1] = color[1];
        img.data[i + 2] = color[2];
        img.data[i + 3] = color[3];
      }
    }
  }
  return img;
}

/** Build a cols×rows sheet of equally-sized circles (useful for detect tests). */
export function circleSheet(
  cols: number,
  rows: number,
  cellSize: number,
  radius: number,
): ImageData {
  const w = cols * cellSize;
  const h = rows * cellSize;
  const img = new ImageData(w, h);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cx = c * cellSize + cellSize / 2;
      const cy = r * cellSize + cellSize / 2;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const dx = x - cx;
          const dy = y - cy;
          if (dx * dx + dy * dy <= radius * radius) {
            const i = (y * w + x) * 4;
            img.data[i] = 200;
            img.data[i + 1] = 50;
            img.data[i + 2] = 100;
            img.data[i + 3] = 255;
          }
        }
      }
    }
  }
  return img;
}

/** Dimensionality check: all four RGBA channels present. */
export function hasOpaqueAt(img: ImageData, x: number, y: number): boolean {
  const i = (y * img.width + x) * 4;
  return img.data[i + 3] > 0;
}

export type RGBA = [number, number, number, number];

/**
 * Palette for paddedSheet: injective for index < 256, and every channel is far
 * from both 0 and its neighbours, so "which cell did this pixel come from" is a
 * question an assertion can answer.
 */
export function cellColor(index: number): RGBA {
  return [
    ((index & 7) + 1) * 30,
    (((index >> 3) & 7) + 1) * 30,
    (((index >> 6) & 3) + 1) * 60,
    255,
  ];
}

export interface PaddedSheetOptions {
  cols: number;
  rows: number;
  cellW: number;
  cellH: number;
  /** Outer border. A number is uniform; per-side keys override it. */
  margin?: number | Partial<{ left: number; top: number; right: number; bottom: number }>;
  /** Gutter between cells. A number sets both axes. */
  spacing?: number | Partial<{ x: number; y: number }>;
  /** Shrink the painted sprite inside its cell by this many px per side. */
  inset?: number;
  background?: RGBA;
  color?: (col: number, row: number, index: number) => RGBA;
}

/**
 * A sheet with a real margin and real gutters, each cell a DISTINCT solid
 * colour over a background. Distinct colours are the point: neighbour bleed and
 * gutter bleed become assertable ("this frame is one colour") instead of
 * something you have to eyeball.
 */
export function paddedSheet(opts: PaddedSheetOptions): ImageData {
  const { cols, rows, cellW, cellH, inset = 0 } = opts;
  const m = opts.margin ?? 0;
  const margin =
    typeof m === "number"
      ? { left: m, top: m, right: m, bottom: m }
      : { left: m.left ?? 0, top: m.top ?? 0, right: m.right ?? 0, bottom: m.bottom ?? 0 };
  const s = opts.spacing ?? 0;
  const spacing = typeof s === "number" ? { x: s, y: s } : { x: s.x ?? 0, y: s.y ?? 0 };
  const bg = opts.background ?? [0, 0, 0, 0];
  const colorOf = opts.color ?? ((_c: number, _r: number, i: number) => cellColor(i));

  const w = margin.left + cols * cellW + (cols - 1) * spacing.x + margin.right;
  const h = margin.top + rows * cellH + (rows - 1) * spacing.y + margin.bottom;
  const img = new ImageData(w, h);
  if (bg[3] !== 0) {
    for (let i = 0; i < img.data.length; i += 4) {
      img.data[i] = bg[0];
      img.data[i + 1] = bg[1];
      img.data[i + 2] = bg[2];
      img.data[i + 3] = bg[3];
    }
  }

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const color = colorOf(c, r, r * cols + c);
      const x0 = margin.left + c * (cellW + spacing.x) + inset;
      const y0 = margin.top + r * (cellH + spacing.y) + inset;
      for (let y = y0; y < y0 + cellH - 2 * inset; y++) {
        for (let x = x0; x < x0 + cellW - 2 * inset; x++) {
          const i = (y * w + x) * 4;
          img.data[i] = color[0];
          img.data[i + 1] = color[1];
          img.data[i + 2] = color[2];
          img.data[i + 3] = color[3];
        }
      }
    }
  }
  return img;
}

export function colorKey(c: RGBA): string {
  return c.join(",");
}

export function colorAt(img: ImageData, x: number, y: number): RGBA {
  const i = (y * img.width + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]];
}

/** Every distinct "r,g,b,a" in the image, sorted — the raw material for bleed assertions. */
export function uniqueColors(img: ImageData): string[] {
  const seen = new Set<string>();
  for (let i = 0; i < img.data.length; i += 4) {
    seen.add(`${img.data[i]},${img.data[i + 1]},${img.data[i + 2]},${img.data[i + 3]}`);
  }
  return [...seen].sort();
}

/** "This frame is exactly one colour" — i.e. no gutter and no neighbour leaked in. */
export function isUniformColor(img: ImageData): boolean {
  return uniqueColors(img).length === 1;
}

/** Overwrite a single pixel in place. */
export function setPixel(
  img: ImageData,
  x: number,
  y: number,
  color: [number, number, number, number],
): void {
  const i = (y * img.width + x) * 4;
  img.data[i] = color[0];
  img.data[i + 1] = color[1];
  img.data[i + 2] = color[2];
  img.data[i + 3] = color[3];
}

/** Paint a rect in place, clipped to the image. Composable, unlike filledRect. */
export function paintRect(
  img: ImageData,
  x: number,
  y: number,
  w: number,
  h: number,
  color: [number, number, number, number],
): void {
  for (let yy = Math.max(0, y); yy < Math.min(img.height, y + h); yy++) {
    for (let xx = Math.max(0, x); xx < Math.min(img.width, x + w); xx++) {
      setPixel(img, xx, yy, color);
    }
  }
}

/** Every pixel set to one colour — the "nothing was keyed out" case. */
export function fillAll(img: ImageData, color: [number, number, number, number]): void {
  paintRect(img, 0, 0, img.width, img.height, color);
}
