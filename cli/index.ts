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

const program = new Command();

program
  .name("sprite-tools")
  .description(
    [
      "CLI for sprite-sheet processing.",
      "",
      "Composable: pipe JSON between commands, or merge with `jq -s add`.",
      "",
      "Examples:",
      "  sprite-tools detect sheet.png",
      "  sprite-tools collision sheet.png --tolerance 4 -o collision.json",
      "  sprite-tools pixelate sprite.png --pixel-size 4 --palette gameboy -o pixel.png",
      "  sprite-tools atlas sprites/*.png -o atlas.png --json atlas.json",
      "",
    ].join("\n"),
  )
  .version("0.1.0");

registerDetectCommand(program);
registerCollisionCommand(program);
registerPixelateCommand(program);
registerNormalMapCommand(program);
registerPaletteCommand(program);
registerAtlasCommand(program);
registerPivotCommand(program);
registerTagsCommand(program);
registerGifCommand(program);

program.parseAsync(process.argv).catch((err) => {
  process.stderr.write(`sprite-tools: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
