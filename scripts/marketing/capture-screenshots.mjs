#!/usr/bin/env node
// Capture the README and press screenshots from the real web app.
//
//   pnpm build                                   # static export in out/
//   node scripts/marketing/capture-screenshots.mjs [scene ...]
//
// Serves out/ on a random free port in 49152-65535, drives headless
// Chromium (scripts/marketing/load-playwright.mjs explains where it comes
// from) and writes docs/marketing/screenshots/*.png (2x device pixels),
// collision-mouse.json (the Collision tool's own Download JSON output) and
// cli-session.json (the real CLI output). render-social-preview.mjs draws the
// first and typesets the second.
//
// Demo inputs:
// - The mouse, docs/marketing/source/quiet-brass-mouse.png: Rico's Quiet Brass
//   character, the same art as the October 2026 LinkedIn card. It is the
//   input for the Collision captures and the social preview cards. Provenance
//   is in docs/marketing/README.md.
// - The beetle from tests/fixtures/aseprite/excalibur/ (real Aseprite art
//   from the Excalibur.js test suite, BSD-2-Clause, vendored in this repo).
//   The CLI turns it into a 3-frame PNG sheet first, so the Lint, Aseprite
//   import, Export and CLI captures show the same file.
// No account, no API key, no network: /api calls fail quietly in the static
// export.

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launchChromium } from "./load-playwright.mjs";
import { serveStatic } from "./static-server.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = join(ROOT, "docs", "marketing", "screenshots");
const BEETLE_FIXTURE = join(
  ROOT,
  "tests/fixtures/aseprite/excalibur/beetle-rgba-multi-animation.aseprite",
);

// 720x476, alpha-clean. Alpha threshold 128 skips the faint whisker tips;
// tolerance 6 gives a 76-point polygon, close to the 72 points of the card.
const MOUSE = join(ROOT, "docs", "marketing", "source", "quiet-brass-mouse.png");
const MOUSE_SETTINGS = { alphaThreshold: 128, simplifyTolerance: 6 };

const DESKTOP = { width: 1600, height: 1000 };
const MOBILE = { width: 390, height: 844 };

const only = new Set(process.argv.slice(2));
const wanted = (name) => only.size === 0 || only.has(name);

mkdirSync(OUT, { recursive: true });

// --- Demo input, made by the CLI itself -------------------------------------
// Relative names, so file paths in the JSON and on screen stay short.
const work = mkdtempSync(join(tmpdir(), "sprite-tools-marketing-"));
const BEETLE_ASE = join(work, "beetle.aseprite");
const BEETLE_SHEET = join(work, "beetle-sheet.png");
const BEETLE_JSON = join(work, "beetle.json");
copyFileSync(BEETLE_FIXTURE, BEETLE_ASE);

function cli(args) {
  return execFileSync(
    join(ROOT, "node_modules", ".bin", "tsx"),
    [join(ROOT, "cli", "index.ts"), ...args],
    {
      cwd: work,
      encoding: "utf8",
    },
  );
}

cli(["ase", "beetle.aseprite", "-o", "beetle-sheet.png", "--json", "beetle.json"]);

// --- Helpers ----------------------------------------------------------------
async function dismissQuickstart(page) {
  const close = page.getByRole("button", { name: "Dismiss quickstart" });
  if (await close.count()) await close.first().click();
}

async function loadSharedSource(page, url, file) {
  await page.goto(`${url}/collision`, { waitUntil: "networkidle" });
  await page.locator("input[type=file]").first().setInputFiles(file);
  await page.waitForTimeout(1500);
}

// Wait for work to finish and for toasts ("Detected 2x1 sprite grid") to fade.
async function settle(page, ms = 1500) {
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(ms);
  await page
    .locator("[data-sonner-toast]")
    .first()
    .waitFor({ state: "detached", timeout: 12000 })
    .catch(() => {});
  await page.waitForTimeout(300);
}

// The Share button's format: #s=<base64url(JSON)>, the same link a user copies.
function settingsHash(settings) {
  return `#s=${Buffer.from(JSON.stringify(settings)).toString("base64url")}`;
}

async function setNumber(page, label, value, scope) {
  const root = scope ?? page;
  const input = root.getByText(label, { exact: true }).locator("xpath=following-sibling::input[1]");
  await input.fill(String(value));
  await input.evaluate((el) => el.blur());
}

// --- Scenes -------------------------------------------------------------------
const scenes = {
  // README hero and card source: the mouse with its traced polygon. The dark
  // run also saves the JSON the Download button writes; the cards draw it.
  async "collision-desktop"({ browser, url, colorScheme = "dark", suffix = "" }) {
    const ctx = await browser.newContext({
      viewport: DESKTOP,
      deviceScaleFactor: 2,
      colorScheme,
      acceptDownloads: true,
    });
    const page = await ctx.newPage();
    await loadSharedSource(page, url, MOUSE);
    // A full load, so the page reads the settings hash on mount.
    await page.goto(`${url}/`, { waitUntil: "networkidle" });
    await page.goto(`${url}/collision${settingsHash(MOUSE_SETTINGS)}`, {
      waitUntil: "networkidle",
    });
    await dismissQuickstart(page);
    // Match the preview's checkerboard to the page theme.
    if (colorScheme === "dark") await page.getByTitle("Toggle background grid").click();
    await settle(page);
    await page.screenshot({ path: join(OUT, `collision-desktop${suffix}.png`) });
    if (colorScheme === "dark") {
      const [download] = await Promise.all([
        page.waitForEvent("download"),
        page.getByRole("button", { name: "Download JSON" }).click(),
      ]);
      const saved = join(OUT, "collision-mouse.json");
      await download.saveAs(saved);
      // Same data, laid out the way `pnpm lint` (Biome) expects.
      execFileSync(join(ROOT, "node_modules", ".bin", "biome"), ["format", "--write", saved]);
    }
    await ctx.close();
  },

  async "collision-desktop-light"(env) {
    await scenes["collision-desktop"]({ ...env, colorScheme: "light", suffix: "-light" });
  },

  // Sheet Lint: findings drawn onto the sheet.
  async "lint-desktop"({ browser, url }) {
    const ctx = await browser.newContext({
      viewport: DESKTOP,
      deviceScaleFactor: 2,
      colorScheme: "dark",
    });
    const page = await ctx.newPage();
    await loadSharedSource(page, url, BEETLE_SHEET);
    await page.goto(`${url}/lint`, { waitUntil: "networkidle" });
    await dismissQuickstart(page);
    await settle(page, 500);
    await page
      .getByText("Override grid", { exact: true })
      .locator("xpath=ancestor::div[2]")
      .locator("[data-slot=switch]")
      .click();
    await setNumber(page, "Columns", 3);
    await setNumber(page, "Rows", 1);
    await settle(page);
    await page.screenshot({ path: join(OUT, "lint-desktop.png") });
    await ctx.close();
  },

  // Sheet Builder reading the .aseprite file directly: tags and timing.
  async "aseprite-import-desktop"({ browser, url }) {
    const ctx = await browser.newContext({
      viewport: DESKTOP,
      deviceScaleFactor: 2,
      colorScheme: "dark",
    });
    const page = await ctx.newPage();
    await page.goto(`${url}/spritesheet`, { waitUntil: "networkidle" });
    await dismissQuickstart(page);
    await page
      .getByRole("tab", { name: /aseprite/i })
      .or(page.getByRole("button", { name: /aseprite/i }))
      .first()
      .click();
    await page.locator("input[type=file][accept*='ase']").first().setInputFiles(BEETLE_ASE);
    await settle(page, 1000);
    await page.getByRole("button", { name: "Import Frames" }).click();
    await settle(page, 1000);
    await setNumber(page, "Columns", 3);
    // Fit the stitched sheet to its panel (the third "Reset View" on the page).
    await page.getByTitle("Reset View").last().click();
    // The first import celebrates with confetti; let it fall.
    await page.evaluate(() => window.scrollTo(0, 0));
    await settle(page, 6000);
    await page.screenshot({ path: join(OUT, "aseprite-import-desktop.png") });
    await ctx.close();
  },

  // Engine export: the CLI's metadata JSON turned into a Godot SpriteFrames file.
  async "export-desktop"({ browser, url }) {
    const ctx = await browser.newContext({
      viewport: DESKTOP,
      deviceScaleFactor: 2,
      colorScheme: "dark",
    });
    const page = await ctx.newPage();
    await page.goto(`${url}/export`, { waitUntil: "networkidle" });
    await dismissQuickstart(page);
    const metadata = page.getByPlaceholder(/Paste or drop Sprite Tools JSON/);
    await metadata.fill(readFileSync(BEETLE_JSON, "utf8"));
    await metadata.evaluate((el) => {
      el.blur();
      el.scrollTop = 0;
    });
    await settle(page, 1500);
    await page.screenshot({ path: join(OUT, "export-desktop.png") });
    await ctx.close();
  },

  // Mobile: Sheet Lint. (The Collision and Pixelate previews use
  // aspect-video + min-h-96, which is wider than a 390px screen.)
  async "lint-mobile"({ browser, url }) {
    const ctx = await browser.newContext({
      viewport: MOBILE,
      deviceScaleFactor: 3,
      colorScheme: "dark",
      isMobile: true,
      hasTouch: true,
    });
    const page = await ctx.newPage();
    await loadSharedSource(page, url, BEETLE_SHEET);
    await page.goto(`${url}/lint`, { waitUntil: "networkidle" });
    await dismissQuickstart(page);
    await settle(page, 500);
    await page
      .getByText("Override grid", { exact: true })
      .locator("xpath=ancestor::div[2]")
      .locator("[data-slot=switch]")
      .click();
    await setNumber(page, "Columns", 3);
    await setNumber(page, "Rows", 1);
    await settle(page);
    // Scroll the Sheet card under the sticky nav.
    await page
      .getByText("Sheet", { exact: true })
      .first()
      .evaluate((el) => {
        window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 76);
      });
    // Park the pointer off the sheet so no finding tooltip stays open.
    await page.mouse.move(2, 2);
    await settle(page, 600);
    await page.screenshot({ path: join(OUT, "lint-mobile.png") });
    await ctx.close();
  },
};

// --- CLI capture: real output, saved as text and rendered as a terminal -------
function captureCli() {
  const commands = [
    ["ase", "beetle.aseprite", "-o", "beetle-sheet.png", "--json", "beetle.json"],
    ["lint", "beetle-sheet.png", "--cols", "3", "--rows", "1", "--format", "text"],
  ];
  const transcript = [];
  for (const args of commands) {
    let out;
    try {
      out = cli(args);
    } catch (err) {
      // `lint` exits 1 on error-severity findings; its report is still the output.
      out = `${err.stdout ?? ""}${err.stderr ?? ""}`;
    }
    transcript.push({ command: `sprite-tools ${args.join(" ")}`, output: out.trimEnd() });
  }
  writeFileSync(join(OUT, "cli-session.json"), `${JSON.stringify(transcript, null, 2)}\n`);
  return transcript;
}

const server = await serveStatic(join(ROOT, "out"));
const browser = await launchChromium();
try {
  for (const [name, run] of Object.entries(scenes)) {
    if (!wanted(name)) continue;
    process.stdout.write(`${name}… `);
    await run({ browser, url: server.url });
    process.stdout.write("done\n");
  }
  if (wanted("cli")) captureCli();
} finally {
  await browser.close();
  await server.close();
}
