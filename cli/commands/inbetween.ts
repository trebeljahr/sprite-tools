import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { Command } from "commander";
import { interpolatePoses, inbetweenSchema } from "../../src/lib/animation/inbetween";
import { fail, writeBinaryOutput, writeJsonOutput } from "../lib/common";
import { imageToPngBuffer, loadPng, readPngSize, stitchSheet } from "../lib/image-io";

export function registerInbetweenCommand(program: Command) {
  program
    .command("inbetween <from> <to>")
    .description(
      "Bake guided pose inbetweens between two aligned PNGs. Local only; review warped anatomy.",
    )
    .requiredOption(
      "--recipe <file>",
      "JSON: version, guides [{from:[[x,y],[x,y]],to:[[x,y],[x,y]]}], frames, durationMs, easing",
    )
    .requiredOption("-o, --output <file>", "output PNG sheet, including exact endpoint frames")
    .requiredOption("--json <file>", "output timing and reconstruction metadata")
    .addHelpText(
      "after",
      "\nExample:\n  sprite-tools inbetween exit.png idle.png --recipe guides.json -o recovery.png --json recovery.json\n\nGuide line endpoints must keep the same anatomical order in both poses.\nThe output contains frames + 2 cells, with exact source/target endpoints.\nThis warps artwork and blends aligned textures; it cannot paint hidden anatomy.\n",
    )
    .action((from: string, to: string, opts: { recipe: string; output: string; json: string }) => {
      try {
        if (from === "-" || to === "-") throw Error("Pose inputs must be named PNG files.");
        const inputs = [from, to, opts.recipe].map((p) => resolve(p));
        if (
          opts.output === "-" ||
          opts.json === "-" ||
          inputs.includes(resolve(opts.output)) ||
          inputs.includes(resolve(opts.json)) ||
          resolve(opts.output) === resolve(opts.json)
        )
          throw Error("Use distinct named output files; inputs cannot be overwritten.");
        if (statSync(opts.recipe).size > 128_000) throw Error("Recipe exceeds 128 KB.");
        const parsed = inbetweenSchema.parse(JSON.parse(readFileSync(opts.recipe, "utf8")));
        const a = readPngSize(from),
          b = readPngSize(to);
        if (
          !a ||
          !b ||
          a.width !== b.width ||
          a.height !== b.height ||
          a.width * a.height > 4_194_304
        )
          throw Error("Inputs must be matching PNG canvases no larger than 4 megapixels.");
        const count = parsed.frames + 2;
        if (a.width * a.height * Math.min(4, count) * Math.ceil(count / 4) > 32_000_000)
          throw Error("Packed interpolation sheet exceeds 32 million pixels.");
        const { frames, durations, recipe } = interpolatePoses(loadPng(from), loadPng(to), parsed);
        const cols = Math.min(4, frames.length),
          rows = Math.ceil(frames.length / cols);
        writeBinaryOutput(imageToPngBuffer(stitchSheet(frames, cols, rows)), opts.output);
        writeJsonOutput(
          {
            version: 1,
            source: from,
            target: to,
            frameWidth: frames[0].width,
            frameHeight: frames[0].height,
            grid: { cols, rows },
            frameCount: frames.length,
            frameDurations: durations,
            loop: false,
            recipe,
            review: "Guided warp candidate; inspect anatomy, occlusions and both joins before use.",
          },
          opts.json,
        );
      } catch (e) {
        fail(e instanceof Error ? e.message : String(e));
      }
    });
}
