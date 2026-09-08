# Changelog

All notable changes to sprite-tools will be documented here.

This project follows semantic versioning for the npm package.

## [Unreleased]

- Add a standalone Background Removal tool at `/background-removal` — chroma-key a video, a sprite sheet, or loose images to transparency or a solid fill, auto-crop, and export a ZIP, a stitched sheet, or a single PNG.
- Add the `chroma` CLI command (alias `remove-bg`) and the `sprite_remove_background` MCP tool, sharing the web app's chroma-key math and defaults.
- Add edge extrusion to atlas packing — the `--extrude N` CLI flag, the `extrude` input on the `sprite_pack_atlas` MCP tool, and an Extrude control in the web atlas packer. Each sprite's edge pixels are repeated into the surrounding gutter, and the amount is clamped to `--padding`, so at padding 0 extrusion is a no-op.
- Change atlas packing to extrude 1px by default, so atlas PNGs differ from previous output in the gutter pixels around each sprite. Frame rects in the manifest are unchanged; pass `--extrude 0` to restore the old transparent gutter.
- Fix the web atlas packer exporting the green frame guides into the PNG — every sprite's outermost pixel row shipped tinted. The guides are now preview-only, so the downloaded atlas is pixel-identical to the CLI's.
- Add GitHub community health files, issue templates, pull request guidance, and dependency update configuration.

## [0.1.0] - Initial public release

- Ship the shared sprite pipeline as a web app, CLI, and MCP server.
- Add collision polygon tracing, pivot detection, animation tags, palette extraction, pixel-art conversion, normal map generation, atlas packing, GIF export, trimming, slicing, and metadata export.
