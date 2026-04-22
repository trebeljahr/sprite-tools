// Generate a handful of demo PNGs that ship under public/samples/.
// Re-run whenever the samples need refreshing:
//
//   node scripts/generate-samples.mjs
//
// The samples are intentionally small + procedural so the bundled bytes
// stay tiny — not meant as polished art, just enough variety to try every
// tool against something meaningful.

import { writeFileSync } from "node:fs";
import { PNG } from "pngjs";

const OUT_DIR = new URL("../public/samples/", import.meta.url);

function blank(w, h) {
  const png = new PNG({ width: w, height: h });
  png.data.fill(0);
  return png;
}

function set(png, x, y, r, g, b, a = 255) {
  if (x < 0 || x >= png.width || y < 0 || y >= png.height) return;
  const i = (y * png.width + x) * 4;
  png.data[i] = r;
  png.data[i + 1] = g;
  png.data[i + 2] = b;
  png.data[i + 3] = a;
}

function fillRect(png, x, y, w, h, r, g, b, a = 255) {
  for (let yy = y; yy < y + h; yy++) {
    for (let xx = x; xx < x + w; xx++) {
      set(png, xx, yy, r, g, b, a);
    }
  }
}

function fillCircle(png, cx, cy, radius, r, g, b, a = 255) {
  for (let y = cy - radius; y <= cy + radius; y++) {
    for (let x = cx - radius; x <= cx + radius; x++) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy <= radius * radius) set(png, x, y, r, g, b, a);
    }
  }
}

function save(png, name) {
  const path = new URL(name, OUT_DIR);
  writeFileSync(path, PNG.sync.write(png));
  console.log("wrote", path.pathname, `(${png.width}×${png.height})`);
}

// -----------------------------------------------------------------
// 1. Single character-ish blob (one sprite, 64×64)
// -----------------------------------------------------------------
function sampleCharacter() {
  const png = blank(64, 64);
  // Body
  fillCircle(png, 32, 36, 18, 80, 120, 220);
  // Head
  fillCircle(png, 32, 18, 12, 240, 200, 170);
  // Eyes
  fillCircle(png, 28, 18, 2, 30, 30, 30);
  fillCircle(png, 36, 18, 2, 30, 30, 30);
  // Arm highlights
  fillCircle(png, 14, 38, 6, 80, 120, 220);
  fillCircle(png, 50, 38, 6, 80, 120, 220);
  // Feet
  fillRect(png, 24, 52, 6, 6, 90, 60, 30);
  fillRect(png, 34, 52, 6, 6, 90, 60, 30);
  return png;
}

// -----------------------------------------------------------------
// 2. 5×5 sprite sheet with slightly-varied circles
// -----------------------------------------------------------------
function sampleSheet() {
  const CELL = 48;
  const COLS = 5;
  const ROWS = 5;
  const png = blank(CELL * COLS, CELL * ROWS);
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const cx = c * CELL + CELL / 2;
      const cy = r * CELL + CELL / 2;
      const radius = 16 - ((r + c) % 4);
      // Hue via simple RGB rotation based on cell index.
      const h = (r * COLS + c) * 25;
      const rr = Math.max(60, (h * 7) % 255);
      const gg = Math.max(60, (h * 13) % 255);
      const bb = Math.max(60, (h * 19) % 255);
      fillCircle(png, cx, cy, radius, rr, gg, bb);
      // Pupil-ish highlight so Collision has something to trace
      fillCircle(png, cx - 3, cy - 3, 3, 255, 255, 255);
    }
  }
  return png;
}

// -----------------------------------------------------------------
// 3. Thin-limbed "pterodactyl" sheet — stress-tests grid detection
// -----------------------------------------------------------------
function samplePterodactyl() {
  const CELL = 48;
  const COLS = 4;
  const ROWS = 4;
  const png = blank(CELL * COLS, CELL * ROWS);
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const cx = c * CELL + CELL / 2;
      const cy = r * CELL + CELL / 2;
      // wing tips
      fillRect(png, cx - 20, cy - 2, 8, 4, 190, 100, 70);
      fillRect(png, cx + 12, cy - 2, 8, 4, 190, 100, 70);
      // body
      fillRect(png, cx - 2, cy - 6, 4, 12, 190, 100, 70);
      // tail
      fillRect(png, cx - 1, cy + 12, 2, 6, 190, 100, 70);
    }
  }
  return png;
}

save(sampleCharacter(), "character.png");
save(sampleSheet(), "sheet.png");
save(samplePterodactyl(), "pterodactyl.png");
