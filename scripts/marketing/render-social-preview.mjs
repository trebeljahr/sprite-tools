#!/usr/bin/env node
// Render the GitHub social preview cards and the terminal capture from
// docs/marketing/social-preview/template.html.
//
//   node scripts/marketing/capture-screenshots.mjs   # screenshots + CLI transcript first
//   node scripts/marketing/render-social-preview.mjs
//
// Writes social-preview-{a,b,c,d}.png (1280x640, the size GitHub asks for),
// review-sheet.jpg (all four, labelled), ../screenshots/cli-lint-terminal.png
// and the og:image cards og-wordmark.png and og-clean.png (1200x630, from
// card A; the downscale needs ImageMagick's `magick`).
// Fonts: Geist and Geist Mono as shipped inside the `next` package (OFL-1.1).

import { execFileSync } from "node:child_process";
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

// og:image cards, both from card A. The card is laid out at 1280x672, the
// 1200x630 shape on the template's 1280 px width, rendered at scale 2 and
// downscaled to exactly 1200x630, so nothing is cropped or squashed.
const OG_TALL =
  "html, body { width: 1280px !important; height: 672px !important; } .card { height: 672px; }";
// Sprite 720x476 scaled 1.22 -> 878x581, centred on the 1280x672 card.
const OG_SW = 878;
const OG_SH = Math.round((476 * OG_SW) / 720);
const OG = [
  // Card A without its URL line: the middle block, grid and sprite move down
  // 16 px, so the 58/64 px top and bottom margins stay as they are.
  [
    "og-wordmark",
    `${OG_TALL}
    .poly .gridbg { top: 56px; }
    .poly .what { top: 252px; }
    .poly svg.sprite { top: 122px; }
    .poly .foot .mono { display: none !important; }`,
  ],
  // No mark, name or copy: the mouse and its polygon, enlarged and centred on
  // the same dark grid.
  [
    "og-clean",
    `${OG_TALL}
    .poly .head, .poly .what, .poly .foot { display: none !important; }
    .poly .gridbg {
      left: 120px; top: 16px; width: 1040px; height: 640px;
      background-position: center center;
      -webkit-mask-image: radial-gradient(ellipse at 50% 50%, #000 50%, transparent 78%);
      mask-image: radial-gradient(ellipse at 50% 50%, #000 50%, transparent 78%);
    }
    .poly svg.sprite {
      left: ${(1280 - OG_SW) / 2}px; top: ${(672 - OG_SH) / 2}px;
      width: ${OG_SW}px; height: ${OG_SH}px;
    }`,
  ],
];

function downscale(png, out) {
  try {
    // No date chunks, so an unchanged card keeps its SHA-256.
    execFileSync(
      "magick",
      ["png:-", "-resize", "1200x630!", "-define", "png:exclude-chunks=date,time", out],
      {
        input: png,
      },
    );
  } catch (error) {
    if (error.code === "ENOENT")
      throw new Error("The og:image cards need ImageMagick: brew install imagemagick");
    throw error;
  }
}

async function render(
  browser,
  variant,
  { width, height, scale, path, type = "png", fullPage = false, css, og = false },
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
  // The template sizes the polygon's stroke from the SVG's rendered width when
  // its inline script runs, so override CSS must be in place before that: it
  // goes in right after the template's own <style> is parsed.
  if (css) {
    await ctx.addInitScript((text) => {
      const obs = new MutationObserver(() => {
        const own = document.querySelector("head style:not(#fonts)");
        if (!own || document.getElementById("override")) return;
        const style = document.createElement("style");
        style.id = "override";
        style.textContent = text;
        own.after(style);
        obs.disconnect();
      });
      obs.observe(document, { childList: true, subtree: true });
    }, css);
  }
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
  if (og) downscale(await target.screenshot({ type: "png" }), path);
  else await target.screenshot({ path, type, ...(type === "jpeg" ? { quality: 85 } : {}) });
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

  for (const [name, css] of OG) {
    const path = join(DIR, `${name}.png`);
    await render(browser, "a", { width: 1280, height: 672, scale: 2, path, css, og: true });
    console.log(`${name}.png ${Math.round(statSync(path).size / 1024)} KB`);
  }

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
