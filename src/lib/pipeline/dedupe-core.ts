// Duplicate / near-duplicate sprite frame detection and removal.
//
// Fixed-FPS extraction (import.ts samples video at 10fps, so a four-pose
// animation arrives as dozens of frames) and AI frame generation both produce
// heavy frame duplication. Nothing else in the pipeline notices it, so users
// pack, key and ship sheets that are mostly redundant copies. This module finds
// those frames, decides which one survives, and — the part that actually makes
// dedupe safe — renumbers the animation tags that point at them.
//
// Pure math on a plain ImageData-like shape, so the browser UI, the Node CLI
// and the MCP server all share one implementation. No DOM dependencies here.

import { type FrameDurations, normalizeFrameDurations } from "../animation/durations";

export interface FrameImageLike {
  width: number;
  height: number;
  data: Uint8ClampedArray | Uint8Array;
}

export type DedupeMethod = "exact" | "mae";

export interface DedupeConfig {
  /**
   * 0 = exact byte equality only. > 0 = max mean absolute RGBA difference (0-255 scale).
   *
   * threshold is the mean absolute difference per RGBA channel on a 0-255 scale,
   * averaged over every channel of every pixel. 0 requires byte-identical frames. 1 means the
   * average channel differs by 1/255 (~0.4%), the scale of rounding noise from lossy video
   * compression or canvas alpha premultiplication. 2-4 absorbs a handful of stray pixels.
   * Above ~8 visibly different poses start collapsing.
   */
  threshold: number;
  /** Optional partition id per frame; frames only ever merge with frames in the same
   *  partition. Used to stop a tag losing frames to another tag (it cannot stop a tag's
   *  own repeated poses from merging). Length must equal frames.length. */
  partitions?: number[];
}

export interface DuplicateGroup {
  keep: number;
  duplicates: number[];
  distances: number[];
}

export interface DedupeResult {
  method: DedupeMethod;
  threshold: number;
  frameCount: number;
  uniqueCount: number;
  removedCount: number;
  keptIndices: number[];
  remap: number[];
  groups: DuplicateGroup[];
}

// ---------------------------------------------------------------------------
// Hashing and the distance metric
// ---------------------------------------------------------------------------

// A fully transparent pixel is invisible whatever RGB it happens to carry, and
// background removal or AI generation often leaves garbage RGB under alpha 0.
// The browser surfaces also read pixels back through canvas getImageData, whose
// premultiplied storage zeroes that RGB anyway. So every comparison below reads
// RGB as 0 wherever A is 0 — otherwise the CLI and MCP (straight RGBA from
// pngjs) would dedupe the same sheet differently from the web app. Visible
// pixels, including their alpha, are compared exactly as stored.
function isRgbaBuffer(img: FrameImageLike): boolean {
  return img.data.length === img.width * img.height * 4;
}

/** Channel value with RGB forced to 0 under a fully transparent pixel. */
function visibleChannel(data: FrameImageLike["data"], i: number, rgba: boolean): number {
  if (rgba && (i & 3) !== 3 && data[i | 3] === 0) return 0;
  return data[i];
}

// Two FNV-1a-style lanes with different multipliers, seeded with the frame's
// dimensions so an 8x4 frame can never share a bucket with a 4x8 one. A hash
// match is only ever a *candidate*: findDuplicateFrames confirms every exact
// merge with a real byte comparison, so a collision cannot merge two frames.
export function frameHash(img: FrameImageLike): string {
  const data = img.data;
  const rgba = isRgbaBuffer(img);
  let h1 = (0x811c9dc5 ^ Math.imul(img.width, 0x27220a95)) >>> 0;
  let h2 = (0x01000193 ^ Math.imul(img.height, 0x165667b1)) >>> 0;
  for (let i = 0; i < data.length; i++) {
    const byte = visibleChannel(data, i, rgba);
    h1 = Math.imul(h1 ^ byte, 0x01000193);
    h2 = Math.imul(h2 ^ byte, 0x85ebca6b);
  }
  return `${img.width}x${img.height}:${(h1 >>> 0).toString(36)}.${(h2 >>> 0).toString(36)}`;
}

/**
 * Mean absolute difference across all four RGBA channels, on a 0-255 scale.
 *
 * Alpha participates straight — no premultiply, no alpha weighting — so an
 * alpha difference adds to the distance like any other channel. The one
 * normalisation: RGB under a fully transparent pixel reads as 0 (see
 * visibleChannel), because nobody can see it.
 *
 * Frames of different dimensions are never comparable, and return Infinity so
 * they can never fall under any threshold.
 */
export function meanAbsoluteDifference(a: FrameImageLike, b: FrameImageLike): number {
  if (a.width !== b.width || a.height !== b.height) return Infinity;
  const da = a.data;
  const db = b.data;
  if (da.length !== db.length) return Infinity;
  if (da.length === 0) return 0;
  const rgba = isRgbaBuffer(a);
  let sum = 0;
  for (let i = 0; i < da.length; i++) {
    const d = visibleChannel(da, i, rgba) - visibleChannel(db, i, rgba);
    sum += d < 0 ? -d : d;
  }
  return sum / da.length;
}

/** Byte equality after the transparent-RGB normalisation — the exact-pass confirm. */
function bytesEqual(a: FrameImageLike, b: FrameImageLike): boolean {
  if (a.width !== b.width || a.height !== b.height) return false;
  const da = a.data;
  const db = b.data;
  if (da.length !== db.length) return false;
  const rgba = isRgbaBuffer(a);
  for (let i = 0; i < da.length; i++) {
    if (visibleChannel(da, i, rgba) !== visibleChannel(db, i, rgba)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

interface WorkingGroup {
  keep: number;
  duplicates: number[];
  distances: number[];
}

/**
 * Two passes, deliberately in this order.
 *
 * 1. Exact pass: bucket frames by frameHash (O(N), not O(N^2)) and confirm each
 *    candidate with a byte comparison, so byte-identical frames always collapse
 *    into each other before any fuzzy matching gets a say.
 * 2. MAE pass (only when threshold > 0): walk the exact-pass survivors in source
 *    order and compare each one against the *representatives* of the groups
 *    established so far, joining the first one within threshold.
 *
 * Comparing against representatives only — never against other duplicates — is
 * what stops transitive chaining: if a~b and b~c but a!~c, then c must not end
 * up merged with a. Distance is MAE rather than a perceptual hash because a
 * user can be told exactly what the number means (see DedupeConfig.threshold).
 *
 * Order is never changed, and the frame kept for a group is always the lowest
 * old index in it.
 */
export function findDuplicateFrames(
  frames: FrameImageLike[],
  config: Partial<DedupeConfig> = {},
): DedupeResult {
  const partitions = config.partitions;
  if (partitions && partitions.length !== frames.length) {
    throw new Error(
      `dedupe: partitions.length (${partitions.length}) must equal frames.length (${frames.length})`,
    );
  }

  // A negative threshold is meaningless; clamp rather than surprising the caller.
  const threshold = Math.max(0, config.threshold ?? 0);
  const method: DedupeMethod = threshold === 0 ? "exact" : "mae";
  const frameCount = frames.length;

  if (frameCount === 0) {
    return {
      method,
      threshold,
      frameCount: 0,
      uniqueCount: 0,
      removedCount: 0,
      keptIndices: [],
      remap: [],
      groups: [],
    };
  }

  // Pass 1 — exact. The bucket key carries the partition id so frames in
  // different partitions never even become candidates for each other.
  const buckets = new Map<string, number[]>();
  const exactGroups: WorkingGroup[] = [];
  const groupOfFrame = new Map<number, WorkingGroup>();

  for (let i = 0; i < frameCount; i++) {
    const key = partitions ? `${partitions[i]}|${frameHash(frames[i])}` : frameHash(frames[i]);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = [];
      buckets.set(key, bucket);
    }
    let joined = false;
    for (const rep of bucket) {
      if (!bytesEqual(frames[i], frames[rep])) continue;
      const group = groupOfFrame.get(rep) as WorkingGroup;
      group.duplicates.push(i);
      group.distances.push(0);
      joined = true;
      break;
    }
    if (joined) continue;
    const group: WorkingGroup = { keep: i, duplicates: [], distances: [] };
    exactGroups.push(group);
    groupOfFrame.set(i, group);
    bucket.push(i);
  }

  // Pass 2 — MAE over the exact-pass survivors, greedy first match in source order.
  const finalGroups: WorkingGroup[] = [];
  for (const group of exactGroups) {
    let merged = false;
    if (threshold > 0) {
      for (const target of finalGroups) {
        if (partitions && partitions[target.keep] !== partitions[group.keep]) continue;
        const distance = meanAbsoluteDifference(frames[group.keep], frames[target.keep]);
        if (distance > threshold) continue;
        // Every member of `group` is byte-identical to group.keep, so they all
        // sit exactly `distance` away from the target's representative too.
        target.duplicates.push(group.keep, ...group.duplicates);
        for (let k = 0; k <= group.duplicates.length; k++) target.distances.push(distance);
        merged = true;
        break;
      }
    }
    if (!merged) finalGroups.push(group);
  }

  const keptIndices: number[] = [];
  const remap = new Array<number>(frameCount);
  for (const group of finalGroups) keptIndices.push(group.keep);
  keptIndices.sort((a, b) => a - b);
  const newIndexOf = new Map<number, number>();
  for (let n = 0; n < keptIndices.length; n++) newIndexOf.set(keptIndices[n], n);

  for (const group of finalGroups) {
    sortGroupByIndex(group);
    const newIndex = newIndexOf.get(group.keep) as number;
    remap[group.keep] = newIndex;
    for (const dup of group.duplicates) remap[dup] = newIndex;
  }

  return {
    method,
    threshold,
    frameCount,
    uniqueCount: keptIndices.length,
    removedCount: frameCount - keptIndices.length,
    keptIndices,
    remap,
    groups: finalGroups
      .filter((g) => g.duplicates.length > 0)
      .map((g) => ({ keep: g.keep, duplicates: g.duplicates, distances: g.distances })),
  };
}

// Merging appends whole exact-groups, so duplicates can arrive out of order;
// the contract promises ascending indices with distances kept aligned.
function sortGroupByIndex(group: WorkingGroup): void {
  const order = group.duplicates.map((_, i) => i);
  order.sort((a, b) => group.duplicates[a] - group.duplicates[b]);
  const duplicates = order.map((i) => group.duplicates[i]);
  const distances = order.map((i) => group.distances[i]);
  group.duplicates = duplicates;
  group.distances = distances;
}

/** Keep the items sitting at result.keptIndices — frames, pivots, polygons, anything per-frame. */
export function applyDedupe<T>(items: T[], result: DedupeResult): T[] {
  return result.keptIndices.map((i) => items[i]);
}

// ---------------------------------------------------------------------------
// Tag remapping
// ---------------------------------------------------------------------------

export interface AnimationTagLike {
  name: string;
  from: number;
  to: number;
  direction?: string;
  fps?: number;
}

export interface RemappedTag {
  name: string;
  from: number;
  to: number;
  direction?: string;
  fps?: number;
  frames: number[];
  contiguous: boolean;
}

export interface TagRemapResult {
  tags: RemappedTag[];
  warnings: string[];
}

function assertIntegerBounds(tag: AnimationTagLike): void {
  if (!Number.isInteger(tag.from) || !Number.isInteger(tag.to)) {
    throw new Error(
      `tag "${tag.name}" needs integer from/to frame indices, got ${tag.from}-${tag.to}`,
    );
  }
}

/**
 * Removing frames renumbers everything after them, and animation tags are named
 * frame RANGES — a dedupe that silently invalidates a user's tags is worse than
 * no dedupe at all.
 *
 * Each tag's old span is walked in order, every old index is mapped through
 * result.remap, and runs of consecutive identical new indices are collapsed.
 * That collapse is the whole point: adjacent duplicate frames genuinely make
 * the animation shorter.
 *
 * A range CAN come out non-contiguous, for exactly two reasons: a frame inside
 * it matched a kept frame OUTSIDE it (the neutral pose opening "run" is
 * byte-identical to a frame in "idle"), or the tag revisits one of its own poses
 * non-adjacently (a walk cycle filmed over two loops: A B A B). Partitions
 * (CLI --respect-tags, MCP respect_tags) remove only the first cause. We do not
 * reorder frames, do not duplicate a frame to restore contiguity, and do not
 * silently widen the range. Instead the ordered `frames` array stays
 * authoritative, from/to are emitted as min/max for consumers that only speak
 * ranges, contiguous is false, and a warning names the tag and the cause.
 *
 * A range that lies entirely outside the sheet matches nothing and comes back
 * with an empty `frames`; one that only partly overlaps is clamped. Both warn.
 */
export function remapTags(tags: AnimationTagLike[], result: DedupeResult): TagRemapResult {
  const warnings: string[] = [];
  const maxOld = result.frameCount - 1;

  const remapped = tags.map((tag): RemappedTag => {
    assertIntegerBounds(tag);
    const rawLo = Math.min(tag.from, tag.to);
    const rawHi = Math.max(tag.from, tag.to);

    if (result.frameCount === 0) {
      warnings.push(`tag "${tag.name}" (${rawLo}-${rawHi}) has no frames left to point at`);
      return { ...tagIdentity(tag), from: 0, to: 0, frames: [], contiguous: false };
    }

    // Clamping a range that misses the sheet entirely would pin it onto a
    // boundary frame it never contained, and that would look valid.
    if (rawHi < 0 || rawLo > maxOld) {
      warnings.push(
        `tag "${tag.name}" range ${rawLo}-${rawHi} lies entirely outside 0-${maxOld}; it matches no frames`,
      );
      return { ...tagIdentity(tag), from: 0, to: 0, frames: [], contiguous: false };
    }

    // Clamp rather than throw: a tag file written against a longer sheet is a
    // user mistake worth reporting, not a reason to abort the whole dedupe.
    const lo = Math.max(rawLo, 0);
    const hi = Math.min(rawHi, maxOld);
    if (lo !== rawLo || hi !== rawHi) {
      warnings.push(
        `tag "${tag.name}" range ${rawLo}-${rawHi} fell outside 0-${maxOld} and was clamped to ${lo}-${hi}`,
      );
    }

    const frames: number[] = [];
    for (let old = lo; old <= hi; old++) {
      const next = result.remap[old];
      if (frames.length > 0 && frames[frames.length - 1] === next) continue;
      frames.push(next);
    }

    const from = Math.min(...frames);
    const to = Math.max(...frames);
    let contiguous = frames.length === to - from + 1;
    for (let i = 1; contiguous && i < frames.length; i++) {
      if (frames[i] !== frames[i - 1] + 1) contiguous = false;
    }

    const oldSpan = hi - lo + 1;
    if (frames.length < oldSpan) {
      warnings.push(
        `tag "${tag.name}" shrank from ${oldSpan} to ${frames.length} frame(s) after dedupe`,
      );
    }
    if (frames.length === 1 && oldSpan > 1) {
      warnings.push(`tag "${tag.name}" collapsed to a single frame (${from})`);
    }
    if (!contiguous) {
      const causes: string[] = [];
      // A kept frame's old index is its group's lowest, so a new index whose
      // kept frame sits outside [lo, hi] came from a match with another range.
      const outside = [...new Set(frames)].filter((n) => {
        const keptOld = result.keptIndices[n];
        return keptOld < lo || keptOld > hi;
      });
      if (outside.length > 0) {
        causes.push(
          `frame(s) ${outside.join(", ")} matched frames outside the tag, which tag partitioning (CLI --respect-tags, MCP respect_tags) prevents`,
        );
      }
      if (new Set(frames).size < frames.length) {
        causes.push(
          "the tag repeats one of its own poses non-adjacently, which tag partitioning cannot prevent",
        );
      }
      warnings.push(
        `tag "${tag.name}" is no longer a contiguous range (frames ${frames.join(", ")}); use its frames array. Cause: ${causes.join("; ")}`,
      );
    }

    return { ...tagIdentity(tag), from, to, frames, contiguous };
  });

  return { tags: remapped, warnings };
}

// Name, direction and fps are the user's own metadata and must survive untouched.
function tagIdentity(tag: AnimationTagLike): Pick<RemappedTag, "name" | "direction" | "fps"> {
  const identity: Pick<RemappedTag, "name" | "direction" | "fps"> = { name: tag.name };
  if (tag.direction !== undefined) identity.direction = tag.direction;
  if (tag.fps !== undefined) identity.fps = tag.fps;
  return identity;
}

/**
 * One partition id per frame for findDuplicateFrames: the index of the first
 * tag whose range covers it, or a single shared id for frames no tag claims
 * (they have no range to keep intact, so letting them collapse together is
 * free). Overlapping tags force a choice the core has no opinion about — first
 * tag listed wins, and a warning says so. Ranges are clamped to the sheet the
 * same way remapTags clamps them, so a tag that misses the sheet claims nothing.
 */
export function buildTagPartitions(
  tags: AnimationTagLike[],
  frameCount: number,
): { partitions: number[]; warnings: string[] } {
  const untagged = tags.length;
  const partitions = new Array<number>(frameCount).fill(untagged);
  const owner = new Array<string | undefined>(frameCount);
  const overlaps = new Set<string>();

  for (let t = 0; t < tags.length; t++) {
    const tag = tags[t];
    assertIntegerBounds(tag);
    const lo = Math.max(0, Math.min(tag.from, tag.to));
    const hi = Math.min(frameCount - 1, Math.max(tag.from, tag.to));
    for (let f = lo; f <= hi; f++) {
      if (owner[f] !== undefined) {
        overlaps.add(`"${owner[f]}" and "${tag.name}"`);
        continue;
      }
      owner[f] = tag.name;
      partitions[f] = t;
    }
  }

  const warnings = [...overlaps].map(
    (pair) => `tags ${pair} overlap; the shared frames only merge within the first of them`,
  );
  return { partitions, warnings };
}

export interface ParsedTagsDocument {
  tags: AnimationTagLike[];
  /** The document's per-frame hold times (ms, one per OLD frame), untouched, when present. */
  frameDurations?: unknown[];
}

/**
 * Validate parsed JSON as a tags document: what `sprite-tools tags` and
 * sprite_generate_tags emit ({ tags: [...], frameDurations?: [...] }) or a bare
 * array of tags. Throws a message naming the bad entry; callers add the path.
 * Shared by the CLI and the MCP server so the two cannot accept different input.
 */
export function parseTagsDocument(parsed: unknown): ParsedTagsDocument {
  const isObject = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed);
  const raw = Array.isArray(parsed)
    ? parsed
    : isObject && Array.isArray((parsed as { tags?: unknown }).tags)
      ? ((parsed as { tags: unknown[] }).tags as unknown[])
      : undefined;
  if (!raw) throw new Error('expected { "tags": [...] } or a bare array of tags');

  const tags = raw.map((entry, i): AnimationTagLike => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`tag #${i} is not an object`);
    }
    const t = entry as Record<string, unknown>;
    if (typeof t.name !== "string" || t.name === "") {
      throw new Error(`tag #${i} needs a non-empty string "name"`);
    }
    if (!Number.isInteger(t.from) || !Number.isInteger(t.to)) {
      throw new Error(`tag "${t.name}" needs integer "from"/"to" frame indices`);
    }
    const tag: AnimationTagLike = { name: t.name, from: t.from as number, to: t.to as number };
    if (typeof t.direction === "string") tag.direction = t.direction;
    if (typeof t.fps === "number" && Number.isFinite(t.fps)) tag.fps = t.fps;
    return tag;
  });

  const durations = isObject ? (parsed as { frameDurations?: unknown }).frameDurations : undefined;
  return Array.isArray(durations) ? { tags, frameDurations: durations } : { tags };
}

/**
 * Carry a tags document's `frameDurations` (milliseconds, one entry per OLD
 * frame, `null` = use the playing tag's fps) through the dedupe.
 *
 * Merge rule: a kept frame takes the first explicit hold in its group, in old
 * index order — the representative's own value when it has one, otherwise the
 * first duplicate that has one. Holds of a collapsed run are NOT summed: a
 * frame's duration belongs to the drawing, and the same drawing may also be
 * played elsewhere. Entries are read through normalizeFrameDurations, so the
 * same values count as a hold here as in `tags`, `meta` and `gif`.
 * Returns undefined when no kept frame ends up with an explicit hold, so callers
 * only emit the field when there is something to say.
 */
export function remapFrameDurations(
  frameDurations: unknown[] | undefined,
  result: DedupeResult,
): FrameDurations | undefined {
  const holds = normalizeFrameDurations(frameDurations, result.frameCount);
  if (!holds || result.uniqueCount === 0) return undefined;
  const out: FrameDurations = new Array(result.uniqueCount).fill(null);
  for (let old = 0; old < result.frameCount; old++) {
    const n = result.remap[old];
    if (out[n] === null) out[n] = holds[old];
  }
  return normalizeFrameDurations(out, result.uniqueCount);
}
