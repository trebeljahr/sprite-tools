# Marketing assets

Screenshots and GitHub social preview cards for Sprite Tools. Every screenshot comes from the real web app or the real CLI, and there is no mock UI. The one generated image is the mouse sprite used as demo input (see [Demo inputs](#demo-inputs)).

Made 2026-11-06; Collision captures and cards redone 2026-11-07. Sizes, byte counts and SHA-256 hashes are in [manifest.json](manifest.json).

## Rebuild

```bash
pnpm build                  # static export in out/
pnpm marketing:assets       # screenshots, CLI transcript, cards, manifest
```

`marketing:assets` runs three scripts in `scripts/marketing/`:

- `capture-screenshots.mjs [scene ...]` serves `out/` on a random free port in 49152–65535 and drives headless Chromium. Pass scene names to redo only some: `collision-desktop`, `collision-desktop-light`, `lint-desktop`, `aseprite-import-desktop`, `export-desktop`, `lint-mobile`, `cli`.
- `render-social-preview.mjs` renders [social-preview/template.html](social-preview/template.html) into the cards, the review sheet and the terminal capture. Cards A and B draw `screenshots/collision-mouse.json` over the sprite; C and D crop the Collision screenshots.
- `write-manifest.mjs` rewrites `manifest.json`.

Playwright is not a project dependency. `load-playwright.mjs` uses a global install and the newest headless Chromium in the Playwright cache. Set `PLAYWRIGHT_MODULE` or `CHROMIUM_PATH` to override.

## Demo inputs

**The mouse**, `source/quiet-brass-mouse.png` (720×476 RGBA), is the input for the Collision captures and all four social preview cards. It is the Quiet Brass character, the same art as the October 2026 LinkedIn card:

- 2026-10-21: an image model (the built-in `image_gen` tool of the coding agent) made five character concept sheets to Rico's brief, a mouse or shrew hero with a small sword. Rico chose Quiet Brass. The same tool then redrew it as one side-on walking pose on a green screen, and Sprite Tools cut it out (1294×855).
- 2026-10-23: green spill was clamped in 7,368 edge pixels for the LinkedIn card. Alpha, size, red and blue stayed unchanged. That master is `quiet-brass-clean-edge.png` (SHA-256 `0a0cc9eebc465010054816f7f8ad9b7b95f89be6acf3beafaf397af456c94f74`) in the local design-history archive, `sprite-tools/2026-10-23/linkedin-featured/`.
- 2026-11-07: this copy is that master scaled to 720 px wide (ImageMagick 7, Lanczos, metadata stripped). At 720 px the Collision tool's 1 px outline stays visible in a 1280×640 card.

The capture uses alpha threshold 128 (the faint whisker tips stay outside) and simplification tolerance 6, which gives 76 points. The tool's **Download JSON** output is saved as `screenshots/collision-mouse.json`. The mouse is not in the npm package.

**The beetle** is `tests/fixtures/aseprite/excalibur/beetle-rgba-multi-animation.aseprite`, real Aseprite art from [excalibur-aseprite](https://github.com/excaliburjs/excalibur-aseprite) under BSD-2-Clause ([NOTICE](../../tests/fixtures/aseprite/excalibur/NOTICE)). The capture script runs `sprite-tools ase` on it first, so Sheet Lint, the Aseprite import, Export and the CLI capture show the same 192×64, three-frame sheet.

No account, API key or network call is involved.

## Files

| File | Pixels | Purpose |
| --- | --- | --- |
| `source/quiet-brass-mouse.png` | 720×476 | Demo input: the mouse sprite. |
| `screenshots/collision-desktop.png` | 3200×2000 | README hero. Collision tool with the mouse and its 76-point polygon, dark theme, dark preview grid. |
| `screenshots/collision-desktop-light.png` | 3200×2000 | The same view in the light theme. |
| `screenshots/collision-mouse.json` | — | The Collision tool's Download JSON output for the mouse. |
| `screenshots/lint-desktop.png` | 3200×2000 | Sheet Lint with a forced 3×1 grid: one frame-bleed error drawn onto the sheet, one info finding. |
| `screenshots/lint-mobile.png` | 1170×2532 | Sheet Lint on a 390×844 phone viewport. |
| `screenshots/aseprite-import-desktop.png` | 3200×2000 | Sheet Builder reading `beetle.aseprite` directly: canvas, layers, frames and the stitched sheet. |
| `screenshots/export-desktop.png` | 3200×2000 | Export turning the CLI's `beetle.json` into a Godot `SpriteFrames` `.tres`. |
| `screenshots/cli-session.json` | — | Real stdout of `sprite-tools ase` and `sprite-tools lint` on the beetle. |
| `screenshots/cli-lint-terminal.png` | 2400×1058 | That transcript typeset as a terminal (Geist Mono). |
| `social-preview/social-preview-a.png` | 1280×640 | Card A, dark: the mouse with the exported polygon in blue, in the layout of the LinkedIn card. |
| `social-preview/social-preview-b.png` | 1280×640 | Card B, light: the same on a paper background. |
| `social-preview/social-preview-c.png` | 1280×640 | Card C, dark: the Collision tool's Preview card, with name, one line and URL beside it. |
| `social-preview/social-preview-d.png` | 1280×640 | Card D, light: the Collision page with the Source and Preview cards, under a name row. |
| `social-preview/review-sheet.jpg` | 1410×826 | A to D in a 2×2 grid, labelled. |

Desktop shots use a 1600×1000 viewport at device scale 2. The phone shot uses device scale 3. Cards are 1280×640 at scale 1, with key content inside a 64 px margin, and each is under 1 MB as GitHub requires.

## Known gaps

- The Collision and Pixelate previews are wider than a 390 px phone screen (`aspect-video` plus `min-h-96`), so the phone shot uses Sheet Lint instead.
- No social preview card is uploaded to GitHub yet. Pick one of A to D first.
- The Collision preview fills the traced polygon with a 25% green tint and draws a 1 px outline, so C and D show the mouse tinted green. A and B draw the same exported points as a thicker blue line over the untinted sprite.
- Round 1 (2026-11-06) used the beetle on all three cards and was rejected because of the sprite.
