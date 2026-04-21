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
  .description("CLI for sprite-sheet processing. Run any subcommand with --help for full options, examples, and output shape.")
  .version("0.1.0");

program.addHelpText(
  "after",
  [
    "",
    "Commands that emit JSON (default: stdout):",
    "  detect     grid auto-detection             { grid:{cols,rows}, confidence }",
    "  collision  per-frame collision polygons    { collision: [...] }",
    "  pivot      anchor / origin metadata        { pivots: [...] }",
    "  tags       named animation ranges          { tags: [...] }",
    "  palette    dominant colors + swaps         { palette: [...], swaps: [...] }",
    "  atlas      packed-atlas manifest           { atlas, width, height, frames:{...} }  (plus PNG)",
    "",
    "Commands that emit PNG/GIF (default: stdout, use -o <file>):",
    "  pixelate   downscale + quantize + dither",
    "  normal-map alpha/luminance → tangent-space normals",
    "  gif        animated GIF from sheet",
    "",
    "Composing: the JSON commands share top-level {source, frameWidth, frameHeight, grid}",
    "so you can merge them with jq:",
    "",
    "  sprite-tools collision hero.png -o c.json",
    "  sprite-tools pivot    hero.png -o p.json",
    "  sprite-tools tags     hero.png --tag idle=0-5 --tag run=6-11 -o t.json",
    "  jq -s 'add' c.json p.json t.json > hero-meta.json",
    "",
    "Auto-detect a grid and feed it to another command:",
    "",
    "  G=$(sprite-tools detect sheet.png | jq -r '.grid | \"--cols \\(.cols) --rows \\(.rows)\"')",
    "  sprite-tools collision sheet.png $G --tolerance 4",
    "",
    "Run `sprite-tools <command> --help` for the full shape of each output.",
    "",
  ].join("\n"),
);

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
