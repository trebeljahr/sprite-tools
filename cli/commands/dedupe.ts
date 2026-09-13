import { readFileSync } from "node:fs";
import type { Command } from "commander";
import {
  writeJsonOutput,
  writeBinaryOutput,
  fail,
  parseFloatArg,
  parseIntArg,
  loadSheet,
  addHelpExtras,
  addGridOptions,
  gridPaddingFromOpts,
  type GridPaddingOpts,
} from "../lib/common";
import { imageToPngBuffer, stitchSheet } from "../lib/image-io";
import {
  applyDedupe,
  buildTagPartitions,
  findDuplicateFrames,
  parseTagsDocument,
  remapFrameDurations,
  remapTags,
  type DedupeResult,
  type ParsedTagsDocument,
} from "../../src/lib/pipeline/dedupe-core";

// Duplicate / near-duplicate frame removal.
//
// Fixed-FPS video extraction and AI frame generation both emit sheets that are
// mostly redundant copies, and nothing else in the pipeline notices. The risky
// part is not finding the duplicates — it is that removing frames renumbers
// every animation tag pointing past them, so this command also rewrites a tags
// JSON through the remap instead of leaving the user with silently broken tags.

export function registerDedupeCommand(program: Command) {
  const cmd = program
    .command("dedupe <input>")
    .description("Find (and optionally remove) duplicate / near-duplicate frames.")
    .option("--cols <n>", "columns (auto-detected if omitted)", (v) => parseIntArg("cols", v))
    .option("--rows <n>", "rows (auto-detected if omitted)", (v) => parseIntArg("rows", v))
    .option(
      "--threshold <n>",
      "max mean absolute RGBA difference (0 = byte-identical only)",
      (v) => {
        const n = parseFloatArg("threshold", v);
        // The core would clamp a negative to 0 and silently run an exact-only
        // pass; a typo like `-2` for `2` deserves an error instead (MCP: min(0)).
        if (n < 0) fail(`threshold: expected a number >= 0, got ${v}`);
        return n;
      },
      0,
    )
    .option("--tags <file>", "tags JSON to rewrite through the remap")
    .option("--tags-out <file>", "also write the rewritten tags as a standalone tags JSON")
    .option("--respect-tags", "never merge across a tag boundary (requires --tags)", false)
    .option("--sheet <file>", "also write the deduped sheet PNG ('-' for stdout)")
    .option("--sheet-cols <n>", "columns for the output sheet (default: input cols)", (v) =>
      parseIntArg("sheet-cols", v),
    )
    .option("-o, --output <file>", "output JSON file (default: stdout)");

  addGridOptions(cmd);

  addHelpExtras(cmd, {
    examples: [
      "sprite-tools dedupe sheet.png                       # report exact duplicates only",
      "sprite-tools dedupe sheet.png --threshold 2 -o dedupe.json",
      "sprite-tools dedupe sheet.png --threshold 1 --sheet clean.png -o dedupe.json",
      "sprite-tools dedupe sheet.png --tags hero.json --tags-out hero-deduped.json \\",
      "  --sheet clean.png -o dedupe.json",
      "sprite-tools dedupe sheet.png --threshold 3 --tags hero.json --respect-tags",
      "",
      "--threshold is the mean absolute difference per RGBA channel on a 0-255 scale,",
      "averaged over every channel of every pixel. 0 requires byte-identical frames. 1",
      "means the average channel differs by 1/255 (~0.4%), the scale of rounding noise",
      "from lossy video compression or canvas alpha premultiplication. 2-4 absorbs a",
      "handful of stray pixels. Above ~8 visibly different poses start collapsing. The",
      "comparison is inclusive (<= threshold).",
      "",
      "Alpha participates: an alpha difference adds to the distance like any other",
      "channel. At --threshold 0 an alpha-only change is never a duplicate; at a higher",
      "threshold it merges once its distance is at or below the threshold. RGB under a",
      "fully transparent pixel is ignored (read as 0), so invisible colour never counts.",
      "Byte-identical frames always merge first, before any fuzzy matching gets a say.",
      "Matching is greedy first-match against group representatives only, so a~b and",
      "b~c never collapses a with c.",
      "",
      "--tags reads the shape `sprite-tools tags` emits ({ tags: [...] }; a bare array",
      "works too) and rewrites every range through the remap. The remapped tags are",
      "always in the main JSON under `tags`; --tags-out (requires --tags) additionally",
      "writes them as a standalone tags JSON describing the deduped sheet, with its",
      "`source` set to --sheet when that names a file, plus the warnings. A top-level",
      "`frameDurations` array is carried through: each kept frame takes the first",
      "explicit hold in its duplicate group. `frames` is the authoritative playback",
      "order — from/to are only min/max, and are meaningless when contiguous is false.",
      "A range goes non-contiguous when a frame matched a frame outside the tag, or",
      "when the tag repeats one of its own poses non-adjacently. --respect-tags confines",
      "merging to within each tag (frames outside every tag share one partition of",
      "their own), which removes only the first cause.",
      "",
      "--sheet keeps the kept frames in source order, `--sheet-cols` columns wide",
      "(default: the input's columns), rows = ceil(uniqueCount / cols). Trailing cells",
      "in the last row are left fully transparent.",
    ],
    output: [
      "{ source, frameWidth, frameHeight, grid, frameCount,",
      "  method: 'exact' | 'mae', threshold, uniqueCount, removedCount,",
      "  keptIndices: [oldIndex, ...],",
      "  remap: [newIndexOfRepresentative, ...],   // one entry per OLD frame",
      "  groups: [{ keep, duplicates: [...], distances: [...] }, ...],",
      "  tags?: [{ name, from, to, direction?, fps?, frames: [...], contiguous }],",
      "  warnings?: [string, ...] }",
    ],
  });

  cmd.action(
    (
      input: string,
      opts: {
        cols?: number;
        rows?: number;
        threshold: number;
        tags?: string;
        tagsOut?: string;
        respectTags: boolean;
        sheet?: string;
        sheetCols?: number;
        output?: string;
      } & GridPaddingOpts,
    ) => {
      try {
        if (opts.respectTags && !opts.tags) {
          fail("--respect-tags needs --tags <file> to derive partitions from");
        }
        if (opts.tagsOut && !opts.tags) {
          fail("--tags-out needs --tags <file> — there are no tags to rewrite");
        }
        // Both would land on stdout and interleave into unusable bytes.
        if (opts.sheet === "-" && (!opts.output || opts.output === "-")) {
          fail("--sheet - and the JSON would both go to stdout; pass -o <file> for the JSON");
        }

        const { frames, grid } = loadSheet(input, opts.cols, opts.rows, gridPaddingFromOpts(opts));
        const frameCount = frames.length;
        const warnings: string[] = [];

        const doc = opts.tags ? readTagsFile(opts.tags) : undefined;
        const tags = doc?.tags;
        let partitions: number[] | undefined;
        if (opts.respectTags && tags) {
          const built = buildTagPartitions(tags, frameCount);
          partitions = built.partitions;
          warnings.push(...built.warnings.map((w) => `--respect-tags: ${w}`));
        }

        const result = findDuplicateFrames(frames, { threshold: opts.threshold, partitions });

        let remappedTags: ReturnType<typeof remapTags>["tags"] | undefined;
        if (tags) {
          const remapped = remapTags(tags, result);
          remappedTags = remapped.tags;
          warnings.push(...remapped.warnings);
        }

        if (opts.sheet) {
          const sheet = buildSheet(frames, result, opts.sheetCols ?? grid.cols);
          writeBinaryOutput(imageToPngBuffer(sheet), opts.sheet);
        }

        if (opts.tagsOut && remappedTags) {
          const wroteSheet = opts.sheet !== undefined && opts.sheet !== "-";
          if (!wroteSheet) {
            warnings.push(
              "--tags-out: tags were renumbered for the deduplicated frame order, but no deduplicated sheet file was written — re-run with --sheet <file>, or the rewritten tags will not match any sheet on disk",
            );
          }
          const frameDurations = remapFrameDurations(doc?.frameDurations, result);
          writeJsonOutput(
            {
              // The indices describe the deduped sheet, so point at it when it exists.
              source: wroteSheet ? opts.sheet : input,
              frameWidth: frames[0]?.width ?? 0,
              frameHeight: frames[0]?.height ?? 0,
              grid: sheetGrid(result.uniqueCount, opts.sheetCols ?? grid.cols),
              frameCount: result.uniqueCount,
              tags: remappedTags,
              ...(frameDurations ? { frameDurations } : {}),
              warnings,
            },
            opts.tagsOut,
          );
        }

        writeJsonOutput(
          {
            source: input,
            frameWidth: frames[0]?.width ?? 0,
            frameHeight: frames[0]?.height ?? 0,
            grid: { cols: grid.cols, rows: grid.rows, detected: grid.detected },
            frameCount,
            method: result.method,
            threshold: result.threshold,
            uniqueCount: result.uniqueCount,
            removedCount: result.removedCount,
            keptIndices: result.keptIndices,
            remap: result.remap,
            groups: result.groups,
            ...(remappedTags ? { tags: remappedTags } : {}),
            ...(tags ? { warnings } : {}),
          },
          opts.output,
        );
      } catch (e) {
        fail(e instanceof Error ? e.message : String(e));
      }
    },
  );
}

/** Kept frames in source order, packed into a cols-wide grid; trailing cells stay transparent. */
function buildSheet(frames: ImageData[], result: DedupeResult, cols: number): ImageData {
  if (cols <= 0) fail(`sheet-cols: expected a positive integer, got ${cols}`);
  const kept = applyDedupe(frames, result);
  if (kept.length === 0) fail("nothing left to write — the sheet has no frames");
  const { cols: c, rows } = sheetGrid(kept.length, cols);
  return stitchSheet(kept, c, rows);
}

function sheetGrid(count: number, cols: number): { cols: number; rows: number; detected: false } {
  // The column count is kept even when it outruns the frames — the last row is
  // simply short, and stitchSheet leaves those cells fully transparent.
  const c = Math.max(1, cols);
  return { cols: c, rows: Math.max(1, Math.ceil(count / c)), detected: false };
}

/** File I/O and error wrapping only; the validation lives in dedupe-core, shared with MCP. */
function readTagsFile(path: string): ParsedTagsDocument {
  try {
    return parseTagsDocument(JSON.parse(readFileSync(path, "utf8")));
  } catch (e) {
    fail(`--tags ${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
}
