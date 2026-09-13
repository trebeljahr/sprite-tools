// Aseprite JSON Data exporter — the `--data sheet.json` shape, both variants.
//
// The layout here is read off Aseprite's own writer
// (`DocExporter::createDataFile`, src/app/doc_exporter.cpp), not off what some
// importer happens to tolerate. Two details look like bugs and are not:
// `"rotated"` is a hardcoded `false` (Aseprite has no rotation packing), and
// `"scale"` is the *string* `"1"`. Both are reproduced verbatim so a file we
// write diffs cleanly against one Aseprite wrote.
//
// Not carried, because Aseprite's format has nowhere to put them:
//   - collision polygons (`NormalizedFrame.polygon`) — passthrough-only in
//     Phaser (`frame.customData`), dropped by Pixi, so inventing a key would
//     produce a file that only sprite-tools can read.
//   - pivots, except via the opt-in `pivots: "slices"` mode below. Aseprite
//     has no per-frame pivot key at all; `meta.slices[].keys[].pivot` is the
//     only pivot the format has ever carried.

import { basename, type NormalizedDoc, type NormalizedFrame, stripExtension } from "./types";

/** `--format json-hash` (Aseprite's default) or `--format json-array`. */
export type AsepriteFormat = "hash" | "array";

/**
 * How frames are named. Aseprite's own default is `"aseprite"`, but the bare
 * index is what engines can actually consume, so it is ours.
 */
export type AsepriteFrameNaming = "index" | "aseprite" | "normalized";

/** How to carry pivots, which the format has no per-frame slot for. */
export type AsepritePivotMode = "omit" | "slices";

export interface AsepriteExportOptions {
  /** Default `"hash"`, matching `SpriteSheetDataFormat::Default`. */
  format?: AsepriteFormat;
  /**
   * Default `"index"` — bare `"0"`, `"1"`, … Phaser's `createFromAseprite`
   * resolves tag frames with `frames[i.toString()]`, so any other naming makes
   * it build empty animations *silently*; Aseprite users are told to set
   * "Item Filename" to `{frame}` for exactly this reason.
   *   - `"aseprite"`   — `"hero 0.aseprite"`, what a default Aseprite export writes.
   *   - `"normalized"` — the names `normalizeExportInput` resolved (atlas manifest keys).
   */
  frameNames?: AsepriteFrameNaming;
  /** Default `"omit"`. `"slices"` emits one `meta.slices` entry, keyed per frame. */
  pivots?: AsepritePivotMode;
  /** Name of the slice written in `pivots: "slices"` mode. Default `"pivot"`. */
  pivotSliceName?: string;
  /** `meta.app`. Default is this tool's homepage — see `DEFAULT_APP`. */
  app?: string;
  /** `meta.version`. Default `DEFAULT_VERSION`. */
  version?: string;
  /** `meta.image`. Defaults to the doc's texture; always reduced to a basename. */
  image?: string;
  /** `meta.format`. Default `"RGBA8888"`. */
  pixelFormat?: AsepritePixelFormat;
}

/** `RGBA8888` for RGB sheets; Aseprite maps both indexed and grayscale to `I8`. */
export type AsepritePixelFormat = "RGBA8888" | "I8";

export interface AsepriteRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface AsepriteSize {
  w: number;
  h: number;
}

export interface AsepriteFrameEntry {
  frame: AsepriteRect;
  rotated: boolean;
  trimmed: boolean;
  spriteSourceSize: AsepriteRect;
  sourceSize: AsepriteSize;
  /** Integer milliseconds, per frame. */
  duration: number;
}

/** A frame entry in the array variant, where the name rides along as a key. */
export interface AsepriteArrayFrameEntry extends AsepriteFrameEntry {
  filename: string;
}

/**
 * Aseprite's direction vocabulary. `pingpong_reverse` exists in Aseprite 1.3+
 * but has no source in our `Direction` union, so this exporter never emits it.
 */
export type AsepriteDirection = "forward" | "reverse" | "pingpong";

export interface AsepriteFrameTag {
  name: string;
  /** Inclusive. */
  from: number;
  /** Inclusive. */
  to: number;
  direction: AsepriteDirection;
}

export interface AsepriteSliceKey {
  /** The frame this key takes effect from; it holds until the next key. */
  frame: number;
  /** Sprite-canvas coordinates, top-left origin. */
  bounds: AsepriteRect;
  /** px, relative to the slice origin. */
  pivot?: { x: number; y: number };
}

export interface AsepriteSlice {
  name: string;
  keys: AsepriteSliceKey[];
}

export interface AsepriteMeta {
  app: string;
  version: string;
  image: string;
  format: AsepritePixelFormat;
  size: AsepriteSize;
  /** A string, not a number — Aseprite hardcodes `"1"`. */
  scale: string;
  frameTags?: AsepriteFrameTag[];
  slices?: AsepriteSlice[];
}

export interface AsepriteHashDocument {
  frames: Record<string, AsepriteFrameEntry>;
  meta: AsepriteMeta;
}

export interface AsepriteArrayDocument {
  frames: AsepriteArrayFrameEntry[];
  meta: AsepriteMeta;
}

export type AsepriteDocument = AsepriteHashDocument | AsepriteArrayDocument;

/**
 * Aseprite puts its own homepage in `meta.app`. Claiming to be Aseprite would
 * be a lie, and it buys nothing: no importer reads this field (Phaser and Pixi
 * both ignore it, and it is platform-dependent in real Aseprite output, so
 * nothing sane asserts on it). A URL keeps the field's shape honest.
 */
export const DEFAULT_APP = "https://sprites.trebeljahr.com";

/** Our exporter's format revision, not an Aseprite build string. */
export const DEFAULT_VERSION = "1.0";

/** Hardcoded in Aseprite's writer, and a string. Pixi does `parseFloat` on it. */
const SCALE = "1";

/**
 * Aseprite's default frame duration, used for frames no tag covers. The
 * normalizer already resolves durations, so this is only a floor.
 */
const MIN_DURATION_MS = 1;

/** Renders a `NormalizedDoc` as an Aseprite JSON Data document. */
export function toAsepriteJson(
  doc: NormalizedDoc,
  opts: AsepriteExportOptions = {},
): AsepriteDocument {
  const naming = opts.frameNames ?? "index";
  const names = resolveFrameNames(doc, naming);

  const meta: AsepriteMeta = {
    app: opts.app ?? DEFAULT_APP,
    version: opts.version ?? DEFAULT_VERSION,
    // Both Pixi's loader and Phaser's multiatlas resolve this against the JSON
    // file's own directory, so a path here would break them.
    image: basename(opts.image ?? doc.texture),
    format: opts.pixelFormat ?? "RGBA8888",
    size: { w: int(doc.textureWidth), h: int(doc.textureHeight) },
    scale: SCALE,
  };

  // Aseprite omits frameTags entirely unless tags were requested; with nothing
  // to say we say nothing rather than emitting an empty array.
  if (doc.tags.length > 0) {
    meta.frameTags = doc.tags.map((tag) => ({
      name: tag.name,
      from: tag.from,
      to: tag.to,
      direction: tag.direction,
    }));
  }

  if ((opts.pivots ?? "omit") === "slices") {
    const slice = buildPivotSlice(doc, opts.pivotSliceName ?? "pivot");
    if (slice) meta.slices = [slice];
  }

  if ((opts.format ?? "hash") === "array") {
    return {
      frames: doc.frames.map((frame, i) => ({
        // The array variant's name is a property, written first.
        filename: names[i],
        ...frameEntry(frame),
      })),
      meta,
    };
  }

  const frames: Record<string, AsepriteFrameEntry> = {};
  doc.frames.forEach((frame, i) => {
    frames[names[i]] = frameEntry(frame);
  });
  return { frames, meta };
}

/** Key order here is Aseprite's write order, and every key is unconditional. */
function frameEntry(frame: NormalizedFrame): AsepriteFrameEntry {
  return {
    frame: rect(frame.frame),
    // Constant in Aseprite's writer. Importers tolerate `true` from other
    // packers; our packer, like Aseprite's, never rotates.
    rotated: false,
    trimmed: frame.trimmed,
    spriteSourceSize: rect(frame.spriteSourceSize),
    sourceSize: { w: int(frame.sourceSize.w), h: int(frame.sourceSize.h) },
    // Milliseconds. Omitting it makes Phaser fall back to MAX_SAFE_INTEGER,
    // i.e. an animation that never advances.
    duration: Math.max(MIN_DURATION_MS, int(frame.durationMs)),
  };
}

function resolveFrameNames(doc: NormalizedDoc, naming: AsepriteFrameNaming): string[] {
  if (naming === "normalized") return doc.frames.map((frame) => frame.name);
  if (naming === "index") return doc.frames.map((frame) => String(frame.index));

  // Aseprite's default item filename is `{title} {frame}.{extension}`, where
  // both title and extension come from the *source document* (so `.aseprite`,
  // not `.png`), and the ` {frame}` half is dropped for a single-frame sprite.
  const document = doc.source ?? doc.texture;
  const title = stripExtension(basename(document)) || "sprite";
  const ext = extension(basename(document));
  const suffix = ext ? `.${ext}` : "";
  if (doc.frames.length === 1) return [`${title}${suffix}`];
  return doc.frames.map((frame) => `${title} ${frame.index}${suffix}`);
}

/**
 * One slice carrying every frame's pivot. Aseprite slice bounds are in *sprite
 * canvas* coordinates (not sheet coordinates) and the pivot is relative to the
 * slice origin, so the untrimmed canvas is the natural bounds and the pivot
 * passes through unchanged. Frames without a pivot get no key and therefore
 * inherit the preceding one, which is how Aseprite's own slice keys behave.
 */
function buildPivotSlice(doc: NormalizedDoc, name: string): AsepriteSlice | null {
  const keys: AsepriteSliceKey[] = [];
  for (const frame of doc.frames) {
    if (!frame.pivot) continue;
    keys.push({
      frame: frame.index,
      bounds: { x: 0, y: 0, w: int(frame.sourceSize.w), h: int(frame.sourceSize.h) },
      pivot: { x: int(frame.pivot.x), y: int(frame.pivot.y) },
    });
  }
  return keys.length > 0 ? { name, keys } : null;
}

function rect(r: { x: number; y: number; w: number; h: number }): AsepriteRect {
  return { x: int(r.x), y: int(r.y), w: int(r.w), h: int(r.h) };
}

/** Aseprite writes no floats anywhere in this format. */
function int(n: number): number {
  return Math.round(n);
}

/** Extension without its dot; empty when the name has none. */
function extension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1) : "";
}
