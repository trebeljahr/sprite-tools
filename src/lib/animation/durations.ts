// Per-frame animation hold times.
//
// Animation tags are named ranges over one global frame sequence and carry a
// single uniform `fps`. Hand-authored animation holds key poses longer than
// in-betweens, so a tags document may additionally carry `frameDurations`: one
// entry per frame of the sheet, in milliseconds.
//
// `null` at index i means "this frame has no explicit hold; use the rate of
// whichever tag is playing it". That keeps a sheet from having to invent
// numbers for 38 frames just to hold 2 of them. An absent `frameDurations`
// field is the same as an all-null one and behaves exactly like the pre-
// durations toolkit did.
//
// Durations are global per frame rather than per frame-within-a-tag because a
// frame is one drawing and its hold time is a property of that drawing (this
// is also how Aseprite stores it), and because overlapping tag ranges would
// otherwise duplicate the data with no way to express a sync policy. Known
// limitation: the same frame cannot be held for different lengths in two
// different tags — duplicate the frame in the sheet if you need that.
//
// No DOM dependencies here: the web app, the CLI, the MCP server and the tests
// all import this module.

export type FrameDuration = number | null;
export type FrameDurations = FrameDuration[];

/** Shape of the optional on-disk field, for documents that carry durations. */
export interface FrameDurationsCarrier {
  /** Milliseconds per frame; `null` = fall back to the consuming tag's fps. */
  frameDurations?: FrameDurations;
}

/**
 * GIF stores delays in centiseconds, so the real on-disk resolution is 10ms.
 * gifenc's `writeFrame(..., { delay })` takes milliseconds and writes
 * `Math.round(delay / 10)`: a 125ms hold is written as 130ms.
 */
export const GIF_DELAY_QUANTUM_MS = 10;

/** Browsers clamp GIF delays below ~20ms up to 100ms, so floor at 20ms. */
export const GIF_MIN_DELAY_MS = 20;

/** Uniform frame time for a playback rate, rounded to whole milliseconds. */
export function fpsToDurationMs(fps: number): number {
  const safe = Number.isFinite(fps) ? Math.max(1, fps) : 1;
  return Math.round(1000 / safe);
}

/**
 * Hold time for one frame: its explicit duration when it has one, otherwise
 * the uniform time implied by `fallbackFps`. Tolerates a missing array and an
 * out-of-range index.
 */
export function resolveFrameDurationMs(
  durations: FrameDurations | null | undefined,
  frameIndex: number,
  fallbackFps: number,
): number {
  const explicit = durations?.[frameIndex];
  if (typeof explicit === "number" && Number.isFinite(explicit) && explicit > 0) {
    return explicit;
  }
  return fpsToDurationMs(fallbackFps);
}

/**
 * Hold times for a playback sequence of frame indices. A pingpong sequence
 * repeats indices; each repeat gets that frame's duration again, which is
 * intended — the drawing is held just as long on the way back.
 */
export function resolveSequenceDurationsMs(
  sequence: number[],
  durations: FrameDurations | null | undefined,
  fallbackFps: number,
): number[] {
  return sequence.map((i) => resolveFrameDurationMs(durations, i, fallbackFps));
}

/**
 * Snap a duration to what a GIF can actually represent: a multiple of 10ms,
 * never below 20ms. 125 -> 130, 133 -> 130, 5 -> 20. Not exact, by format.
 */
export function quantizeGifDelayMs(ms: number): number {
  if (!Number.isFinite(ms)) return GIF_MIN_DELAY_MS;
  const snapped = Math.round(ms / GIF_DELAY_QUANTUM_MS) * GIF_DELAY_QUANTUM_MS;
  return Math.max(GIF_MIN_DELAY_MS, snapped);
}

/**
 * Coerce parsed-JSON input into exactly `frameCount` entries. Anything that
 * isn't a positive finite number becomes `null` (fall back to tag fps); a
 * too-long array is truncated and a too-short one padded with `null`.
 * Returns undefined when there is nothing to store — not an array, empty
 * sheet, or every entry resolved to `null`. Callers should only emit the
 * `frameDurations` field when this returns an array.
 */
export function normalizeFrameDurations(
  input: unknown,
  frameCount: number,
): FrameDurations | undefined {
  if (!Array.isArray(input) || frameCount <= 0) return undefined;
  const out: FrameDurations = new Array(frameCount).fill(null);
  let any = false;
  for (let i = 0; i < frameCount; i++) {
    const ms = toDurationMs(input[i]);
    if (ms !== null) {
      out[i] = ms;
      any = true;
    }
  }
  return any ? out : undefined;
}

/**
 * Parse a CLI/MCP duration spec: `"3=250"` (one frame) or `"2-5=250"`
 * (inclusive range). Indices are clamped into the sheet and normalised so
 * `from <= to`.
 */
export function parseDurationSpec(
  spec: string,
  frameCount: number,
): { from: number; to: number; ms: number } {
  const eq = spec.indexOf("=");
  if (eq < 0) {
    throw new Error(`invalid --duration "${spec}" (expected "index=ms" or "from-to=ms")`);
  }
  const rangeStr = spec.slice(0, eq).trim();
  const msStr = spec.slice(eq + 1).trim();
  const ms = /^\d+$/.test(msStr) ? parseInt(msStr, 10) : NaN;
  if (!Number.isFinite(ms) || ms <= 0) {
    throw new Error(`invalid --duration "${spec}" (ms must be a positive integer)`);
  }

  const hi = Math.max(0, frameCount - 1);
  const match = /^(-?\d+)(?:-(-?\d+))?$/.exec(rangeStr);
  if (!match) {
    throw new Error(`invalid --duration "${spec}" (expected "index=ms" or "from-to=ms")`);
  }
  const rawFrom = parseInt(match[1], 10);
  const rawTo = match[2] === undefined ? rawFrom : parseInt(match[2], 10);
  const a = clamp(rawFrom, 0, hi);
  const b = clamp(rawTo, 0, hi);
  return { from: Math.min(a, b), to: Math.max(a, b), ms };
}

/**
 * Fold duration specs over a base array (all-null of length `frameCount` when
 * omitted). Later specs overwrite earlier ones where ranges overlap. Returns
 * undefined when nothing ends up set.
 */
export function applyDurationSpecs(
  specs: string[],
  frameCount: number,
  base?: FrameDurations | null,
): FrameDurations | undefined {
  if (frameCount <= 0) return undefined;
  const out: FrameDurations = new Array(frameCount).fill(null);
  for (let i = 0; i < frameCount; i++) {
    out[i] = toDurationMs(base?.[i]);
  }
  for (const spec of specs) {
    const { from, to, ms } = parseDurationSpec(spec, frameCount);
    for (let i = from; i <= to; i++) out[i] = ms;
  }
  return out.some((d) => d !== null) ? out : undefined;
}

/** Wall-clock length of one pass over a playback sequence, in milliseconds. */
export function totalDurationMs(
  sequence: number[],
  durations: FrameDurations | null | undefined,
  fallbackFps: number,
): number {
  return resolveSequenceDurationsMs(sequence, durations, fallbackFps).reduce((a, b) => a + b, 0);
}

// Positive finite number (or numeric string) -> whole milliseconds; anything
// else -> null, meaning "no explicit hold, fall back to the tag's fps".
function toDurationMs(value: unknown): FrameDuration {
  const n =
    typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n);
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}
