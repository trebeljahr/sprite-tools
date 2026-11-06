#!/usr/bin/env node
// Write docs/marketing/manifest.json: every asset with its purpose, pixel
// size, bytes, SHA-256 and the script that makes it. Run after the capture
// and render scripts.

import { createHash } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BASE = join(ROOT, "docs", "marketing");
const CAPTURE = "scripts/marketing/capture-screenshots.mjs";
const RENDER = "scripts/marketing/render-social-preview.mjs";

const ASSETS = [
  [
    "screenshots/collision-desktop.png",
    CAPTURE,
    "README hero: Collision tool, beetle sheet as a 3×1 grid, first frame with its 28-point polygon (dark).",
  ],
  ["screenshots/collision-desktop-light.png", CAPTURE, "Same Collision view in the light theme."],
  [
    "screenshots/lint-desktop.png",
    CAPTURE,
    "Sheet Lint: frame-bleed error drawn onto the beetle sheet, findings panel.",
  ],
  ["screenshots/lint-mobile.png", CAPTURE, "Sheet Lint at 390×844 (phone), sheet and findings."],
  [
    "screenshots/aseprite-import-desktop.png",
    CAPTURE,
    "Sheet Builder reading beetle.aseprite: canvas, layers, frames, stitched sheet.",
  ],
  [
    "screenshots/export-desktop.png",
    CAPTURE,
    "Export: the CLI's beetle.json turned into a Godot SpriteFrames .tres.",
  ],
  [
    "screenshots/cli-session.json",
    CAPTURE,
    "Real stdout of the two CLI commands shown in the terminal capture.",
  ],
  [
    "screenshots/cli-lint-terminal.png",
    RENDER,
    "Terminal capture: sprite-tools ase, then sprite-tools lint, typeset from cli-session.json.",
  ],
  [
    "social-preview/social-preview-a.png",
    RENDER,
    "GitHub social preview A: screenshot-led (Collision crop).",
  ],
  [
    "social-preview/social-preview-b.png",
    RENDER,
    "GitHub social preview B: typographic, brand-led.",
  ],
  [
    "social-preview/social-preview-c.png",
    RENDER,
    "GitHub social preview C: terminal lint output over the Sheet Lint view.",
  ],
  [
    "social-preview/review-sheet.jpg",
    RENDER,
    "A, B and C side by side, labelled, for picking one.",
  ],
];

function pngSize(buf) {
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function jpegSize(buf) {
  let i = 2;
  while (i < buf.length) {
    const marker = buf.readUInt16BE(i);
    const len = buf.readUInt16BE(i + 2);
    if (marker >= 0xffc0 && marker <= 0xffc3) {
      return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
    }
    i += 2 + len;
  }
  return null;
}

const files = ASSETS.map(([path, madeBy, purpose]) => {
  const abs = join(BASE, path);
  const buf = readFileSync(abs);
  const size = path.endsWith(".png") ? pngSize(buf) : path.endsWith(".jpg") ? jpegSize(buf) : null;
  return {
    path,
    purpose,
    ...(size ? { pixels: `${size.width}x${size.height}` } : {}),
    bytes: statSync(abs).size,
    sha256: createHash("sha256").update(buf).digest("hex"),
    madeBy,
  };
});

const manifest = {
  generated: new Date().toISOString().slice(0, 10),
  source:
    "Real Sprite Tools web app (static export served locally) and CLI. No mock UI, no generated imagery.",
  demoInput:
    "tests/fixtures/aseprite/excalibur/beetle-rgba-multi-animation.aseprite (excalibur-aseprite, BSD-2-Clause, see NOTICE there)",
  fonts: "Geist and Geist Mono (OFL-1.1), as shipped in the next package",
  files,
};
writeFileSync(join(BASE, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`manifest.json: ${files.length} files`);
