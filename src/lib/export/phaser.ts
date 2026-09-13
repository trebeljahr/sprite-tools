// Phaser 3 / PixiJS texture-atlas JSON.
//
// One document serves both runtimes because their parsers overlap almost
// completely — the differences are which container `frames` uses and where the
// animation list lives:
//
//   Phaser  `TextureManager.addAtlas` dispatches on the shape of `frames`:
//           an object -> Parsers.JSONHash, an array -> Parsers.JSONArray.
//           There is no format flag; `this.load.atlas` accepts either.
//   Pixi    `spritesheetAsset` requires `frames` to be an object and reads a
//           top-level `animations` map. An array parses, but every frame ends
//           up named "0", "1", ... — so "hash" is the portable default.
//
// Pure NormalizedDoc -> object. No filesystem access, no pixel math.

import {
  type ExportPoint,
  type ExportRect,
  type ExportSize,
  type NormalizedDoc,
  type NormalizedFrame,
  basename,
  expandTagFrameIndices,
  toAsepriteDirection,
} from "./types";

/** `frames` as an object keyed by name (JSONHash) or as an array (JSONArray). */
export type PhaserFramesLayout = "hash" | "array";

/**
 * "keep" uses the normalized frame names. "index" renames every frame to its
 * bare 0-based index ("0", "1", ...), which is the only naming Phaser's
 * `createFromAseprite` can resolve — see `frameTags` below.
 */
export type PhaserFrameNaming = "keep" | "index";

export interface PhaserExportOptions {
  /** Default "hash" — the only layout PixiJS accepts as real frame names. */
  layout?: PhaserFramesLayout;
  /** Override `meta.image`. Reduced to a basename either way. */
  image?: string;
  /** Default "RGBA8888". Aseprite writes "I8" for indexed/grayscale sheets. */
  format?: string;
  /**
   * `meta.scale`. Default is the **string** "1": Aseprite hardcodes the string
   * and Pixi's loader-facing type declares it as one, while Pixi's runtime
   * `parseFloat`s it and Phaser ignores it. A number works but round-trips
   * badly against Aseprite-shaped fixtures.
   */
  scale?: string | number;
  /** `meta.app` provenance string. */
  app?: string;
  /** `meta.version` provenance string. */
  version?: string;
  /** Default "keep". */
  frameNames?: PhaserFrameNaming;
  /** Emit `meta.frameTags`. Default true. */
  frameTags?: boolean;
  /** Emit the top-level Pixi `animations` map. Default true. */
  animations?: boolean;
  /** Emit per-frame `anchor` for frames that carry a pivot. Default true. */
  anchors?: boolean;
  /**
   * Sibling pack filenames for `meta.related_multi_packs`. Bare filenames only
   * — Pixi resolves each as `dirname(thisFile) + "/" + entry`. List them on the
   * FIRST pack only and load only that one: a mutual reference (pack 1 also
   * naming pack 0) deadlocks `Assets.load()` forever (pixijs#8833).
   */
  relatedMultiPacks?: string[];
}

export interface PhaserFrameData {
  /** JSONArray only, and first — without it Phaser registers every frame under
   *  the key `undefined` and rejects all but the first as a duplicate. */
  filename?: string;
  frame: ExportRect;
  rotated: boolean;
  trimmed: boolean;
  spriteSourceSize: ExportRect;
  sourceSize: ExportSize;
  /** Normalized 0..1. Read by Pixi (`Texture.defaultAnchor`) and by Phaser,
   *  which checks `anchor` before falling back to `pivot`. */
  anchor?: ExportPoint;
  /** Integer milliseconds, as Aseprite writes it. */
  duration: number;
}

export interface PhaserFrameTag {
  name: string;
  /** Inclusive. */
  from: number;
  /** Inclusive. */
  to: number;
  /**
   * Aseprite's spelling (`pingpong_reverse`), because `meta.frameTags` is
   * Aseprite's structure and only Aseprite-shaped readers look at it.
   */
  direction: ReturnType<typeof toAsepriteDirection>;
}

export interface PhaserAtlasMeta {
  app: string;
  version: string;
  image: string;
  format: string;
  size: ExportSize;
  scale: string | number;
  related_multi_packs?: string[];
  frameTags?: PhaserFrameTag[];
}

export interface PhaserAtlas {
  frames: Record<string, PhaserFrameData> | PhaserFrameData[];
  /** Pixi's animation source: name -> frame names in playback order. */
  animations?: Record<string, string[]>;
  meta: PhaserAtlasMeta;
}

const DEFAULT_APP = "https://sprites.trebeljahr.com";
// Not read from package.json: this module is bundled into the web surface and
// must stay a dependency-free pure transform. It is provenance, not a contract.
const DEFAULT_VERSION = "1.0";
const DEFAULT_FORMAT = "RGBA8888";
const DEFAULT_SCALE = "1";

/**
 * Build a Phaser 3 / PixiJS texture atlas document.
 *
 * Returns a plain object; the caller decides how to serialize it. Deterministic
 * — the same doc and options always produce the same object.
 */
export function toPhaserAtlas(doc: NormalizedDoc, opts: PhaserExportOptions = {}): PhaserAtlas {
  const layout: PhaserFramesLayout = opts.layout ?? "hash";
  const names = frameNames(doc.frames, opts.frameNames ?? "keep");
  const wantAnchors = opts.anchors !== false;

  const built = doc.frames.map((frame, i) => buildFrame(frame, names[i], layout, wantAnchors));

  const frames: PhaserAtlas["frames"] =
    layout === "array"
      ? built
      : Object.fromEntries(built.map((entry, i) => [names[i], entry] as const));

  const animations = opts.animations !== false ? buildAnimations(doc, names) : {};

  return {
    frames,
    // An empty map is noise — Pixi treats an absent one identically. Sits
    // between frames and meta to match the shape Pixi's own docs show.
    ...(Object.keys(animations).length > 0 ? { animations } : {}),
    meta: buildMeta(doc, opts),
  };
}

function buildFrame(
  frame: NormalizedFrame,
  name: string,
  layout: PhaserFramesLayout,
  wantAnchors: boolean,
): PhaserFrameData {
  const out: PhaserFrameData = {
    // JSONHash takes the name from the object key and never reads `filename`;
    // Aseprite's hash output omits it too, so keep the shapes distinct.
    ...(layout === "array" ? { filename: name } : {}),
    frame: { ...frame.frame },
    // Always false — the packer never rotates. Both parsers honour `true` from
    // other packers, so the key is emitted rather than assumed.
    rotated: frame.rotated,
    // Emitted even when false: Pixi tests `data.trimmed !== false`, so an
    // absent flag counts as trimmed and shifts untrimmed sprites.
    trimmed: frame.trimmed,
    spriteSourceSize: { ...frame.spriteSourceSize },
    sourceSize: { ...frame.sourceSize },
    duration: frame.durationMs,
  };

  const anchor = wantAnchors ? toAnchor(frame) : null;
  if (anchor) out.anchor = anchor;
  return out;
}

/**
 * Pivot px (top-left origin, relative to the untrimmed canvas) -> normalized
 * anchor. Both runtimes rebuild the untrimmed extent from
 * `sourceSize`/`spriteSourceSize` and apply the anchor against that, so
 * `sourceSize` is the correct divisor for trimmed and untrimmed frames alike.
 *
 * Only `anchor` is emitted. Phaser also accepts `pivot`, but it checks `anchor`
 * first, so a second key would be dead weight that could drift out of sync.
 */
function toAnchor(frame: NormalizedFrame): ExportPoint | null {
  const pivot = frame.pivot;
  if (!pivot) return null;
  const { w, h } = frame.sourceSize;
  if (w <= 0 || h <= 0) return null;
  return { x: round6(pivot.x / w), y: round6(pivot.y / h) };
}

function buildMeta(doc: NormalizedDoc, opts: PhaserExportOptions): PhaserAtlasMeta {
  // Both loaders concatenate this onto the JSON's own directory, so a path or
  // URL here breaks texture resolution.
  const image = basename(opts.image ?? doc.texture);

  const meta: PhaserAtlasMeta = {
    app: opts.app ?? DEFAULT_APP,
    version: opts.version ?? DEFAULT_VERSION,
    image,
    format: opts.format ?? DEFAULT_FORMAT,
    size: { w: doc.textureWidth, h: doc.textureHeight },
    scale: opts.scale ?? DEFAULT_SCALE,
  };

  const packs = normalizeMultiPacks(opts.relatedMultiPacks);
  if (packs) meta.related_multi_packs = packs;

  // `meta.frameTags` is Aseprite's vocabulary, and Phaser's
  // `createFromAseprite` is the only thing that reads it — but that path also
  // resolves frames by `frames[i.toString()]`, so it finds nothing unless the
  // frame names are the bare indices (`frameNames: "index"`). For a file aimed
  // squarely at `this.load.aseprite` + `createFromAseprite`, the aseprite
  // exporter is the right output; this one stays an atlas and carries the tags
  // as metadata that survives on `texture.customData.meta`.
  if (opts.frameTags !== false && doc.tags.length > 0) {
    meta.frameTags = doc.tags.map((tag) => ({
      name: tag.name,
      from: tag.from,
      to: tag.to,
      direction: toAsepriteDirection(tag.direction),
    }));
  }

  return meta;
}

/**
 * Pixi's `animations` map. Directions are baked into the frame order because
 * Pixi has no direction concept: `reverse` reverses the list, `pingpong`
 * appends the interior frames backwards (Aseprite's convention — endpoints are
 * not repeated), and `pingpong-reverse` is that round trip started from `to`.
 */
function buildAnimations(doc: NormalizedDoc, names: string[]): Record<string, string[]> {
  // A Map, not an object: `in` on a plain object also sees Object.prototype, so
  // a tag named `constructor` would be renamed for colliding with nothing, and
  // assigning `animations["__proto__"]` would swap the prototype instead of
  // adding a key. Object.fromEntries defines own properties, `__proto__` included.
  const animations = new Map<string, string[]>();
  for (const tag of doc.tags) {
    const frames = expandTagFrameIndices(tag)
      .filter((index) => index >= 0 && index < names.length)
      .map((index) => names[index]);
    if (frames.length === 0) continue;
    // Object keys collapse, so two tags sharing a name would silently lose
    // one. Suffix instead, matching how the normalizer dedupes frame names.
    animations.set(uniqueKey(tag.name, animations), frames);
  }
  return Object.fromEntries(animations);
}

function frameNames(frames: NormalizedFrame[], naming: PhaserFrameNaming): string[] {
  // Bare indices are unique by construction; normalized names already are.
  return naming === "index" ? frames.map((_, i) => String(i)) : frames.map((frame) => frame.name);
}

function normalizeMultiPacks(raw: string[] | undefined): string[] | undefined {
  if (!raw || raw.length === 0) return undefined;
  const packs: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string" || entry.trim() === "") {
      throw new Error(
        "export: related_multi_packs entries must be non-empty filenames, got " +
          `${JSON.stringify(entry)}.`,
      );
    }
    if (entry !== basename(entry) || entry === "." || entry === "..") {
      throw new Error(
        `export: related_multi_packs entry ${JSON.stringify(entry)} must be a bare sibling ` +
          'filename — Pixi resolves each entry as dirname(thisFile) + "/" + entry, so a ' +
          'path, a URL, or a "./" prefix will not load.',
      );
    }
    if (!packs.includes(entry)) packs.push(entry);
  }
  return packs;
}

function uniqueKey(base: string, taken: Map<string, unknown>): string {
  const stem = base || "animation";
  if (!taken.has(stem)) return stem;
  let n = 2;
  while (taken.has(`${stem}_${n}`)) n++;
  return `${stem}_${n}`;
}

/** Keeps float noise (0.30000000000000004) out of the emitted JSON. */
function round6(v: number): number {
  const rounded = Math.round(v * 1e6) / 1e6;
  return Object.is(rounded, -0) ? 0 : rounded;
}
