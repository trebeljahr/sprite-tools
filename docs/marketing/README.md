# Marketing assets

Screenshots and GitHub social preview cards for Sprite Tools. Every image comes from the real web app or the real CLI. There is no mock UI and no generated imagery.

Made 2026-11-06. Sizes, byte counts and SHA-256 hashes are in [manifest.json](manifest.json).

## Rebuild

```bash
pnpm build                  # static export in out/
pnpm marketing:assets       # screenshots, CLI transcript, cards, manifest
```

`marketing:assets` runs three scripts in `scripts/marketing/`:

- `capture-screenshots.mjs [scene ...]` serves `out/` on a random free port in 49152–65535 and drives headless Chromium. Pass scene names to redo only some: `collision-desktop`, `collision-desktop-light`, `lint-desktop`, `aseprite-import-desktop`, `export-desktop`, `lint-mobile`, `cli`.
- `render-social-preview.mjs` renders [social-preview/template.html](social-preview/template.html) into the cards, the review sheet and the terminal capture.
- `write-manifest.mjs` rewrites `manifest.json`.

Playwright is not a project dependency. `load-playwright.mjs` uses a global install and the newest headless Chromium in the Playwright cache. Set `PLAYWRIGHT_MODULE` or `CHROMIUM_PATH` to override.

## Demo input

The beetle is `tests/fixtures/aseprite/excalibur/beetle-rgba-multi-animation.aseprite`, real Aseprite art from [excalibur-aseprite](https://github.com/excaliburjs/excalibur-aseprite) under BSD-2-Clause ([NOTICE](../../tests/fixtures/aseprite/excalibur/NOTICE)). The capture script runs `sprite-tools ase` on it first, so every tool shows the same 192×64, three-frame sheet. No account, API key or network call is involved.

## Files

| File | Pixels | Purpose |
| --- | --- | --- |
| `screenshots/collision-desktop.png` | 3200×2000 | README hero. Collision tool, sheet as a 3×1 grid, the first frame with a 28-point polygon (tolerance 2). Dark theme. |
| `screenshots/collision-desktop-light.png` | 3200×2000 | The same view in the light theme. |
| `screenshots/lint-desktop.png` | 3200×2000 | Sheet Lint with a forced 3×1 grid: one frame-bleed error drawn onto the sheet, one info finding. |
| `screenshots/lint-mobile.png` | 1170×2532 | Sheet Lint on a 390×844 phone viewport. |
| `screenshots/aseprite-import-desktop.png` | 3200×2000 | Sheet Builder reading `beetle.aseprite` directly: canvas, layers, frames and the stitched sheet. |
| `screenshots/export-desktop.png` | 3200×2000 | Export turning the CLI's `beetle.json` into a Godot `SpriteFrames` `.tres`. |
| `screenshots/cli-session.json` | — | Real stdout of `sprite-tools ase` and `sprite-tools lint` on the beetle. |
| `screenshots/cli-lint-terminal.png` | 2400×1058 | That transcript typeset as a terminal (Geist Mono). |
| `social-preview/social-preview-a.png` | 1280×640 | Card A, screenshot-led: name, one line, Collision crop. |
| `social-preview/social-preview-b.png` | 1280×640 | Card B, typographic: grid mark, name, one line, both URLs. |
| `social-preview/social-preview-c.png` | 1280×640 | Card C: terminal lint output over the Sheet Lint view. |
| `social-preview/review-sheet.jpg` | 2100×428 | A, B and C side by side, labelled. |

Desktop shots use a 1600×1000 viewport at device scale 2. The phone shot uses device scale 3. Cards are 1280×640 at scale 1, with key content inside a 64 px margin, and each is under 1 MB as GitHub requires.

## Known gaps

- The Collision and Pixelate previews are wider than a 390 px phone screen (`aspect-video` plus `min-h-96`), so the phone shot uses Sheet Lint instead.
- No social preview card is uploaded to GitHub yet. Pick one of A, B or C first.
