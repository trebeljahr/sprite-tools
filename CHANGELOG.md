# Changelog

All notable changes to sprite-tools will be documented here.

This project follows semantic versioning for the npm package.

## [Unreleased]

- Add a Nine-slice tool at `/nine-slice` — set the four border insets by hand or start from a detected guess, then check them against a live stretched preview at any target size.
- Add the `nine-slice` CLI command, the `sprite_generate_nine_slice` MCP tool, and a `nineSlice` section in `meta`, all emitting the same insets and nine region rects.
- Add Android `.9.png` import and export, so a marker-border patch can be decoded into insets and insets can be written back out as a `.9.png`. One contiguous stretch run per edge is supported.
- Add an Outline & Shadow tool at `/outline` — outer or inner outlines at an exact pixel width, with 4- or 8-neighbour growth, plus an offset, blurred drop shadow, on a single sprite or every cell of a sheet.
- Add the `outline` CLI command and the `sprite_add_outline` / `sprite_add_shadow` MCP tools, sharing the web app's distance-transform pass and defaults.
- Re-tint a whole shading ramp at once instead of swapping its shades one by one — the Palette tab now detects the ramps in a sprite's palette and remaps each one as a unit, preserving the lightness steps, the relative saturation, and the shadow-to-highlight hue drift that make the shading read.
- Generate named recolor variants from a single sheet: an evenly spaced hue set (2–12 tints, the original included) or a hand-written variant list, previewed side by side and exported as `<base>_<slug>.png` files plus a manifest JSON, in a ZIP.
- Do all palette math in OKLCH rather than HSL, so hue rotation holds perceived brightness instead of darkening the cool half of a palette. The existing hue-shift buttons stop muddying colors, and the web app, CLI, and MCP server now produce identical pixels from the same spec.
- Extract an exact palette when a sprite has no more distinct colors than were asked for, and never return a duplicate entry. Median-cut splits boxes by pixel count, so on flat pixel art a large region could claim several boxes that averaged to the same color while a small distinct one (a face, a trim) shared a bucket with its neighbour — which made re-tinting a shirt also re-tint the skin.
- Extend the `palette` CLI command with `--ramps`, `--ramp-tolerance`, `--ramp`, `--variants`, `--hue-variants`, `--hue-step`, `--out-dir`, `--name`, and `--manifest`. Existing flags and output keys are unchanged.
- Add the `sprite_detect_ramps` and `sprite_palette_variants` MCP tools, so an agent can inspect a sprite's ramps and write a whole variant set with one call.
- Add margin and spacing support for padded sprite sheets — `--margin`, `--margin-x`, `--margin-y`, `--spacing`, `--spacing-x`, `--spacing-y` on every CLI command that takes `--cols` / `--rows`, the same optional args on the MCP sheet tools, and a Margin & spacing control in the Sheet Builder, so sheets with a border and gutters stop slicing a strip of the neighbouring sprite into every frame.
- Report the inferred `margin` and `spacing` next to `cols` / `rows` from `detect` and `info` on all three surfaces, so a padded sheet can be measured once and the numbers fed straight back in.
- Add optional per-frame animation durations: a `frameDurations` array on `tags` and `meta` JSON (milliseconds, `null` = fall back to the tag's fps) so key poses can be held longer than in-betweens. The field is only written when a frame has an explicit hold, so existing documents and outputs are unchanged.
- Add `--duration` to the `tags`, `meta`, and `gif` CLI commands, `--tags-json` to `gif`, a `frame_durations` input on the `sprite_generate_tags` and `sprite_generate_meta` MCP tools, per-frame hold editing in the Tags tool, and duration-aware GIF export.
- Add duplicate frame detection and removal — the `dedupe` CLI command, the `sprite_find_duplicates` MCP tool, a **Select unique** button in the Sheet Builder, and a Duplicate Frames step in Background Removal. Byte-identical frames always merge. A threshold above 0 also merges frames whose mean absolute RGBA difference, on a 0-255 scale, is at or below it. Alpha counts.
- Add tag rewriting to `dedupe` (`--tags`, `--tags-out`, `--respect-tags`) and `sprite_find_duplicates` (`tags_path`, `tags_output_path`, `respect_tags`). Removing frames renumbers later frames, so `dedupe` rewrites each tag range through the renumbering. A range with gaps gets an ordered `frames` list, `contiguous: false`, and a warning. `--respect-tags` and `respect_tags` stop a tag losing frames to another tag.
- Add engine export: metadata JSON in, an engine-native file out — a Godot 4 `SpriteFrames` (or per-frame `AtlasTexture`) `.tres`, a Unity `TextureImporter` `.meta` sidecar with sliced sprite rects, pivots and physics shapes, an Aseprite-shaped sheet JSON, or a Phaser 3 / PixiJS texture atlas.
- Add the `export` CLI command and the `sprite_export_engine` MCP tool, plus an `/export` page in the web app. All three accept the same input: a `meta` output, a `jq -s add` merge of `collision`/`pivot`/`tags`, an `atlas` manifest, or a merge of those.
- Record `grid.margin`, `grid.spacing`, `sourceWidth` and `sourceHeight` in the `collision`, `pivot`, `tags`, `meta` and `palette` CLI output and the matching MCP tools, so an export of a padded sheet, or one whose size is not a multiple of the cell size, places every region correctly.
- Document the export formats at `/docs/reference/engine-export`, including the Unity Y-flip and normalized-pivot conventions and each format's limitations — Godot has no slot for pivots or collision, Aseprite drops polygons, and overwriting a Unity `.meta` without reusing its guid detaches references.
- Stop describing `sprite_generate_tags` output as Aseprite tag metadata in the MCP tool description. It is sprite-tools' own JSON shape; `export --format aseprite` writes the Aseprite file.
- Add a Sheet Lint tool at `/lint` — nine checks (alpha fringe, frame bleed, pivot drift, duplicate and empty frames, fully opaque frames, non-power-of-two sizes, palette bloat, near-duplicate colours) run over a sheet and drawn onto it, because a report that says "frame 7 bleeds" is far less useful than one that points at the pixels.
- Add the `lint` CLI command and the `sprite_lint_sheet` MCP tool — the thing to run first on an unfamiliar sheet, since it reports the detected grid and frame count alongside its findings, and states which rules it skipped and why instead of staying silent. JSON by default, `--format text` for humans, `--severity` to filter, `--disable` / `--only` / `--set` to tune every rule and threshold, and exit code 1 on error-severity findings so it can gate a build.
- Add a standalone Background Removal tool at `/background-removal` — chroma-key a video, a sprite sheet, or loose images to transparency or a solid fill, auto-crop, and export a ZIP, a stitched sheet, or a single PNG.
- Add the `chroma` CLI command (alias `remove-bg`) and the `sprite_remove_background` MCP tool, sharing the web app's chroma-key math and defaults.
- Add edge extrusion to atlas packing — the `--extrude N` CLI flag, the `extrude` input on the `sprite_pack_atlas` MCP tool, and an Extrude control in the web atlas packer. Each sprite's edge pixels are repeated into the surrounding gutter, and the amount is clamped to `--padding`, so at padding 0 extrusion is a no-op.
- Change atlas packing to extrude 1px by default, so atlas PNGs differ from previous output in the gutter pixels around each sprite. Frame rects in the manifest are unchanged; pass `--extrude 0` to restore the old transparent gutter.
- Fix the web atlas packer exporting the green frame guides into the PNG — every sprite's outermost pixel row shipped tinted. The guides are now preview-only, so the downloaded atlas is pixel-identical to the CLI's.
- Add pixel-art upscaling to the Pixelate tool, the `pixelate` CLI command, and the `sprite_pixelate` MCP tool — nearest-neighbour plus Scale2x, Scale3x, Eagle, and xBR level 1, so an already-pixelated sprite can be magnified for display without the blur a bilinear resize leaves behind. Every filter only copies existing source pixels, so palettes and transparency come through unchanged.
- Add `--upscale-algo` / `--upscale-factor` to `pixelate` and `upscale_algo` / `upscale_factor` to `sprite_pixelate`. A factor above 1 is an explicit magnification and replaces the existing `--upscale` / `upscale` restore-to-source-size step, which is unchanged at the default factor of 1.
- Read Aseprite working files (`.ase` / `.aseprite`) directly, with no export step. RGBA, grayscale, and indexed files composite with all 19 Aseprite blend modes, layer and cel opacity, and linked cels.
- Add the `aseprite` CLI command (alias `ase`) and the `sprite_read_aseprite` MCP tool. Both report tags, per-frame durations, the layer tree, and the palette as JSON. The CLI writes a sheet PNG by default; the MCP tool writes a sheet or per-frame PNGs on request.
- Add an Aseprite source tab to the Sheet Builder and Background Removal pages, with layer, hidden-layer, and animation-tag selection before import.
- Report unsupported or damaged Aseprite content as warnings. The CLI prints them to stderr and the JSON, the MCP tool returns them, and the web app lists them under Decode notes. Tilemap layers, slices, and a group's own blend mode or opacity are not applied, and each one produces a warning.
- Make `sprite-tools aseprite` JSON and the `sprite_read_aseprite` result one shared shape. `source` now names the written sheet PNG, and the new `asepriteFile` key names the file that was read.
- Add `sourceWidth`, `sourceHeight`, and a top-level `frameDurations` array to Aseprite output, so `sprite-tools export` and `sprite_export_engine` read it directly and keep Aseprite's frame durations.
- Add `documentFrameCount`, `pixelRatio`, and `layers[].effectivelyVisible` to the CLI output, and `layers[].reference` to both surfaces.
- Stop with an error when a `--layer` / `layers` selection renders no pixels, instead of writing an empty sheet. Naming a reference or hidden layer next to a layer that renders adds a warning.
- Keep `pingpong-reverse` tags in engine export. Aseprite and Phaser JSON write `pingpong_reverse`, and Godot and Pixi animations bake the frame order starting from `to`.
- Write a tag's repeat count to Aseprite JSON `frameTags` as `"repeat": "N"`.
- Fail engine export on a grid document with `source: null` unless a texture name is given.
- Accept a `sprite_read_aseprite` result in engine export. Its `output_path` equals its `source`, so it no longer counts as image-writing tool output.
- Show reference layers, tilemap layers, and hidden layers as dashed, disabled chips in the web Aseprite tab. Hidden layers stay enabled while Include hidden layers is on. A layer, tag, or hidden-layer change after an import re-imports right away.
- Add the dedupe step to Aseprite runs in Background Removal, and warn when a multi-file drop skips `.ase` files.
- Add GitHub community health files, issue templates, pull request guidance, and dependency update configuration.

## [0.1.0] - Initial public release

- Ship the shared sprite pipeline as a web app, CLI, and MCP server.
- Add collision polygon tracing, pivot detection, animation tags, palette extraction, pixel-art conversion, normal map generation, atlas packing, GIF export, trimming, slicing, and metadata export.
