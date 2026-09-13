// Godot 4 exporter: a `SpriteFrames` .tres with one AtlasTexture sub-resource
// per frame, plus the standalone-AtlasTexture variant (one .tres per frame).
//
// The output is byte-for-byte what Godot's own text saver writes, because the
// engine re-serializes any resource you edit — matching its writer means an
// editor round-trip produces a zero-line diff instead of churning the file.
// That drives several choices that look arbitrary in isolation: dictionary keys
// sorted, animations sorted by name, `Rect2(0, 0, 16, 16)` with bare integers
// while `"speed": 8.0` gets a forced `.0`, and no indentation anywhere inside
// the `animations` literal.
//
// Compatibility target is every Godot 4.x (4.0 → 4.7). See the notes on
// `format=3`, the omitted `uid`, and the bool `loop` below.

import {
  basename,
  expandTagFrameIndices,
  type ExportRect,
  type ExportTag,
  type NormalizedDoc,
  type NormalizedFrame,
  stripExtension,
} from "./types";

/** How the animation `loop` value is written. */
export type GodotLoopMode = "bool" | "int";

/** How a `pingpong` tag is expressed. */
export type GodotPingPongMode = "bake" | "native";

export interface GodotExportOptions {
  /**
   * `res://` path of the spritesheet PNG, as it sits inside the Godot project.
   * Defaults to `res://<doc.texture>`. Our metadata only carries a filename,
   * never a project path, so a real export almost always passes this.
   */
  texturePath?: string;
  /** Animation loop flag. Default `true`. */
  loop?: boolean;
  /**
   * `"bool"` (default) writes `"loop": true`, which every Godot 4.x reads
   * correctly. `"int"` writes the 4.7 `SpriteFrames.LoopMode` enum, which
   * Godot ≤ 4.6 silently coerces back to a plain forward loop.
   */
  loopMode?: GodotLoopMode;
  /**
   * `"bake"` (default) writes a pingpong tag as an explicit `from..to,
   * to-1..from+1` frame list, closed with `from` when the animation does not loop. `"native"` writes `LOOP_PINGPONG` instead, and
   * only takes effect together with `loopMode: "int"` and a looping animation.
   */
  pingpong?: GodotPingPongMode;
  /** Name of the fallback animation used when the doc carries no tags. Default `"default"`. */
  defaultAnimationName?: string;
  /**
   * Also emit the first animation under the name `default`. Off by default:
   * `AnimatedSprite2D.animation` defaults to `&"default"` and shows nothing
   * without it, but silently duplicating an animation is worse than a
   * documented empty viewport.
   */
  defaultAlias?: boolean;
  /**
   * Emit `load_steps=` on the header. Off by default — Godot 4.6+ neither
   * writes nor reads it, and 4.0–4.5 use it only for a progress bar.
   */
  loadSteps?: boolean;
}

/** One generated file: the caller decides where it lands on disk. */
export interface GodotFile {
  /** Suggested filename, e.g. `hero_00.tres`. */
  filename: string;
  content: string;
}

/** `SpriteFrames.LoopMode` (Godot 4.7+). */
const LOOP_NONE = 0;
const LOOP_LINEAR = 1;
const LOOP_PINGPONG = 2;

const DEFAULT_ANIMATION_NAME = "default";

// ---------------------------------------------------------------------------
// SpriteFrames
// ---------------------------------------------------------------------------

/**
 * A complete `SpriteFrames` resource: one `[ext_resource]` for the sheet, one
 * `[sub_resource type="AtlasTexture"]` per distinct region, and the
 * `animations` array in the exact shape `SpriteFrames::_get_animations()`
 * produces.
 */
export function toGodotSpriteFrames(doc: NormalizedDoc, opts: GodotExportOptions = {}): string {
  const texturePath = resolveTexturePath(doc, opts);
  const animations = buildAnimations(doc, opts);

  // The parser resolves SubResource("…") / ExtResource("…") against maps filled
  // by the blocks it has already read, so a forward reference is a hard error:
  // every sub-resource has to be collected before the [resource] block is
  // written, and written above it.
  const extId = uniqueId("1_", `ext:${texturePath}`, new Set());
  const subs = new SubResourceTable();
  const rendered = animations.map((anim) => ({
    name: anim.name,
    loop: anim.loop,
    speed: anim.speed,
    frames: anim.indices.map((index) => {
      const frame = doc.frames[index];
      // `duration` is a RELATIVE multiplier of `1 / speed`, never seconds:
      // on-screen time is `duration / (speed × speed_scale)`. A frame with no
      // explicit hold plays one step of this animation's own speed. Its
      // `durationMs` must not leak in here: it comes from the FIRST tag that
      // covers the frame, so an overlapping clip would play at another tag's fps.
      // Only an explicit `frameDurations` hold stretches it.
      return {
        id: subs.idFor(frame, texturePath),
        duration: holdMultiplier(frame.explicitDurationMs, anim.speed),
      };
    }),
  }));

  const out: string[] = [];
  out.push(header("SpriteFrames", opts.loadSteps ? 1 + subs.size + 1 : null));
  out.push("");
  out.push(extResourceLine(texturePath, extId));
  out.push("");
  for (const sub of subs.all()) {
    out.push(`[sub_resource type="AtlasTexture" id="${sub.id}"]`);
    out.push(`atlas = ExtResource("${extId}")`);
    out.push(`region = ${rect2(sub.region)}`);
    // AtlasTexture omits both properties at their Rect2(0,0,0,0) default, and
    // a zero margin is what an untrimmed frame has.
    if (sub.margin) out.push(`margin = ${rect2(sub.margin)}`);
    out.push("");
  }
  out.push("[resource]");
  out.push(`animations = ${animationsLiteral(rendered)}`);

  return `${out.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Standalone AtlasTexture files
// ---------------------------------------------------------------------------

/**
 * One standalone `AtlasTexture` .tres per frame — the shape a project uses when
 * it wants each frame addressable as its own resource (a SpriteFrames can then
 * reference them as `[ext_resource type="AtlasTexture" …]` instead of holding
 * sub-resources). Each entry is a complete, importable file.
 */
export function toGodotAtlasTextureFiles(
  doc: NormalizedDoc,
  opts: GodotExportOptions = {},
): GodotFile[] {
  const texturePath = resolveTexturePath(doc, opts);
  const extId = uniqueId("1_", `ext:${texturePath}`, new Set());
  const used = new Set<string>();

  return doc.frames.map((frame) => {
    const region = frameRegion(frame);
    const margin = frameMargin(frame);
    const body = [
      header("AtlasTexture", opts.loadSteps ? 2 : null),
      "",
      extResourceLine(texturePath, extId),
      "",
      "[resource]",
      `atlas = ExtResource("${extId}")`,
      `region = ${rect2(region)}`,
    ];
    if (margin) body.push(`margin = ${rect2(margin)}`);
    return { filename: uniqueFilename(frame.name, used), content: `${body.join("\n")}\n` };
  });
}

/**
 * The same per-frame AtlasTexture files as one text bundle, each preceded by a
 * `; <filename>` comment line.
 *
 * This is NOT a single importable .tres — a `.tres` holds exactly one
 * `[gd_resource]` header — it is the string-shaped view of a multi-file export,
 * for previewing in the web UI or piping to a splitter. Callers that write
 * files should use `toGodotAtlasTextureFiles` instead.
 */
export function toGodotAtlasTextures(doc: NormalizedDoc, opts: GodotExportOptions = {}): string {
  return toGodotAtlasTextureFiles(doc, opts)
    .map((file) => `; ${file.filename}\n${file.content}`)
    .join("\n");
}

// ---------------------------------------------------------------------------
// Animations
// ---------------------------------------------------------------------------

interface PlannedAnimation {
  name: string;
  /** Frame indices in playback order. */
  indices: number[];
  /** Frames per second. */
  speed: number;
  /** Already rendered: `true`/`false`, or a LoopMode integer. */
  loop: string;
}

function buildAnimations(doc: NormalizedDoc, opts: GodotExportOptions): PlannedAnimation[] {
  const loop = opts.loop !== false;
  const loopMode: GodotLoopMode = opts.loopMode === "int" ? "int" : "bool";
  // Native ping-pong is a 4.7-only LoopMode value, so it can only be expressed
  // in the int form and only on a looping animation. Anything else bakes.
  const nativePingPong = opts.pingpong === "native" && loopMode === "int" && loop;

  const planned: PlannedAnimation[] =
    doc.tags.length > 0
      ? doc.tags.map((tag) => planTag(tag, loop, loopMode, nativePingPong))
      : [planFallback(doc, opts, loop, loopMode)];

  if (opts.defaultAlias && !planned.some((a) => a.name === DEFAULT_ANIMATION_NAME)) {
    planned.push({ ...planned[0], name: DEFAULT_ANIMATION_NAME });
  }

  // `_get_animations()` sorts by name, and `_set_animations()` keys a map by
  // name — so duplicates would silently collapse onto one animation.
  const used = new Set<string>();
  for (const anim of planned) anim.name = uniqueAnimationName(anim.name, used);
  planned.sort((a, b) => alphCompare(a.name, b.name));
  return planned;
}

function planTag(
  tag: ExportTag,
  loop: boolean,
  loopMode: GodotLoopMode,
  nativePingPong: boolean,
): PlannedAnimation {
  // Godot has no per-animation direction. `reverse` can only ever be baked into
  // the frame order; `pingpong` bakes to from..to,to-1..from+1 (Aseprite's
  // shape) unless the caller opted into 4.7's LOOP_PINGPONG, which is NOT
  // equivalent — the engine replays each endpoint for a second full duration.
  const bakePingPong = tag.direction === "pingpong" && !nativePingPong;
  const indices =
    tag.direction === "reverse" || bakePingPong
      ? expandTagFrameIndices(tag)
      : forwardRange(tag.from, tag.to);
  // The baked list stops at from+1 because a looping animation wraps back to
  // `from` on its own. A one-shot never wraps, so it has to close the round
  // trip itself or it comes to rest one frame short of where it started.
  if (bakePingPong && !loop && tag.to > tag.from) indices.push(tag.from);

  const useNative = tag.direction === "pingpong" && nativePingPong;
  return {
    name: tag.name,
    indices,
    speed: tag.fps,
    loop: loopValue(loop, loopMode, useNative),
  };
}

function planFallback(
  doc: NormalizedDoc,
  opts: GodotExportOptions,
  loop: boolean,
  loopMode: GodotLoopMode,
): PlannedAnimation {
  // No tags: one animation over every frame. Name it `default` so
  // AnimatedSprite2D, whose `animation` property defaults to &"default",
  // shows something the moment the resource is dropped on a node.
  const name = opts.defaultAnimationName ?? DEFAULT_ANIMATION_NAME;
  // Frame 0 may carry an explicit hold, so the speed comes from the default
  // rate itself, never from a frame's resolved duration.
  const perFrameMs = Math.max(1, Math.round(1000 / doc.defaultFps));
  return {
    name,
    indices: doc.frames.map((frame) => frame.index),
    speed: fpsFromMs(perFrameMs),
    loop: loopValue(loop, loopMode, false),
  };
}

/**
 * The normalizer stores whole milliseconds, so a 12 fps default arrives as
 * 83 ms and `1000 / 83` would write `"speed": 12.048192771084338`. Recover the
 * integer fps whenever it quantizes back to exactly this duration.
 */
function fpsFromMs(ms: number): number {
  const candidate = Math.round(1000 / ms);
  return candidate > 0 && Math.max(1, Math.round(1000 / candidate)) === ms ? candidate : 1000 / ms;
}

/**
 * A `frameDurations` hold as a multiple of one `1 / speed` step: 250 ms at
 * 12 fps is 3.0. Rounded to 4 places so 1000/12 steps don't print 17 digits,
 * and floored at Godot's own 0.01 clamp.
 */
function holdMultiplier(holdMs: number | null, speed: number): number {
  if (holdMs === null || !(speed > 0)) return 1;
  return Math.max(0.01, Math.round(((holdMs * speed) / 1000) * 10000) / 10000);
}

function loopValue(loop: boolean, mode: GodotLoopMode, pingpong: boolean): string {
  if (mode === "bool") return loop ? "true" : "false";
  if (!loop) return String(LOOP_NONE);
  return String(pingpong ? LOOP_PINGPONG : LOOP_LINEAR);
}

function forwardRange(from: number, to: number): number[] {
  const out: number[] = [];
  for (let i = from; i <= to; i++) out.push(i);
  return out;
}

// ---------------------------------------------------------------------------
// Sub-resources
// ---------------------------------------------------------------------------

interface SubResource {
  id: string;
  region: ExportRect;
  margin: ExportRect | null;
  /** Lowest frame index that uses this geometry — the emission order. */
  order: number;
}

/**
 * Collects one AtlasTexture per distinct geometry. Frames that share a region
 * share a sub-resource — real Godot files reuse a single `SubResource(…)` id
 * across repeated frames, and a pingpong animation references each of its
 * frames twice by definition.
 */
class SubResourceTable {
  private readonly byKey = new Map<string, SubResource>();
  private readonly ids = new Set<string>();

  idFor(frame: NormalizedFrame, texturePath: string): string {
    const region = frameRegion(frame);
    const margin = frameMargin(frame);
    const key = `${rect2(region)}|${margin ? rect2(margin) : "-"}`;
    const existing = this.byKey.get(key);
    if (existing) {
      existing.order = Math.min(existing.order, frame.index);
      return existing.id;
    }
    // Seeded from the texture path plus the geometry, mirroring Godot's own
    // `Resource::seed_scene_unique_id(path.hash())` — same input, same file.
    const id = uniqueId("AtlasTexture_", `${texturePath}|${key}`, this.ids);
    this.byKey.set(key, { id, region, margin, order: frame.index });
    return id;
  }

  get size(): number {
    return this.byKey.size;
  }

  /**
   * Natural frame order, not reference order: a `reverse` animation reverses
   * only the references it writes, and the blocks themselves stay readable and
   * diff-stable in sheet order.
   */
  all(): SubResource[] {
    return [...this.byKey.values()].sort((a, b) => a.order - b.order);
  }
}

function frameRegion(frame: NormalizedFrame): ExportRect {
  const { x, y, w, h } = frame.frame;
  if (!(w > 0) || !(h > 0)) {
    // AtlasTexture substitutes the WHOLE atlas image for any axis whose region
    // size is 0, so a degenerate rect renders the entire sheet with no error.
    throw new Error(
      `godot: frame "${frame.name}" has a ${w}×${h} region — Godot renders the whole ` +
        "sheet for a zero-sized AtlasTexture region. Re-pack the sheet or drop the frame.",
    );
  }
  return { x, y, w, h };
}

/**
 * `margin.position` is where the trimmed content sits inside the untrimmed
 * canvas and `margin.size` is how much was trimmed away in total, so the
 * AtlasTexture reports the original size and draws the trimmed pixels in the
 * right place. Null when nothing was trimmed — Godot omits default-valued
 * properties, so an untrimmed frame must not carry a `margin` line.
 */
function frameMargin(frame: NormalizedFrame): ExportRect | null {
  const { x, y, w, h } = frame.spriteSourceSize;
  const margin = { x, y, w: frame.sourceSize.w - w, h: frame.sourceSize.h - h };
  const zero = margin.x === 0 && margin.y === 0 && margin.w === 0 && margin.h === 0;
  return zero ? null : margin;
}

// ---------------------------------------------------------------------------
// File scaffolding
// ---------------------------------------------------------------------------

/**
 * `format=3` unconditionally: 4.3+ bumped FORMAT_VERSION to 4 but its editor
 * still writes 3 (FORMAT_VERSION_COMPAT), and 4.0–4.2 reject anything higher
 * outright with ERR_FILE_UNRECOGNIZED.
 *
 * No `uid=`: a UID that happens to collide with a real resource makes the
 * loader silently swap in THAT resource's path — wrong texture, no warning —
 * and there is no way for a generator to synthesize a safe one. Omitting it is
 * free; the editor assigns and persists a real UID on its next scan.
 */
function header(type: string, loadSteps: number | null): string {
  const steps = loadSteps !== null && loadSteps > 1 ? `load_steps=${loadSteps} ` : "";
  return `[gd_resource type="${type}" ${steps}format=3]`;
}

/** `type`, `path` and `id` are all mandatory — omitting any is ERR_FILE_CORRUPT. */
function extResourceLine(texturePath: string, id: string): string {
  // Godot writes the path raw, so we must too; unquotable paths are rejected in
  // resolveTexturePath rather than silently corrupting the file. `Texture2D` is
  // the right type hint for a PNG — the loader hands back a CompressedTexture2D.
  return `[ext_resource type="Texture2D" path="${texturePath}" id="${id}"]`;
}

function resolveTexturePath(doc: NormalizedDoc, opts: GodotExportOptions): string {
  const path = opts.texturePath ?? `res://${doc.texture}`;
  if (path.length === 0) {
    throw new Error("godot: texturePath is empty — pass the sheet's res:// path.");
  }
  if (/["\n\r]/.test(path)) {
    throw new Error(
      `godot: texturePath ${JSON.stringify(path)} contains a quote or newline. Godot writes ` +
        "ext_resource paths unescaped, so such a path cannot be represented in a .tres.",
    );
  }
  // A bare relative path resolves against the .tres's own directory, so it is
  // legal; an OS path or a foreign scheme never resolves inside a project.
  const scheme = path.match(/^([a-z]+):\/\//)?.[1];
  if (scheme !== undefined && scheme !== "res" && scheme !== "user") {
    throw new Error(
      `godot: texturePath must be a res:// path inside the Godot project, got ` +
        `${JSON.stringify(path)}. Pass the res:// path of the sheet, e.g. res://art/sheet.png.`,
    );
  }
  if (scheme === undefined && (path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path))) {
    throw new Error(
      `godot: texturePath must be a res:// path inside the Godot project, got the absolute ` +
        `path ${JSON.stringify(path)}. Pass the res:// path of the sheet, e.g. res://art/sheet.png.`,
    );
  }
  return path;
}

// ---------------------------------------------------------------------------
// Value rendering — mirrors VariantWriter::write
// ---------------------------------------------------------------------------

/** `Rect2` prints through `rtos_fix` WITHOUT the float fixup, hence bare integers. */
function rect2(r: ExportRect): string {
  return `Rect2(${rtos(r.x)}, ${rtos(r.y)}, ${rtos(r.w)}, ${rtos(r.h)})`;
}

function rtos(v: number): string {
  if (!Number.isFinite(v)) {
    throw new Error(`godot: cannot write the non-finite number ${v} into a .tres.`);
  }
  // `String(-0)` is already "0", matching rtos_fix's zero handling.
  return String(v);
}

/** Floats gain a trailing `.0` when the plain form has no `.`, `e` or `E`. */
function floatLiteral(v: number): string {
  const s = rtos(v);
  return /[.eE]/.test(s) ? s : `${s}.0`;
}

/**
 * StringName literal: `&"name"`.
 *
 * Godot's `c_escape()` also escapes `'` as `\'`, which its own text parser does
 * not recognise as an escape, so we escape only the sequences the parser
 * definitely round-trips and pass everything else through as UTF-8.
 */
function stringName(value: string): string {
  return `&"${escapeTres(value)}"`;
}

function escapeTres(value: string): string {
  let out = "";
  for (const ch of value) {
    switch (ch) {
      case "\\":
        out += "\\\\";
        break;
      case '"':
        out += '\\"';
        break;
      case "\n":
        out += "\\n";
        break;
      case "\r":
        out += "\\r";
        break;
      case "\t":
        out += "\\t";
        break;
      case "\b":
        out += "\\b";
        break;
      case "\f":
        out += "\\f";
        break;
      default: {
        const code = ch.codePointAt(0) ?? 0;
        out += code < 0x20 || code === 0x7f ? `\\u${code.toString(16).padStart(4, "0")}` : ch;
      }
    }
  }
  return out;
}

interface RenderedAnimation {
  name: string;
  loop: string;
  speed: number;
  frames: Array<{ id: string; duration: number }>;
}

/**
 * `VariantWriter` sorts dictionary keys and writes them with zero indentation:
 * `{\n"key": value,\n"key": value\n}`, arrays as `[a, b]`. That is why the
 * on-disk key order is duration/texture and frames/loop/name/speed rather than
 * the order the engine inserts them in.
 */
function animationsLiteral(animations: RenderedAnimation[]): string {
  return arrayLiteral(
    animations.map((anim) =>
      dictLiteral([
        ["frames", arrayLiteral(anim.frames.map(frameDict))],
        ["loop", anim.loop],
        ["name", stringName(anim.name)],
        ["speed", floatLiteral(anim.speed)],
      ]),
    ),
  );
}

function frameDict(frame: { id: string; duration: number }): string {
  // All four animation keys and both frame keys are mandatory: `_set_animations`
  // ERR_CONTINUEs past an entry missing any of them, dropping it silently.
  return dictLiteral([
    ["duration", floatLiteral(frame.duration)],
    ["texture", `SubResource("${frame.id}")`],
  ]);
}

function dictLiteral(entries: Array<[string, string]>): string {
  if (entries.length === 0) return "{}";
  return `{\n${entries.map(([k, v]) => `"${k}": ${v}`).join(",\n")}\n}`;
}

function arrayLiteral(items: string[]): string {
  return `[${items.join(", ")}]`;
}

// ---------------------------------------------------------------------------
// Deterministic ids
// ---------------------------------------------------------------------------

const ID_ALPHABET_SIZE = 36 ** 5;

/**
 * A stable stand-in for `Resource::generate_scene_unique_id()`: 5 characters of
 * `[a-z0-9]` derived from a hash of the seed, so re-running the exporter on the
 * same input is byte-identical instead of churning the VCS diff. Godot seeds
 * its own generator the same way (`seed_scene_unique_id(path.hash())`).
 *
 * Ids are map keys inside the file, so a hash collision would silently make two
 * frames share one region — re-hash with a counter until the id is free.
 */
function uniqueId(prefix: string, seed: string, used: Set<string>): string {
  for (let attempt = 0; ; attempt++) {
    const suffix = (fnv1a(attempt === 0 ? seed : `${seed}#${attempt}`) % ID_ALPHABET_SIZE)
      .toString(36)
      .padStart(5, "0");
    const id = `${prefix}${suffix}`;
    if (!used.has(id)) {
      used.add(id);
      return id;
    }
  }
}

function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

function uniqueAnimationName(base: string, used: Set<string>): string {
  const stem = base.length > 0 ? base : DEFAULT_ANIMATION_NAME;
  if (!used.has(stem)) {
    used.add(stem);
    return stem;
  }
  let n = 2;
  while (used.has(`${stem}_${n}`)) n++;
  const name = `${stem}_${n}`;
  used.add(name);
  return name;
}

/** Frame names come from atlas manifest keys, which may be paths like `run/00.png`. */
function uniqueFilename(frameName: string, used: Set<string>): string {
  const stem = stripExtension(basename(frameName)).replace(/[^A-Za-z0-9._-]/g, "_");
  const base = stem.length > 0 ? stem : "frame";
  let candidate = `${base}.tres`;
  let n = 2;
  while (used.has(candidate)) {
    candidate = `${base}_${n}.tres`;
    n++;
  }
  used.add(candidate);
  return candidate;
}

/**
 * `StringName::AlphCompare` compares code points; JS's `<` compares UTF-16 code
 * units, which orders astral characters differently. Compare code points so an
 * editor round-trip does not reorder the array.
 */
function alphCompare(a: string, b: string): number {
  const ax = [...a];
  const bx = [...b];
  const n = Math.min(ax.length, bx.length);
  for (let i = 0; i < n; i++) {
    const d = (ax[i].codePointAt(0) ?? 0) - (bx[i].codePointAt(0) ?? 0);
    if (d !== 0) return d;
  }
  return ax.length - bx.length;
}
