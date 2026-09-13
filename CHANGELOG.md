# Changelog

All notable changes to sprite-tools will be documented here.

This project follows semantic versioning for the npm package.

## [Unreleased]

- Add an Outline & Shadow tool at `/outline` — outer or inner outlines at an exact pixel width, with 4- or 8-neighbour growth, plus an offset, blurred drop shadow, on a single sprite or every cell of a sheet.
- Add the `outline` CLI command and the `sprite_add_outline` / `sprite_add_shadow` MCP tools, sharing the web app's distance-transform pass and defaults.
- Re-tint a whole shading ramp at once instead of swapping its shades one by one — the Palette tab now detects the ramps in a sprite's palette and remaps each one as a unit, preserving the lightness steps, the relative saturation, and the shadow-to-highlight hue drift that make the shading read.
- Generate named recolor variants from a single sheet: an evenly spaced hue set (2–12 tints, the original included) or a hand-written variant list, previewed side by side and exported as `<base>_<slug>.png` files plus a manifest JSON, in a ZIP.
- Do all palette math in OKLCH rather than HSL, so hue rotation holds perceived brightness instead of darkening the cool half of a palette. The existing hue-shift buttons stop muddying colors, and the web app, CLI, and MCP server now produce identical pixels from the same spec.
- Extract an exact palette when a sprite has no more distinct colors than were asked for, and never return a duplicate entry. Median-cut splits boxes by pixel count, so on flat pixel art a large region could claim several boxes that averaged to the same color while a small distinct one (a face, a trim) shared a bucket with its neighbour — which made re-tinting a shirt also re-tint the skin.
- Extend the `palette` CLI command with `--ramps`, `--ramp-tolerance`, `--ramp`, `--variants`, `--hue-variants`, `--hue-step`, `--out-dir`, `--name`, and `--manifest`. Existing flags and output keys are unchanged.
- Add the `sprite_detect_ramps` and `sprite_palette_variants` MCP tools, so an agent can inspect a sprite's ramps and write a whole variant set with one call.
- Add a standalone Background Removal tool at `/background-removal` — chroma-key a video, a sprite sheet, or loose images to transparency or a solid fill, auto-crop, and export a ZIP, a stitched sheet, or a single PNG.
- Add the `chroma` CLI command (alias `remove-bg`) and the `sprite_remove_background` MCP tool, sharing the web app's chroma-key math and defaults.
- Add edge extrusion to atlas packing — the `--extrude N` CLI flag, the `extrude` input on the `sprite_pack_atlas` MCP tool, and an Extrude control in the web atlas packer. Each sprite's edge pixels are repeated into the surrounding gutter, and the amount is clamped to `--padding`, so at padding 0 extrusion is a no-op.
- Change atlas packing to extrude 1px by default, so atlas PNGs differ from previous output in the gutter pixels around each sprite. Frame rects in the manifest are unchanged; pass `--extrude 0` to restore the old transparent gutter.
- Fix the web atlas packer exporting the green frame guides into the PNG — every sprite's outermost pixel row shipped tinted. The guides are now preview-only, so the downloaded atlas is pixel-identical to the CLI's.
- Add GitHub community health files, issue templates, pull request guidance, and dependency update configuration.

## [0.1.0] - Initial public release

- Ship the shared sprite pipeline as a web app, CLI, and MCP server.
- Add collision polygon tracing, pivot detection, animation tags, palette extraction, pixel-art conversion, normal map generation, atlas packing, GIF export, trimming, slicing, and metadata export.
