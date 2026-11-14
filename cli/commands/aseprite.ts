import type { Command } from "commander";
import { readFileSync } from "node:fs";
import {
  writeJsonOutput,
  writeBinaryOutput,
  fail,
  parseIntArg,
  addHelpExtras,
  baseName,
} from "../lib/common";
import { imageToPngBuffer, savePng, stitchSheet, upscaleNearest } from "../lib/image-io";
import { compositeFrames, isAsepriteFile, parseAseprite } from "../../src/lib/aseprite";
import { inflateNode } from "../../src/lib/aseprite/inflate-node";
import type {
  AseColor,
  AseCompositedFrame,
  AseDocument,
  AseTag,
  AseTagDirection,
} from "../../src/lib/aseprite/types";
import { normalizeFrameDurations } from "../../src/lib/animation/durations";

export function registerAsepriteCommand(program: Command) {
  const cmd = program
    .command("aseprite <input>")
    .alias("ase")
    .description("Read a .ase/.aseprite file into a sprite sheet PNG + metadata JSON.")
    .option("-o, --output <file>", 'sheet PNG file (default "<basename>-sheet.png", - for stdout)')
    .option("--json <file>", "metadata JSON file (default: stdout)")
    .option("--cols <n>", "sheet columns (default: every frame in one row)", (v) =>
      parseIntArg("cols", v),
    )
    .option("--tag <name>", "export only the frames in this animation tag")
    .option("--layer <name>", "repeatable: composite only this layer (by name)", collect, [])
    .option("--include-hidden", "composite hidden layers too", false)
    .option("--no-sheet", "metadata only, skip the PNG (default: write the PNG)")
    .option("--scale <n>", "integer nearest-neighbor upscale", (v) => parseIntArg("scale", v), 1);

  addHelpExtras(cmd, {
    examples: [
      "sprite-tools aseprite hero.aseprite",
      "sprite-tools ase hero.aseprite -o hero-sheet.png --json hero.json",
      "sprite-tools ase hero.aseprite --cols 4 --scale 2 -o hero-sheet.png --json hero.json",
      "sprite-tools ase hero.aseprite --tag run -o run.png --json run.json",
      "sprite-tools ase hero.aseprite --layer body --layer sword -o armed.png --json armed.json",
      "sprite-tools ase hero.aseprite --no-sheet | jq .tags",
      "# the JSON is a sheet metadata document, so the rest of the toolchain reads it:",
      "sprite-tools export hero.json --format godot -o hero.tres",
      "sprite-tools gif hero-sheet.png --cols 8 --tags-json hero.json -o hero.gif",
      "sprite-tools ase hero.aseprite -o - --json hero.json | sprite-tools collision -",
    ],
    output: [
      "PNG sprite sheet (canvas-sized cells, row-major) plus JSON:",
      "  { source, sourceWidth, sourceHeight, asepriteFile, frameWidth, frameHeight,",
      "    grid: {cols, rows, detected}, frameCount, documentFrameCount,",
      "    canvas: {width, height}, colorDepth, pixelRatio: {width, height}, tag,",
      "    frameDurations: [ms, ...],",
      "    tags:    [{ name, from, to, direction, repeat, color }, ...],",
      "    frames:  [{ index, sourceIndex, durationMs }, ...],",
      "    layers:  [{ index, name, type, opacity, blendMode, visible,",
      "                effectivelyVisible, reference, childLevel, parentIndex }, ...],",
      '    palette: ["#rrggbb" | "#rrggbbaa", ...],',
      "    warnings: [...] }",
      "source is the sheet PNG this JSON describes and sourceWidth/sourceHeight its",
      "pixel size; all three are null with --no-sheet, and source is null with -o -.",
      "asepriteFile is the .aseprite that was read. frameWidth/frameHeight include",
      "--scale. frameDurations has one entry per exported frame, in ms.",
      "Tag ranges are remapped onto the exported frames, so --tag run yields 0-based",
      "ranges that index the sheet you actually got. warnings also go to stderr.",
    ],
  });

  cmd.action(
    async (
      input: string,
      opts: {
        output?: string;
        json?: string;
        cols?: number;
        tag?: string;
        layer: string[];
        includeHidden: boolean;
        sheet: boolean;
        scale: number;
      },
    ) => {
      try {
        const wantsSheet = opts.sheet;
        // Both streams default to stdout, so a PNG on stdout would be spliced
        // into the JSON. Reject up front rather than emitting a corrupt pipe.
        if (wantsSheet && opts.output === "-" && !opts.json) {
          fail(
            "-o - writes the PNG to stdout, where the metadata JSON also goes by default — " +
              "pass --json <file> (or --no-sheet) so the two don't collide",
          );
        }
        if (opts.scale < 1) fail(`scale: expected an integer >= 1, got ${opts.scale}`);
        if (opts.cols !== undefined && opts.cols < 1) {
          fail(`cols: expected an integer >= 1, got ${opts.cols}`);
        }

        const bytes = readInput(input);
        if (!isAsepriteFile(bytes)) {
          fail(
            `${input}: not an Aseprite file (bad magic number) — expected a .ase or .aseprite ` +
              "document saved by Aseprite",
          );
        }

        const doc = await parseAseprite(bytes, { inflate: inflateNode });
        const selection = resolveAsepriteLayers(doc, opts.layer, {
          flag: "--layer",
          includeHidden: opts.includeHidden,
          hiddenHint: "--include-hidden",
        });
        // decodeAseprite() is the one-call path but composites with defaults;
        // --layer / --include-hidden need compositeFrames' own options, which is
        // exactly why the barrel exports the two steps separately.
        const all = compositeFrames(doc, {
          includeHiddenLayers: opts.includeHidden,
          layerIndices: selection.indices,
        });
        if (all.length === 0) fail(`${input}: file contains no frames`);

        const range = resolveAsepriteRange(doc, opts.tag, all.length, "--tag");
        const selected = all.slice(range.from, range.to + 1);
        const cols = opts.cols ?? selected.length;
        const rows = Math.ceil(selected.length / cols);

        let sheet: AsepriteSheetRef | null = null;
        if (wantsSheet) {
          const images = selected.map((f) => {
            // Copy into a fresh ImageData rather than `new ImageData(f.pixels, ...)`:
            // the composited buffer is typed Uint8ClampedArray<ArrayBufferLike>,
            // which the DOM ImageData constructor signature rejects.
            const img = new ImageData(f.width, f.height);
            img.data.set(f.pixels);
            return img;
          });
          const stitched = stitchSheet(images, cols, rows);
          const scaled = opts.scale > 1 ? upscaleNearest(stitched, opts.scale) : stitched;
          const target = opts.output ?? `${sheetBaseName(input)}-sheet.png`;
          if (target === "-") {
            writeBinaryOutput(imageToPngBuffer(scaled), "-");
          } else {
            savePng(scaled, target);
          }
          // Measured off the image actually encoded, not re-derived from the
          // grid, so the document can never disagree with the PNG.
          sheet = {
            path: target === "-" ? null : target,
            width: scaled.width,
            height: scaled.height,
          };
        }

        const meta = buildAsepriteMetadata({
          asepriteFile: input,
          doc,
          frames: all,
          range,
          cols,
          scale: opts.scale,
          tag: opts.tag ?? null,
          sheet,
          extraWarnings: selection.warnings,
        });
        // Warnings are the whole point of doc.warnings — surface them even when
        // stdout is being piped into jq and nobody reads the JSON by eye.
        for (const w of meta.warnings) process.stderr.write(`sprite-tools: warning: ${w}\n`);
        writeJsonOutput(meta, opts.json);
      } catch (e) {
        fail(e instanceof Error ? e.message : String(e));
      }
    },
  );
}

function collect(v: string, prev: string[]): string[] {
  return [...prev, v];
}

/** Read raw bytes from a path, or from stdin when `path === "-"`, like loadPng. */
function readInput(path: string): Uint8Array {
  // fd 0 is stdin. readFileSync(0) blocks until EOF.
  const buf = readFileSync(path === "-" ? 0 : path);
  if (buf.length === 0) throw new Error(path === "-" ? "no bytes on stdin" : `${path} is empty`);
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

/** stdin has no basename to derive a default output filename from. */
function sheetBaseName(input: string): string {
  return input === "-" ? "aseprite" : baseName(input);
}

// ---------------------------------------------------------------------------
// Pure pieces shared with the MCP `sprite_read_aseprite` tool.
//
// They throw instead of calling fail(): fail() exits the process, which is
// fatal for the long-lived MCP server. The CLI action's catch turns a throw
// into the same fail() exit. Sharing them is what keeps the CLI and MCP JSON
// identical in shape rather than "mirrored line for line" and drifting.
// ---------------------------------------------------------------------------

/** Where the composited sheet went. `path` is null when it has no file (stdout). */
export interface AsepriteSheetRef {
  path: string | null;
  width: number;
  height: number;
}

export interface AsepriteMetadataInput {
  /** The .ase/.aseprite that was read ("-" for stdin). */
  asepriteFile: string;
  doc: AseDocument;
  /** Every composited frame of the document, before the tag range is applied. */
  frames: AseCompositedFrame[];
  /** Inclusive exported range into `frames`. */
  range: { from: number; to: number };
  cols: number;
  scale: number;
  tag: string | null;
  /** The written sheet, or null when none was written. */
  sheet: AsepriteSheetRef | null;
  /** Selection notes (e.g. a named reference layer), listed after doc.warnings. */
  extraWarnings?: string[];
}

/**
 * The metadata document both surfaces emit. It is a sprite-tools sheet
 * metadata document first — `source` + `sourceWidth`/`sourceHeight` name the
 * sheet PNG exactly as `meta`/`tags` do — so `export`, `gif --tags-json` and
 * `dedupe --tags` consume it unchanged. `source` is NOT the .aseprite: every
 * consumer reads `source` as "the image this grid slices" (the texture name,
 * its pixel size, Unity's asset path), and pointing it at the .aseprite would
 * make each of them reference a file no engine can load. The .aseprite path
 * rides along as `asepriteFile`.
 *
 * Tags carry no `fps`: Aseprite has no per-tag rate, only per-frame durations,
 * and every frame has one. `frameDurations` therefore holds a number for every
 * frame, which the engine exporters apply verbatim; a made-up tag fps would
 * only change Godot's `speed`/`duration` split, never the on-screen time.
 */
export function buildAsepriteMetadata(input: AsepriteMetadataInput) {
  const { doc, frames, range, cols, scale, sheet } = input;
  const selected = frames.slice(range.from, range.to + 1);
  const rows = Math.ceil(selected.length / cols);
  // Indexed by EXPORTED frame, like every other per-frame array here. Run
  // through the shared normaliser so a zero-length frame (not writable by
  // Aseprite, but not rejected by the reader) means the same thing as it does
  // in `tags`/`meta`: no explicit hold.
  const frameDurations = normalizeFrameDurations(
    selected.map((f) => f.durationMs),
    selected.length,
  );

  return {
    source: sheet?.path ?? null,
    sourceWidth: sheet?.width ?? null,
    sourceHeight: sheet?.height ?? null,
    asepriteFile: input.asepriteFile,
    // Cell size of what was exported, so it includes `scale`.
    frameWidth: doc.width * scale,
    frameHeight: doc.height * scale,
    grid: { cols, rows, detected: false },
    frameCount: selected.length,
    documentFrameCount: frames.length,
    canvas: { width: doc.width, height: doc.height },
    colorDepth: doc.colorDepth,
    pixelRatio: { width: doc.pixelRatio.width, height: doc.pixelRatio.height },
    tag: input.tag,
    ...(frameDurations ? { frameDurations } : {}),
    tags: remapAsepriteTags(doc.tags, range.from, range.to),
    frames: selected.map((f, i) => ({
      index: i,
      sourceIndex: range.from + i,
      durationMs: f.durationMs,
    })),
    layers: doc.layers.map((l) => ({
      index: l.index,
      name: l.name,
      type: l.type,
      opacity: l.opacity,
      blendMode: l.blendMode,
      visible: l.visible,
      // What compositing honours: false inside a hidden group even when the
      // layer's own eye is on.
      effectivelyVisible: l.effectivelyVisible,
      // Never composited, whatever `visible` says — Aseprite keeps reference
      // layers out of every export.
      reference: l.reference,
      childLevel: l.childLevel,
      parentIndex: l.parentIndex,
    })),
    palette: doc.palette.map(asepriteColorToHex),
    // Non-fatal decode notes (skipped tilemap layers, flattened group blend
    // modes) plus selection notes. Always present so a partial decode is never
    // silent.
    warnings: [...doc.warnings, ...(input.extraWarnings ?? [])],
  };
}

export interface LayerSelectionOptions {
  /** How the option is spelled on this surface, for messages ("--layer" / "layers"). */
  flag: string;
  includeHidden: boolean;
  /** How to spell "include hidden layers" on this surface. */
  hiddenHint: string;
}

/**
 * Map layer names to the concrete layer indices compositeFrames wants. Naming a
 * group selects everything inside it, which is what "only this layer" means to
 * someone looking at Aseprite's layer panel.
 *
 * A selection that can render nothing is an error, not an empty sheet: a
 * reference layer never composites (Aseprite keeps it out of every export) and
 * a hidden layer only does with include-hidden. Naming one of those next to a
 * layer that does render is a warning instead, since the sheet is still real.
 */
export function resolveAsepriteLayers(
  doc: AseDocument,
  names: string[],
  opts: LayerSelectionOptions,
): { indices: number[] | undefined; warnings: string[] } {
  if (names.length === 0) return { indices: undefined, warnings: [] };

  const picked = new Set<number>();
  // Why a named layer adds nothing, phrased to fit both the warning and the error.
  const inert: string[] = [];
  for (const name of names) {
    const matches = doc.layers.filter((l) => l.name === name);
    if (matches.length === 0) {
      throw new Error(
        `${opts.flag} "${name}": no such layer. Available: ${
          doc.layers.map((l) => `"${l.name}"`).join(", ") || "(none)"
        }`,
      );
    }
    for (const match of matches) {
      picked.add(match.index);
      if (match.type === "group") {
        for (const child of doc.layers) {
          if (isDescendantOf(doc, child.index, match.index)) picked.add(child.index);
        }
      }
      if (match.reference) {
        inert.push(`"${name}" is a reference layer, which Aseprite never renders into an export`);
      } else if (match.type === "image" && !match.effectivelyVisible && !opts.includeHidden) {
        inert.push(`"${name}" is hidden in Aseprite and needs ${opts.hiddenHint}`);
      }
    }
  }

  const renders = (index: number) => {
    const l = doc.layers.find((layer) => layer.index === index);
    return (
      l !== undefined &&
      l.type === "image" &&
      !l.reference &&
      (opts.includeHidden || l.effectivelyVisible)
    );
  };
  const indices = [...picked].sort((a, b) => a - b);
  if (!indices.some(renders)) {
    const usable = doc.layers
      .filter((l) => l.type === "image" && !l.reference)
      .map((l) => `"${l.name}"`);
    const why =
      inert.length > 0
        ? inert.join("; ")
        : `reference layers never composite and hidden layers need ${opts.hiddenHint}`;
    throw new Error(
      `${opts.flag} ${names.map((n) => `"${n}"`).join(", ")}: this selection renders no pixels, ` +
        `so the sheet would be empty — ${why}. Image layers that can render: ${
          usable.join(", ") || "(none)"
        }`,
    );
  }
  const warnings = inert.map((why) => `${opts.flag} ${why}; it adds nothing to the sheet`);
  return { indices, warnings };
}

function isDescendantOf(doc: AseDocument, index: number, ancestor: number): boolean {
  let parent = doc.layers.find((l) => l.index === index)?.parentIndex ?? null;
  while (parent !== null) {
    if (parent === ancestor) return true;
    parent = doc.layers.find((l) => l.index === parent)?.parentIndex ?? null;
  }
  return false;
}

/** Inclusive frame range to export, resolved from a tag name. */
export function resolveAsepriteRange(
  doc: AseDocument,
  tagName: string | undefined,
  frameCount: number,
  flag: string,
): { from: number; to: number } {
  if (!tagName) return { from: 0, to: frameCount - 1 };

  const tag = doc.tags.find((t) => t.name === tagName);
  if (!tag) {
    throw new Error(
      `${flag} "${tagName}": no such tag. Available: ${
        doc.tags.map((t) => `"${t.name}"`).join(", ") || "(none)"
      }`,
    );
  }
  // Clamp so a tag pointing past the last frame still yields at least one
  // frame instead of an empty slice and a zero-sized sheet.
  const from = Math.max(0, Math.min(tag.from, frameCount - 1));
  const to = Math.max(from, Math.min(tag.to, frameCount - 1));
  return { from, to };
}

/**
 * Rebase tag ranges onto the exported subset. A tag still saying 4-7 after the
 * sheet was cut down to frames 4-7 (now 0-3) would be read as out of bounds by
 * every downstream consumer, so clip to the exported window and shift.
 */
export function remapAsepriteTags(tags: AseTag[], from: number, to: number) {
  const out: {
    name: string;
    from: number;
    to: number;
    direction: AseTagDirection;
    repeat: number;
    color: string | null;
  }[] = [];
  for (const t of tags) {
    const lo = Math.max(t.from, from);
    const hi = Math.min(t.to, to);
    if (hi < lo) continue; // tag lies entirely outside the exported frames
    out.push({
      name: t.name,
      from: lo - from,
      to: hi - from,
      direction: t.direction,
      repeat: t.repeat,
      color: t.color ?? null,
    });
  }
  return out;
}

/** "#rrggbb", widened to "#rrggbbaa" only when the entry is not fully opaque. */
export function asepriteColorToHex(c: AseColor): string {
  const rgb = `#${byte(c.r)}${byte(c.g)}${byte(c.b)}`;
  return c.a === 255 ? rgb : `${rgb}${byte(c.a)}`;
}

function byte(n: number): string {
  return n.toString(16).padStart(2, "0");
}
