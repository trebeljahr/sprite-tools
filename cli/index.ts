#!/usr/bin/env node

// sprite-tools: a CLI for composable sprite-sheet processing.
//
// Ship-shape principles:
//   - Image-producing commands write to a file (or stdout with `-o -`).
//   - JSON-producing commands print to stdout by default; pipe-friendly.
//   - Every JSON output shares `source`, `frameWidth`, `frameHeight`, `grid`
//     top-level keys so outputs merge cleanly with `jq -s add`.
//   - All errors go to stderr, exit code 1.

import "./lib/imagedata-shim";

import { Command } from "commander";

import { registerCollisionCommand } from "./commands/collision";
import { registerPixelateCommand } from "./commands/pixelate";
import { registerNormalMapCommand } from "./commands/normal-map";
import { registerPaletteCommand } from "./commands/palette";
import { registerAtlasCommand } from "./commands/atlas";
import { registerPivotCommand } from "./commands/pivot";
import { registerTagsCommand } from "./commands/tags";
import { registerGifCommand } from "./commands/gif";
import { registerDetectCommand } from "./commands/detect";
import { registerSliceCommand } from "./commands/slice";
import { registerTrimCommand } from "./commands/trim";
import { registerInfoCommand } from "./commands/info";
import { registerMetaCommand } from "./commands/meta";

const program = new Command();

program
  .name("sprite-tools")
  .description(
    "CLI for sprite-sheet processing. Run any subcommand with --help for full options, examples, and output shape.",
  )
  .version("0.1.0");

program.addHelpText(
  "after",
  [
    "",
    "Inspect / slice:",
    "  info       image stats + detected grid + content bounds          (JSON)",
    "  detect     just the detected grid                                (JSON)",
    "  slice      split a sheet into per-cell PNGs on disk              (files)",
    "  trim       auto-crop transparent padding                         (PNG)",
    "",
    "Metadata (all share top-level {source, frameWidth, frameHeight, grid}):",
    "  collision  per-frame collision polygons                          (JSON)",
    "  pivot      anchor / origin metadata                              (JSON)",
    "  tags       named animation ranges                                (JSON)",
    "  meta       collision + pivot + tags in one pass (merged JSON)    (JSON)",
    "  palette    dominant colors + swaps                               (JSON)",
    "  atlas      packed-atlas manifest                                 (JSON + PNG)",
    "",
    "Image transforms (default: stdout, use -o <file>):",
    "  pixelate   downscale + quantize + dither + palette-snap           (PNG)",
    "  normal-map alpha/luminance → tangent-space normals               (PNG)",
    "  gif        animated GIF from sheet                               (GIF)",
    "",
    "Any <input> may be '-' to read PNG bytes from stdin. Any -o target may be '-'",
    "for stdout. So you can pipe:",
    "",
    "  cat hero.png | sprite-tools trim - -o - | sprite-tools collision -",
    "",
    "Or compose metadata in one call:",
    "",
    "  sprite-tools meta hero.png --collision --pivot bottom-center \\",
    "    --tag idle=0-5 --tag run=6-11 > hero.json",
    "",
    "Or the old jq way:",
    "",
    "  sprite-tools collision hero.png -o c.json",
    "  sprite-tools pivot    hero.png -o p.json",
    "  jq -s 'add' c.json p.json > hero.json",
    "",
    "Run `sprite-tools <command> --help` for the full shape of each output.",
    "",
  ].join("\n"),
);

registerInfoCommand(program);
registerDetectCommand(program);
registerSliceCommand(program);
registerTrimCommand(program);
registerCollisionCommand(program);
registerPivotCommand(program);
registerTagsCommand(program);
registerMetaCommand(program);
registerPaletteCommand(program);
registerPixelateCommand(program);
registerNormalMapCommand(program);
registerAtlasCommand(program);
registerGifCommand(program);

program.parseAsync(process.argv).catch((err) => {
  process.stderr.write(`sprite-tools: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
