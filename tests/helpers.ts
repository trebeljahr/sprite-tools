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
