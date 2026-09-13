import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Command } from "commander";
import {
  addHelpExtras,
  fail,
  parseIntArg,
  sheetSizeFromSource,
  writeBinaryOutput,
  writeJsonOutput,
} from "../lib/common";
import {
  type AsepritePivotMode,
  detectExportInputKind,
  type GodotExportOptions,
  type GodotFile,
  type NormalizedDoc,
  normalizeExportInput,
  toAsepriteJson,
  toGodotAtlasTextureFiles,
  toGodotAtlasTextures,
  toGodotSpriteFrames,
  toPhaserAtlas,
  toUnityMeta,
} from "../../src/lib/export";

// JSON -> engine-project file. This command does no pixel work at all: it
// takes a metadata document that some earlier command already produced and
// re-shapes it for one engine's importer.

type ExportFormat = "godot" | "unity" | "aseprite" | "phaser";

const FORMATS: ExportFormat[] = ["godot", "unity", "aseprite", "phaser"];

const VARIANTS: Record<ExportFormat, string[]> = {
  godot: ["spriteframes", "atlastextures"],
  unity: [],
  aseprite: ["hash", "array"],
  phaser: ["hash", "array"],
};

/**
 * Flags that only mean something for one format. Passing `--ppu` to a Godot
 * export is a typo or a misunderstanding, and silently ignoring it would ship
 * a file that quietly lacks what the user asked for.
 */
const FORMAT_ONLY_FLAGS: Array<{ key: string; flag: string; format: ExportFormat }> = [
  { key: "resPath", flag: "--res-path", format: "godot" },
  { key: "loop", flag: "--no-loop", format: "godot" },
  { key: "ppu", flag: "--ppu", format: "unity" },
  { key: "assetPath", flag: "--asset-path", format: "unity" },
  { key: "guid", flag: "--guid", format: "unity" },
  { key: "physicsShape", flag: "--no-physics-shape", format: "unity" },
  { key: "pivots", flag: "--pivots", format: "aseprite" },
];

interface ExportOptions {
  format?: string;
  variant?: string;
  texture?: string;
  namePrefix?: string;
  fps: number;
  resPath?: string;
  loop: boolean;
  ppu?: number;
  assetPath?: string;
  guid?: string;
  physicsShape: boolean;
  pivots: string;
  output?: string;
}

export function registerExportCommand(program: Command) {
  const cmd = program
    .command("export <meta.json>")
    .description("Convert sprite metadata JSON into an engine-native project file.")
    .option("-f, --format <name>", `target engine (${FORMATS.join("|")}) — required`)
    .option(
      "--variant <v>",
      "format variant (godot: spriteframes|atlastextures; aseprite/phaser: hash|array)",
    )
    .option("--texture <name>", "override the texture filename referenced in the output")
    .option("--name-prefix <stem>", "override the frame-name stem (grid inputs only)")
    .option("--fps <n>", "default FPS for frames no tag covers", (v) => parseIntArg("fps", v), 10)
    .option("--res-path <path>", "[godot] res:// path of the sheet (default: res://<texture>)")
    .option("--no-loop", "[godot] mark animations as non-looping")
    .option("--ppu <n>", "[unity] pixels per unit", (v) => parseIntArg("ppu", v))
    .option("--asset-path <path>", "[unity] project-relative asset path — seeds the guid")
    .option("--guid <hex>", "[unity] reuse an existing .meta guid (32 hex chars)")
    .option("--no-physics-shape", "[unity] omit collision polygons, let Unity generate them")
    .option("--pivots <mode>", "[aseprite] omit|slices — carry pivots as a slice", "omit")
    .option("-o, --output <file>", "output file, '-' or omitted for stdout");

  addHelpExtras(cmd, {
    examples: [
      "sprite-tools export hero.json --format godot -o hero.tres",
      "sprite-tools export hero.json --format unity -o hero.png.meta --ppu 32",
      "sprite-tools export hero.json --format phaser --variant array -o hero-atlas.json",
      "",
      "# pipe straight out of a metadata pass — '-' reads JSON from stdin:",
      "sprite-tools meta hero.png --collision --pivot bottom-center \\",
      "  --tag idle=0-5 --tag run=6-11 | sprite-tools export - --format aseprite",
      "",
      "# a packed atlas manifest works too, and so does a jq merge of both:",
      "sprite-tools atlas hero/*.png --json atlas.json -o hero.png",
      "jq -s add hero-meta.json atlas.json | sprite-tools export - --format phaser",
      "",
      "# atlastextures is inherently one file per frame, so -o is a DIRECTORY:",
      "sprite-tools export hero.json --format godot --variant atlastextures -o ./frames",
    ],
    output: [
      "godot    .tres text  — SpriteFrames resource (default variant), or with",
      "                       --variant atlastextures one AtlasTexture per frame",
      "                       (-o <dir>; to stdout they are bundled, ';'-delimited)",
      "unity    .meta text  — TextureImporter YAML with a sprite per frame",
      "aseprite JSON        — { frames, meta: { size, frameTags, slices? } }",
      "phaser   JSON        — { frames, animations, meta } (Phaser 3 / Pixi atlas)",
      "",
      "Input is any sprite-tools metadata document: `meta`, a `jq -s add` merge of",
      "`collision`/`pivot`/`tags`, an `atlas --json` manifest, or a merge of those.",
    ],
  });

  cmd.action((input: string, opts: ExportOptions, command: Command) => {
    try {
      const format = resolveFormat(opts.format);
      const variant = resolveVariant(format, opts.variant);
      rejectForeignFlags(command, format);
      rejectInputAsOutput(input, opts.output, format, variant);

      const raw = readJsonInput(input);
      const kind = detectExportInputKind(raw);
      const sheetSize =
        kind === "grid" ? sheetSizeFromSource(raw, input === "-" ? null : input) : null;
      const doc = normalizeExportInput(raw, {
        texture: opts.texture,
        namePrefix: opts.namePrefix,
        defaultFps: opts.fps,
        sheetSize: sheetSize ?? undefined,
      });
      if (format === "unity" && kind === "grid" && !sheetSize && !hasRecordedSize(raw)) {
        // Unity flips every rect against the texture height, so a guessed height
        // shifts every sprite. Still export — hand-written docs are legitimate —
        // but say that the size was not confirmed against the image.
        process.stderr.write(
          `sprite-tools: warning: texture size ${doc.textureWidth}×${doc.textureHeight} was ` +
            "rebuilt from frameWidth × cols — the document records no sourceWidth/sourceHeight " +
            "and its source PNG was not found. If the real PNG is larger, every Unity rect is off.\n",
        );
      }

      switch (format) {
        case "godot": {
          const godotOpts = { texturePath: opts.resPath, loop: opts.loop };
          if (variant === "atlastextures") {
            writeGodotAtlasTextures(doc, godotOpts, opts.output);
          } else {
            writeText(toGodotSpriteFrames(doc, godotOpts), opts.output);
          }
          break;
        }
        case "unity":
          writeText(
            toUnityMeta(doc, {
              pixelsPerUnit: opts.ppu,
              assetPath: opts.assetPath,
              guid: opts.guid,
              physicsShape: opts.physicsShape,
            }),
            opts.output,
          );
          break;
        case "aseprite":
          writeJsonOutput(
            toAsepriteJson(doc, {
              format: variant === "array" ? "array" : "hash",
              pivots: resolvePivotMode(opts.pivots),
            }),
            opts.output,
          );
          break;
        case "phaser":
          writeJsonOutput(
            toPhaserAtlas(doc, { layout: variant === "array" ? "array" : "hash" }),
            opts.output,
          );
          break;
      }
    } catch (e) {
      fail(e instanceof Error ? e.message : String(e));
    }
  });
}

function resolveFormat(raw: string | undefined): ExportFormat {
  if (!raw) {
    fail(`--format is required (${FORMATS.join(", ")})`);
  }
  const want = raw.trim().toLowerCase();
  const match = FORMATS.find((f) => f === want);
  if (!match) {
    fail(`unknown --format "${raw}" (expected one of: ${FORMATS.join(", ")})`);
  }
  return match;
}

function resolveVariant(format: ExportFormat, raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const allowed = VARIANTS[format];
  if (allowed.length === 0) {
    fail(`--variant is not supported by --format ${format} (it has a single output shape)`);
  }
  const want = raw.trim().toLowerCase();
  if (!allowed.includes(want)) {
    fail(`unknown --variant "${raw}" for --format ${format} (expected: ${allowed.join(", ")})`);
  }
  return want;
}

function resolvePivotMode(raw: string): AsepritePivotMode {
  const want = raw.trim().toLowerCase();
  if (want !== "omit" && want !== "slices") {
    fail(`unknown --pivots "${raw}" (expected: omit, slices)`);
  }
  return want;
}

/**
 * `-o` naming the input file would replace the metadata with the engine file,
 * and that file cannot be exported again. The atlastextures variant writes a
 * directory, which can never be the input JSON.
 */
function rejectInputAsOutput(
  input: string,
  output: string | undefined,
  format: ExportFormat,
  variant: string | null,
): void {
  if (input === "-" || !output || output === "-") return;
  if (format === "godot" && variant === "atlastextures") return;
  if (resolve(input) === resolve(output)) {
    fail(`-o "${output}" is the input file — writing there would destroy the metadata`);
  }
}

function hasRecordedSize(raw: unknown): boolean {
  const rec = raw as { sourceWidth?: unknown; sourceHeight?: unknown };
  return typeof rec.sourceWidth === "number" && typeof rec.sourceHeight === "number";
}

/** Fail on a flag that belongs to a different --format, rather than dropping it. */
function rejectForeignFlags(command: Command, format: ExportFormat): void {
  for (const entry of FORMAT_ONLY_FLAGS) {
    if (entry.format === format) continue;
    if (command.getOptionValueSource(entry.key) === "cli") {
      fail(`${entry.flag} only applies to --format ${entry.format}, not ${format}`);
    }
  }
}

/**
 * Read a JSON document from a path, or from stdin when `path === "-"`. The
 * sibling image commands read PNG bytes the same way; this is the JSON twin so
 * `sprite-tools meta ... | sprite-tools export -` works without a temp file.
 */
function readJsonInput(path: string): unknown {
  let text: string;
  if (path === "-") {
    // fd 0 is stdin. readFileSync(0) blocks until EOF.
    const buf = readFileSync(0);
    if (buf.length === 0) throw new Error("no bytes on stdin — pipe a metadata JSON document in");
    text = buf.toString("utf8");
  } else {
    if (!existsSync(path) || !statSync(path).isFile()) {
      throw new Error(`Not a file: ${path}`);
    }
    text = readFileSync(path, "utf8");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (e) {
    // JSON.parse's own message names an offset but not the file, which is
    // useless in a pipeline of three commands.
    const detail = e instanceof Error ? e.message : String(e);
    throw new Error(`${path === "-" ? "<stdin>" : path}: invalid JSON — ${detail}`);
  }
}

/** Text formats own their own trailing newline; add one only if it is missing. */
function writeText(text: string, outPath?: string): void {
  const body = text.endsWith("\n") ? text : `${text}\n`;
  writeBinaryOutput(Buffer.from(body, "utf8"), outPath);
}

/**
 * A `.tres` holds exactly one resource, so N AtlasTextures are N files. With a
 * real `-o` they are written into it as a directory; to stdout they can only be
 * a `; <filename>`-delimited bundle, which is a preview, not an importable file.
 */
function writeGodotAtlasTextures(
  doc: NormalizedDoc,
  godotOpts: GodotExportOptions,
  outPath?: string,
): void {
  if (!outPath || outPath === "-") {
    writeText(toGodotAtlasTextures(doc, godotOpts), outPath);
    return;
  }
  // `-o hero.tres` reads like "write one file", but this variant writes N — so
  // it would silently become a DIRECTORY named hero.tres, which Godot then
  // shows as a folder. Refuse the ambiguous spelling instead of guessing.
  const isDir = existsSync(outPath) && statSync(outPath).isDirectory();
  if (!isDir && outPath.toLowerCase().endsWith(".tres")) {
    throw new Error(
      `--variant atlastextures writes one .tres per frame, so -o must be a directory, ` +
        `got the filename "${outPath}". Pass e.g. -o ./frames, or use --variant spriteframes ` +
        "for a single file.",
    );
  }
  if (existsSync(outPath) && !isDir) {
    throw new Error(`-o "${outPath}" exists and is not a directory.`);
  }
  const files: GodotFile[] = toGodotAtlasTextureFiles(doc, godotOpts);
  mkdirSync(outPath, { recursive: true });
  for (const file of files) {
    writeText(file.content, join(outPath, file.filename));
  }
  // Silent success on stdout; the count goes to stderr like `slice` does.
  process.stderr.write(`wrote ${files.length} AtlasTexture resources → ${outPath}\n`);
}
