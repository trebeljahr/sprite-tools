import { Command } from "commander";
import {
  writeBinaryOutput,
  writeJsonOutput,
  fail,
  parseIntArg,
} from "../lib/common";
import { loadPng, imageToPngBuffer } from "../lib/image-io";
import { computeTrimRect } from "../../src/lib/atlas/pack";

export function registerTrimCommand(program: Command) {
  const cmd = program
    .command("trim <input>")
    .description("Auto-crop transparent padding around the opaque region.")
    .option(
      "--padding <n>",
      "pixels of opaque-aligned padding to keep",
      (v) => parseIntArg("padding", v),
      0,
    )
    .option("--json <file>", "also write trim metadata JSON here")
    .option("-o, --output <file>", "output PNG file (default: stdout)");

  addHelpTrimExtras(cmd);

  cmd.action(
    (
      input: string,
      opts: { padding: number; json?: string; output?: string },
    ) => {
      try {
        const img = loadPng(input);
        const rect = computeTrimRect(img);
        if (!rect) fail("image is fully transparent — nothing to trim");

        const pad = Math.max(0, opts.padding);
        const x = Math.max(0, rect!.x - pad);
        const y = Math.max(0, rect!.y - pad);
        const w = Math.min(img.width - x, rect!.w + pad * 2);
        const h = Math.min(img.height - y, rect!.h + pad * 2);

        const out = new ImageData(w, h);
        for (let yy = 0; yy < h; yy++) {
          const srcRow = ((y + yy) * img.width + x) * 4;
          out.data.set(img.data.subarray(srcRow, srcRow + w * 4), yy * w * 4);
        }

        writeBinaryOutput(imageToPngBuffer(out), opts.output);

        if (opts.json) {
          writeJsonOutput(
            {
              source: input,
              sourceWidth: img.width,
              sourceHeight: img.height,
              trim: { x, y, width: w, height: h },
              paddingKept: pad,
            },
            opts.json,
          );
        }
      } catch (e) {
        fail(e instanceof Error ? e.message : String(e));
      }
    },
  );
}

function addHelpTrimExtras(cmd: Command) {
  // Inline to avoid a new import; same pattern as other commands.
  cmd.addHelpText(
    "after",
    [
      "",
      "Examples:",
      "  sprite-tools trim sprite.png -o trimmed.png",
      "  sprite-tools trim sprite.png --padding 2 --json trim.json -o trimmed.png",
      "  # pipe in and out:",
      "  cat sprite.png | sprite-tools trim - -o - | sprite-tools collision -",
      "",
      "Output shape (--json):",
      "  { source, sourceWidth, sourceHeight,",
      "    trim: {x,y,width,height}, paddingKept }",
      "",
    ].join("\n"),
  );
}
