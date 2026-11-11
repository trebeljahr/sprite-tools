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
    "source/quiet-brass-mouse.png",
    "ImageMagick 7 (Lanczos, -strip) from the 1294x855 master; see README.md, Demo inputs",
    "Demo input: the Quiet Brass mouse, 720x476 RGBA.",
  ],
  [
    "screenshots/collision-desktop.png",
    CAPTURE,
    "README hero: Collision tool, the mouse with its 76-point polygon (dark theme, dark preview grid).",
  ],
  ["screenshots/collision-desktop-light.png", CAPTURE, "Same Collision view in the light theme."],
  [
    "screenshots/collision-mouse.json",
    CAPTURE,
    "The Collision tool's Download JSON output for the mouse (alpha 128, tolerance 6, 76 points).",
  ],
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
    "GitHub social preview A (dark): the mouse with the exported polygon in blue, LinkedIn card layout.",
  ],
  [
    "social-preview/social-preview-b.png",
    RENDER,
    "GitHub social preview B (light): the same on a paper background.",
  ],
  [
    "social-preview/social-preview-c.png",
    RENDER,
    "GitHub social preview C (dark): the Collision tool's Preview card beside name, line and URL.",
  ],
  [
    "social-preview/social-preview-d.png",
    RENDER,
    "GitHub social preview D (light): the Collision page, Source and Preview cards, under a name row.",
  ],
  ["social-preview/review-sheet.jpg", RENDER, "A to D in a 2x2 grid, labelled, for picking one."],
  [
    "social-preview/og-wordmark.png",
    RENDER,
    "og:image (1200x630): card A with mark, name, line and URL, laid out at 1.91:1.",
  ],
  [
    "social-preview/og-clean.png",
    RENDER,
    "og:image (1200x630) without text: the mouse and its polygon, enlarged and centred on the dark grid.",
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
    "Real Sprite Tools web app (static export served locally) and CLI. No mock UI. Cards A and B draw the Collision tool's exported polygon, unedited, over the demo sprite.",
  demoInputs: [
    {
      path: "source/quiet-brass-mouse.png",
      what: "Quiet Brass mouse, the character on the October 2026 LinkedIn card",
      provenance:
        "Generated image: concept sheets and the side-on pose made 2026-10-21 with the coding agent's built-in image_gen tool to Rico's brief (he chose Quiet Brass); background cut out with Sprite Tools; green spill clamped 2026-10-23; scaled to 720 px 2026-11-07.",
      master:
        "design-history archive sprite-tools/2026-10-23/linkedin-featured/quiet-brass-clean-edge.png, 1294x855, sha256 0a0cc9eebc465010054816f7f8ad9b7b95f89be6acf3beafaf397af456c94f74",
      captureSettings: { alphaThreshold: 128, simplifyTolerance: 6 },
    },
    {
      path: "tests/fixtures/aseprite/excalibur/beetle-rgba-multi-animation.aseprite",
      what: "Beetle, used for Sheet Lint, Aseprite import, Export and the CLI capture",
      provenance: "excalibur-aseprite test fixture, BSD-2-Clause, see NOTICE there",
    },
  ],
  fonts: "Geist and Geist Mono (OFL-1.1), as shipped in the next package",
  files,
};
writeFileSync(join(BASE, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`manifest.json: ${files.length} files`);
