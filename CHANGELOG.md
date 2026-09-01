# Changelog

All notable changes to sprite-tools will be documented here.

This project follows semantic versioning for the npm package.

## [Unreleased]

- Add a standalone Background Removal tool at `/background-removal` — chroma-key a video, a sprite sheet, or loose images to transparency or a solid fill, auto-crop, and export a ZIP, a stitched sheet, or a single PNG.
- Add the `chroma` CLI command (alias `remove-bg`) and the `sprite_remove_background` MCP tool, sharing the web app's chroma-key math and defaults.
- Add GitHub community health files, issue templates, pull request guidance, and dependency update configuration.

## [0.1.0] - Initial public release

- Ship the shared sprite pipeline as a web app, CLI, and MCP server.
- Add collision polygon tracing, pivot detection, animation tags, palette extraction, pixel-art conversion, normal map generation, atlas packing, GIF export, trimming, slicing, and metadata export.
