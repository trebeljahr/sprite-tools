#!/usr/bin/env node
// Render the GitHub social preview cards and the terminal capture from
// docs/marketing/social-preview/template.html.
//
//   node scripts/marketing/capture-screenshots.mjs   # screenshots + CLI transcript first
//   node scripts/marketing/render-social-preview.mjs
//
// Writes social-preview-{a,b,c,d}.png (1280x640, the size GitHub asks for),
// review-sheet.jpg (all four, labelled) and ../screenshots/cli-lint-terminal.png.
// Fonts: Geist and Geist Mono as shipped inside the `next` package (OFL-1.1).

import { readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { launchChromium } from "./load-playwright.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DIR = join(ROOT, "docs", "marketing", "social-preview");
const SHOTS = join(ROOT, "docs", "marketing", "screenshots");
const TEMPLATE = pathToFileURL(join(DIR, "template.html")).href;

const require = createRequire(import.meta.url);
const fontDir = join(
  dirname(require.resolve("next/package.json")),
  "dist",
  "next-devtools",
  "server",
  "font",
);
const font = (file) => pathToFileURL(join(fontDir, file)).href;
const FONT_CSS = `
  @font-face { font-family: "Geist"; src: url("${font("geist-latin.woff2")}") format("woff2"); font-weight: 100 900; }
  @font-face { font-family: "Geist"; src: url("${font("geist-latin-ext.woff2")}") format("woff2"); font-weight: 100 900; unicode-range: U+0100-024F; }
  @font-face { font-family: "Geist Mono"; src: url("${font("geist-mono-latin.woff2")}") format("woff2"); font-weight: 100 900; }
`;
const session = JSON.parse(readFileSync(join(SHOTS, "cli-session.json"), "utf8"));
// The Collision tool's own export for the mouse; cards A and B draw it.
const collision = JSON.parse(readFileSync(join(SHOTS, "collision-mouse.json"), "utf8"));

const CARDS = [
  ["a", "dark · mouse and polygon, LinkedIn card layout"],
  ["b", "light · mouse and polygon, LinkedIn card layout"],
  ["c", "dark · Collision tool, Preview card"],
  ["d", "light · Collision page, Source and Preview"],
];

async function render(
  browser,
  variant,
  { width, height, scale, path, type = "png", fullPage = false },
) {
  const ctx = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: scale,
    colorScheme: "dark",
  });
  await ctx.addInitScript(
    ([s, c]) => {
      window.__CLI__ = s;
      window.__COLLISION__ = c;
    },
    [session, collision],
  );
  const page = await ctx.newPage();
  await page.goto(`${TEMPLATE}?v=${variant}`);
  await page.addStyleTag({ content: FONT_CSS });
  await page.evaluate(() => document.fonts.ready);
  // A and B: make sure the sprite behind the polygon has decoded.
  await page.evaluate(() =>
    Promise.all(
      [...document.querySelectorAll("section:not(.hidden) image")].map((el) => {
        const img = new Image();
        img.src = new URL(el.getAttribute("href"), location.href).href;
        return img.decode();
      }),
    ),
  );
  await page.waitForTimeout(300);
  const target = fullPage ? page.locator(`#${variant}`) : page;
  await target.screenshot({ path, type, ...(type === "jpeg" ? { quality: 85 } : {}) });
  await ctx.close();
}

const browser = await launchChromium();
try {
  for (const [v] of CARDS) {
    const path = join(DIR, `social-preview-${v}.png`);
    await render(browser, v, { width: 1280, height: 640, scale: 1, path });
    const kb = Math.round(statSync(path).size / 1024);
    if (kb > 1000) throw new Error(`${path} is ${kb} KB; GitHub wants under 1 MB`);
    console.log(`social-preview-${v}.png ${kb} KB`);
  }
  await render(browser, "terminal", {
    width: 1200,
    height: 400,
    scale: 2,
    path: join(SHOTS, "cli-lint-terminal.png"),
    fullPage: true,
  });
  console.log("cli-lint-terminal.png");

  // Review sheet: the four cards in a 2x2 grid, labelled A-D.
  const ctx = await browser.newContext({
    viewport: { width: 1410, height: 800 },
    deviceScaleFactor: 1,
  });
  const page = await ctx.newPage();
  // setContent pages cannot read file:// URLs, so inline the PNGs.
  const img = (v) =>
    `data:image/png;base64,${readFileSync(join(DIR, `social-preview-${v}.png`)).toString("base64")}`;
  await page.setContent(`
    <style>${FONT_CSS}
      body { margin: 0; background: #27272a; font-family: Geist, system-ui; color: #fafafa; }
      .grid { display: grid; grid-template-columns: 660px 660px; gap: 30px; padding: 30px; }
      figure { margin: 0; }
      img { width: 660px; height: 330px; display: block; border-radius: 8px; }
      figcaption { font-size: 22px; margin-top: 12px; }
      b { color: #22c55e; }
    </style>
    <div class="grid">
      ${CARDS.map(
        ([v, label]) =>
          `<figure><img src="${img(v)}"><figcaption><b>${v.toUpperCase()}</b> · ${label}</figcaption></figure>`,
      ).join("")}
    </div>`);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
  await page.screenshot({
    path: join(DIR, "review-sheet.jpg"),
    type: "jpeg",
    quality: 85,
    fullPage: true,
  });
  await ctx.close();
  console.log("review-sheet.jpg");
} finally {
  await browser.close();
}
