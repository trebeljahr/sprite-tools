// Unity texture `.meta` sidecar for a sliced sheet (spriteMode 2 / Multiple).
//
// Drop the generated `<texture>.png.meta` next to the PNG inside `Assets/` and
// Unity imports the sheet already sliced — no editor script, no Sprite Editor
// pass. The file is Unity-flavoured YAML 1.1: no `---`, LF endings, 2-space
// indent, inline flow maps for vectors. Key order below mirrors what Unity's
// own writer emits so that the file Unity rewrites after import is a minimal
// diff against ours.
//
// Field nesting is load-bearing and gets no error when wrong: `filterMode` and
// the wrap modes live under `textureSettings`, `enableMipMap` under `mipmaps`,
// `textureCompression` only inside a `platformSettings` entry. A key at the
// wrong level is silently ignored.
//
// No `node:` imports — this module is pulled into browser bundles, so the ID
// hashing is a local FNV-1a rather than `node:crypto`.

import type { NormalizedDoc, NormalizedFrame } from "./types";

/** 13 = Unity 6 (6000.x); 12 = Unity 2022.3 / 2023.x. */
export type UnitySerializedVersion = 12 | 13;

/** `FilterMode`: Point, Bilinear, Trilinear. Pixel art wants Point. */
export type UnityFilterMode = 0 | 1 | 2;

/** `SpriteMeshType`: FullRect, Tight. */
export type UnitySpriteMeshType = 0 | 1;

export interface UnityExportOptions {
  /**
   * `spritePixelsToUnits` (the C# name is `spritePixelsPerUnit`; the serialized
   * name never changed). Default: the first frame's untrimmed height, so one
   * sprite spans exactly one world unit.
   */
  pixelsPerUnit?: number;
  /** `textureSettings.filterMode`. Default 0 (Point). */
  filterMode?: UnityFilterMode;
  /**
   * Root + `DefaultTexturePlatform` `maxTextureSize`. Default: the larger of
   * 2048 (Unity's own default) and the next power of two that fits the sheet —
   * a sheet bigger than this is downscaled on import and every rect we wrote
   * silently becomes wrong.
   */
  maxTextureSize?: number;
  /** Default 13. Writing 13 into a 2022.3/2023.x editor is a future version. */
  serializedVersion?: UnitySerializedVersion;
  /**
   * Project-relative path of the PNG (e.g. `Assets/Art/hero.png`). Seeds the
   * asset guid and every sprite id, so pass the full path: seeding from a bare
   * filename makes two `hero.png` in different folders collide, and Unity
   * silently reassigns one of them.
   */
  assetPath?: string;
  /**
   * Reuse an existing asset guid (32 lowercase hex). Overwriting a `.meta` of
   * an asset already in a project with a *new* guid detaches every reference to
   * it, so callers that clobber should read the incumbent guid and pass it.
   */
  guid?: string;
  /** Default 0 (FullRect) — the quad is exactly the rect, which matters when a pivot sits outside the opaque area. */
  spriteMeshType?: UnitySpriteMeshType;
  /** `spriteGenerateFallbackPhysicsShape`. Default true. */
  generateFallbackPhysicsShape?: boolean;
  /** Emit collision polygons as per-sprite `physicsShape`. Default true. */
  physicsShape?: boolean;
}

/** `SpriteAlignment.Center` — Unity's default, and what it writes when no custom pivot exists. */
const ALIGNMENT_CENTER = 0;
/** `SpriteAlignment.Custom` — the ONLY value that makes Unity read the `pivot` field. */
const ALIGNMENT_CUSTOM = 9;
/** Unity's YAML class id for `Sprite`, the key of every `internalIDToNameTable` entry. */
const SPRITE_CLASS_ID = 213;
/** The identity RGBA swizzle, 0x03020100. */
const IDENTITY_SWIZZLE = 50462976;

/** `<texture>.meta` — the sidecar sits next to the PNG, extension included. */
export function unityMetaFilename(doc: NormalizedDoc): string {
  return `${doc.texture}.meta`;
}

export function toUnityMeta(doc: NormalizedDoc, opts: UnityExportOptions = {}): string {
  const sv = opts.serializedVersion ?? 13;
  if (sv !== 12 && sv !== 13) {
    throw new Error(`export(unity): serializedVersion must be 12 or 13, got ${sv}.`);
  }
  const platformSv = sv === 13 ? 4 : 3;
  const assetPath = opts.assetPath ?? doc.source ?? doc.texture;
  const guid = opts.guid !== undefined ? validateGuid(opts.guid) : deterministicGuid(assetPath);
  const pixelsPerUnit = Math.max(1, Math.round(opts.pixelsPerUnit ?? doc.frames[0].sourceSize.h));
  const maxTextureSize = Math.max(
    1,
    Math.round(
      opts.maxTextureSize ??
        Math.max(2048, nextPowerOfTwo(Math.max(doc.textureWidth, doc.textureHeight))),
    ),
  );
  const filterMode = opts.filterMode ?? 0;
  const meshType = opts.spriteMeshType ?? 0;
  const fallbackPhysics = opts.generateFallbackPhysicsShape === false ? 0 : 1;
  const wantsPhysics = opts.physicsShape !== false;

  // Scoped to this call: ids must depend only on the input, never on how many
  // times the exporter has run.
  const usedIds = new Set<number>();
  const sprites = doc.frames.map((frame) =>
    buildSprite(frame, doc, assetPath, wantsPhysics, usedIds),
  );

  const out: string[] = [];
  out.push("fileFormatVersion: 2");
  out.push(`guid: ${guid}`);
  out.push("TextureImporter:");

  // sv11+ writes internalIDToNameTable first, before externalObjects.
  if (sprites.length > 0) {
    out.push("  internalIDToNameTable:");
    for (const s of sprites) {
      out.push("  - first:");
      out.push(`      ${SPRITE_CLASS_ID}: ${s.internalId}`);
      out.push(`    second: ${s.yamlName}`);
    }
  } else {
    out.push("  internalIDToNameTable: []");
  }
  out.push("  externalObjects: {}");
  out.push(`  serializedVersion: ${sv}`);
  out.push("  mipmaps:");
  out.push("    mipMapMode: 0");
  out.push("    enableMipMap: 0");
  out.push("    sRGBTexture: 1");
  out.push("    linearTexture: 0");
  out.push("    fadeOut: 0");
  out.push("    borderMipMap: 0");
  out.push("    mipMapsPreserveCoverage: 0");
  out.push("    alphaTestReferenceValue: 0.5");
  out.push("    mipMapFadeDistanceStart: 1");
  out.push("    mipMapFadeDistanceEnd: 3");
  out.push("  bumpmap:");
  out.push("    convertToNormalMap: 0");
  out.push("    externalNormalMap: 0");
  out.push("    heightScale: 0.25");
  out.push("    normalMapFilter: 0");
  out.push("    flipGreenChannel: 0");
  out.push("  isReadable: 0");
  out.push("  streamingMipmaps: 0");
  out.push("  streamingMipmapsPriority: 0");
  out.push("  vTOnly: 0");
  out.push("  ignoreMipmapLimit: 0");
  out.push("  grayScaleToAlpha: 0");
  out.push("  generateCubemap: 6");
  out.push("  cubemapConvolution: 0");
  out.push("  seamlessCubemap: 0");
  out.push("  textureFormat: 1");
  out.push(`  maxTextureSize: ${maxTextureSize}`);
  out.push("  textureSettings:");
  out.push("    serializedVersion: 2");
  out.push(`    filterMode: ${filterMode}`);
  out.push("    aniso: 1");
  out.push("    mipBias: 0");
  out.push("    wrapU: 1");
  out.push("    wrapV: 1");
  out.push("    wrapW: 1");
  // nPOTScale 0 (None): anything else rescales a non-power-of-two sheet and
  // invalidates every rect below.
  out.push("  nPOTScale: 0");
  out.push("  lightmap: 0");
  out.push("  compressionQuality: 50");
  out.push("  spriteMode: 2");
  out.push("  spriteExtrude: 1");
  out.push(`  spriteMeshType: ${meshType}`);
  // Root alignment/spritePivot/spriteBorder apply to spriteMode 1 only; Unity
  // still writes them in Multiple mode, where they are inert.
  out.push("  alignment: 0");
  out.push("  spritePivot: {x: 0.5, y: 0.5}");
  out.push(`  spritePixelsToUnits: ${pixelsPerUnit}`);
  out.push("  spriteBorder: {x: 0, y: 0, z: 0, w: 0}");
  out.push(`  spriteGenerateFallbackPhysicsShape: ${fallbackPhysics}`);
  out.push("  alphaUsage: 1");
  out.push("  alphaIsTransparency: 1");
  out.push("  spriteTessellationDetail: -1");
  out.push("  textureType: 8");
  out.push("  textureShape: 1");
  out.push("  singleChannelComponent: 0");
  out.push("  flipbookRows: 1");
  out.push("  flipbookColumns: 1");
  out.push("  maxTextureSizeSet: 0");
  out.push("  compressionQualitySet: 0");
  out.push("  textureFormatSet: 0");
  out.push("  ignorePngGamma: 0");
  out.push("  applyGammaDecoding: 0");
  out.push(`  swizzle: ${IDENTITY_SWIZZLE}`);
  out.push("  cookieLightType: 0");
  out.push("  platformSettings:");
  out.push(`  - serializedVersion: ${platformSv}`);
  out.push("    buildTarget: DefaultTexturePlatform");
  out.push(`    maxTextureSize: ${maxTextureSize}`);
  out.push("    resizeAlgorithm: 0");
  out.push("    textureFormat: -1");
  // textureCompression exists ONLY here; a root-level copy is a silent no-op.
  out.push("    textureCompression: 0");
  out.push("    compressionQuality: 50");
  out.push("    crunchedCompression: 0");
  out.push("    allowsAlphaSplitting: 0");
  out.push("    overridden: 0");
  out.push("    ignorePlatformSupport: 0");
  out.push("    androidETC2FallbackOverride: 0");
  out.push("    forceMaximumCompressionQuality_BC6H_BC7: 0");
  out.push("  spriteSheet:");
  out.push("    serializedVersion: 2");
  out.push("    sprites:");
  for (const s of sprites) {
    out.push("    - serializedVersion: 2");
    out.push(`      name: ${s.yamlName}`);
    out.push("      rect:");
    out.push("        serializedVersion: 2");
    out.push(`        x: ${s.rect.x}`);
    out.push(`        y: ${s.rect.y}`);
    out.push(`        width: ${s.rect.w}`);
    out.push(`        height: ${s.rect.h}`);
    out.push(`      alignment: ${s.alignment}`);
    out.push(`      pivot: {x: ${num(s.pivot.x)}, y: ${num(s.pivot.y)}}`);
    out.push("      border: {x: 0, y: 0, z: 0, w: 0}");
    if (sv === 13) out.push("      customData: ");
    out.push("      outline: []");
    if (s.physicsShape.length === 0) {
      out.push("      physicsShape: []");
    } else {
      out.push("      physicsShape:");
      s.physicsShape.forEach((point, i) => {
        const lead = i === 0 ? "      - - " : "        - ";
        out.push(`${lead}{x: ${num(point.x)}, y: ${num(point.y)}}`);
      });
    }
    out.push("      tessellationDetail: -1");
    out.push("      bones: []");
    out.push(`      spriteID: ${s.spriteId}`);
    out.push(`      internalID: ${s.internalId}`);
    out.push("      vertices: []");
    // `indices` is a raw byte-blob field, so it serializes as an empty scalar
    // (with Unity's trailing space), never as `[]`.
    out.push("      indices: ");
    out.push("      edges: []");
    out.push("      weights: []");
  }
  // The single-sprite SpriteMetaData embedded in the same struct. Inert in
  // Multiple mode but always present; internalID 0 is its sentinel.
  out.push("    outline: []");
  if (sv === 13) out.push("    customData: ");
  out.push("    physicsShape: []");
  out.push("    bones: []");
  out.push("    spriteID: ");
  out.push("    internalID: 0");
  out.push("    vertices: []");
  out.push("    indices: ");
  out.push("    edges: []");
  out.push("    weights: []");
  out.push("    secondaryTextures: []");
  if (sv === 13) {
    out.push("    spriteCustomMetadata:");
    out.push("      entries: []");
  }
  if (sprites.length > 0) {
    out.push("    nameFileIdTable:");
    // Unity writes this map string-sorted, so "hero_10" precedes "hero_2".
    for (const s of [...sprites].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      out.push(`      ${s.yamlName}: ${s.internalId}`);
    }
  } else {
    out.push("    nameFileIdTable: {}");
  }
  out.push("  mipmapLimitGroupName: ");
  out.push("  pSDRemoveMatte: 0");
  out.push("  userData: ");
  out.push("  assetBundleName: ");
  out.push("  assetBundleVariant: ");

  return `${out.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Per-sprite geometry
// ---------------------------------------------------------------------------

interface UnitySprite {
  name: string;
  yamlName: string;
  rect: { x: number; y: number; w: number; h: number };
  alignment: number;
  pivot: { x: number; y: number };
  physicsShape: Array<{ x: number; y: number }>;
  spriteId: string;
  internalId: number;
}

function buildSprite(
  frame: NormalizedFrame,
  doc: NormalizedDoc,
  assetPath: string,
  wantsPhysics: boolean,
  usedIds: Set<number>,
): UnitySprite {
  const rect = unityRect(frame, doc.textureHeight);
  if (
    rect.x < 0 ||
    rect.y < 0 ||
    rect.x + rect.w > Math.round(doc.textureWidth) ||
    rect.y + rect.h > Math.round(doc.textureHeight)
  ) {
    throw new Error(
      `export(unity): frame "${frame.name}" rect (${rect.x}, ${rect.y}, ${rect.w}, ${rect.h}) ` +
        `falls outside the ${Math.round(doc.textureWidth)}×${Math.round(doc.textureHeight)} texture. ` +
        "Unity clamps or drops out-of-range rects, so this would import wrong — check that the " +
        "manifest's width/height match the packed PNG.",
    );
  }

  const internalId = uniqueInternalId(`${assetPath}/${frame.name}`, usedIds);
  const pivot = unityPivot(frame);

  return {
    name: frame.name,
    yamlName: yamlScalar(frame.name),
    rect,
    alignment: pivot ? ALIGNMENT_CUSTOM : ALIGNMENT_CENTER,
    // Unity zeroes the pivot field whenever alignment != 9, since it is unread.
    pivot: pivot ?? { x: 0, y: 0 },
    physicsShape: wantsPhysics ? unityPhysicsShape(frame, rect) : [],
    spriteId: spriteIdFor(internalId),
    internalId,
  };
}

/**
 * Our frames are top-left origin, +Y down. Unity texture space is bottom-left
 * origin, +Y up (`Texture2D.GetPixel`: "The lower left corner is (0, 0)"), so:
 *
 *     rect.y = textureHeight - yTopLeft - rect.height
 *
 * X is unchanged — the two X axes agree. Get this wrong and the sheet imports
 * vertically mirrored with no Unity error at all.
 */
function unityRect(frame: NormalizedFrame, textureHeight: number): UnitySprite["rect"] {
  const w = int(frame.frame.w);
  const h = int(frame.frame.h);
  return {
    x: int(frame.frame.x),
    y: int(textureHeight) - int(frame.frame.y) - h,
    w,
    h,
  };
}

/**
 * Unity pivots are normalized inside the sprite's own rect, origin at the
 * rect's BOTTOM-LEFT (`SpriteEditorUtility.GetPivotValue`: BottomLeft → (0,0),
 * TopRight → (1,1)). Ours are pixels on the untrimmed canvas, top-left origin,
 * so a trimmed frame's pivot rebases through `spriteSourceSize` first.
 */
function unityPivot(frame: NormalizedFrame): { x: number; y: number } | null {
  // Alignment 0 (Center) means the centre of the sprite's OWN rect. For a
  // trimmed frame that is the centre of whatever pixels survived trimming, so
  // each frame of an animation would anchor somewhere different and the sprite
  // would jump in place. Phaser, Pixi and Godot keep the untrimmed canvas; to
  // match them the canvas centre has to be spelled out as a custom pivot.
  const pivot =
    frame.pivot ??
    (frame.trimmed ? { x: frame.sourceSize.w / 2, y: frame.sourceSize.h / 2 } : null);
  if (!pivot) return null;
  const w = frame.frame.w;
  const h = frame.frame.h;
  if (w <= 0 || h <= 0) return null;
  const localX = pivot.x - frame.spriteSourceSize.x;
  const localY = pivot.y - frame.spriteSourceSize.y;
  return { x: localX / w, y: 1 - localY / h };
}

/**
 * `physicsShape` / `outline` points are PIXELS relative to the sprite rect's
 * CENTER, +Y up — confirmed from `SpriteOutlineModule.ConvertSpriteRectSpace-
 * ToTextureSpace`, which adds `(0.5*rect.width + rect.x, 0.5*rect.height +
 * rect.y)` to get back to texture space:
 *
 *     ux = px - rect.w / 2
 *     uy = rect.h / 2 - py
 *
 * Our points are px on the untrimmed canvas with a top-left origin, so they
 * rebase through `spriteSourceSize` exactly like the pivot does.
 *
 * Not verified: the Y flip reverses winding (a clockwise ring becomes
 * counter-clockwise) and no source states whether Unity's tessellator is
 * winding-agnostic. Pass `physicsShape: false` to fall back to Unity's own
 * generated shape if a collider comes out wrong.
 */
function unityPhysicsShape(
  frame: NormalizedFrame,
  rect: UnitySprite["rect"],
): Array<{ x: number; y: number }> {
  if (!frame.polygon || frame.polygon.length < 3) return [];
  const halfW = rect.w / 2;
  const halfH = rect.h / 2;
  return frame.polygon.map(([px, py]) => ({
    x: px - frame.spriteSourceSize.x - halfW,
    y: halfH - (py - frame.spriteSourceSize.y),
  }));
}

// ---------------------------------------------------------------------------
// Deterministic identity
// ---------------------------------------------------------------------------

/**
 * FNV-1a 64, carried in two 32-bit halves. Deliberately not `node:crypto`
 * (browser bundles) and not BigInt (tsconfig targets ES2017, where BigInt
 * literals are unavailable).
 */
function fnv1a64(input: string): { hi: number; lo: number } {
  let hi = 0xcbf29ce4;
  let lo = 0x84222325;
  for (const byte of new TextEncoder().encode(input)) {
    lo = (lo ^ byte) >>> 0;
    // Multiply by the 64-bit prime 0x100000001b3 = 2^40 + 0x1b3, so mod 2^64
    // the product collapses to hash * 0x1b3 + (hash.lo << 40) — the second
    // term lands in the high word as lo * 2^8.
    const productLo = lo * 0x1b3;
    const productHi = hi * 0x1b3 + Math.floor(productLo / 4294967296) + lo * 256;
    lo = productLo >>> 0;
    hi = productHi >>> 0;
  }
  return { hi, lo };
}

/**
 * FNV-1a lifts a byte's influence only ~8 bits up the state per byte that
 * follows it, so seeds differing in their last characters (`hero_00`,
 * `hero_01`, …) come out with near-identical high words. Eight trailing NULs
 * give every input byte room to reach the top of the 64-bit state.
 */
function hash64(input: string): { hi: number; lo: number } {
  return fnv1a64(`${input}\0\0\0\0\0\0\0\0`);
}

/**
 * A stable, non-zero sprite fileID. Unity's own ids span the full signed 64-bit
 * range; we stay inside ±2^52 so the number is an exact JS integer and
 * `String()` prints it losslessly — Unity only needs stability and uniqueness.
 *
 * Stability is the whole point: a re-export that produced different ids would
 * detach every prefab, scene and animation clip that referenced the sprites.
 */
function internalIdFor(seed: string): number {
  const h = hash64(seed);
  const raw = (h.hi & 0x1fffff) * 4294967296 + h.lo;
  const id = raw - 4503599627370496;
  return id === 0 ? 1 : id;
}

function uniqueInternalId(seed: string, usedIds: Set<number>): number {
  // Frame names are already unique, so this only guards against a hash
  // collision — and it must stay deterministic when it fires. Two sprites
  // sharing a fileID would make every reference to them ambiguous.
  let salt = 0;
  let id = internalIdFor(seed);
  while (usedIds.has(id)) {
    salt++;
    id = internalIdFor(`${seed}#${salt}`);
  }
  usedIds.add(id);
  return id;
}

/**
 * Unity's `Hash128` text form is four uint32 written low-nibble-first. Modern
 * Unity derives the spriteID from the sprite's fileID:
 *
 *     spriteID = encU32(lo32) + encU32(hi32) + encU32(0x80) + encU32(0)
 *
 * so the third group is always "08000000" and the fourth "00000000". This is
 * reverse-engineered from real Unity 6 / 2023.1 files (exact match on three
 * independent entries), not documented — older Unity wrote unrelated random
 * spriteIDs and those import fine too, so a mismatch is likely tolerated.
 */
function spriteIdFor(internalId: number): string {
  const lo = internalId >>> 0;
  const hi = Math.floor(internalId / 4294967296) >>> 0;
  return `${encU32(lo)}${encU32(hi)}${encU32(0x80)}${encU32(0)}`;
}

function encU32(v: number): string {
  let out = "";
  for (let i = 0; i < 8; i++) out += ((v >>> (4 * i)) & 0xf).toString(16);
  return out;
}

/**
 * 32 lowercase hex chars — Unity's asset identity. It is opaque to Unity, so a
 * hash of the asset path is a legitimate choice and keeps existing references
 * intact across re-exports.
 */
function deterministicGuid(assetPath: string): string {
  const a = hash64(`sprite-tools:unity:guid:0:${assetPath}`);
  const b = hash64(`sprite-tools:unity:guid:1:${assetPath}`);
  const hex = hex8(a.hi) + hex8(a.lo) + hex8(b.hi) + hex8(b.lo);
  // The all-zero guid is Unity's null reference; never hand it out.
  return /^0+$/.test(hex) ? `${hex.slice(0, 31)}1` : hex;
}

function hex8(v: number): string {
  return (v >>> 0).toString(16).padStart(8, "0");
}

function validateGuid(guid: string): string {
  const normalized = guid.trim().replace(/-/g, "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(normalized)) {
    throw new Error(
      `export(unity): guid must be 32 hex characters, got ${JSON.stringify(guid)}. ` +
        "Copy the `guid:` line out of the existing .meta to keep project references intact.",
    );
  }
  return normalized;
}

// ---------------------------------------------------------------------------
// YAML scalars
// ---------------------------------------------------------------------------

/**
 * Unity writes plain ASCII names bare and double-quotes anything else with
 * \xNN / \uNNNN escapes (observed: `second: "Da\xF1o0016_0"`). Raw UTF-8 in a
 * plain scalar is valid YAML but is not how Unity writes it, and its reader was
 * never verified against that form.
 */
function yamlScalar(name: string): string {
  if (/^[A-Za-z0-9_.][A-Za-z0-9_. -]*$/.test(name) && !name.endsWith(" ")) return name;
  let out = '"';
  for (const ch of name) {
    const code = ch.codePointAt(0) ?? 0;
    if (ch === '"' || ch === "\\") out += `\\${ch}`;
    else if (code >= 0x20 && code <= 0x7e) out += ch;
    else if (code <= 0xff) out += `\\x${code.toString(16).padStart(2, "0").toUpperCase()}`;
    else if (code <= 0xffff) out += `\\u${code.toString(16).padStart(4, "0").toUpperCase()}`;
    else out += `\\U${code.toString(16).padStart(8, "0").toUpperCase()}`;
  }
  return `${out}"`;
}

/** Rects are integers — Unity floors them anyway, and a fractional rect is a bug upstream. */
function int(v: number): number {
  const n = Math.round(v);
  return n === 0 ? 0 : n;
}

/** Unity writes `0`, `0.5`, `-8` — never `0.000000` or `-8.0`. */
function num(v: number): string {
  if (!Number.isFinite(v)) return "0";
  const rounded = Math.round(v * 1e6) / 1e6;
  return String(rounded === 0 ? 0 : rounded);
}

function nextPowerOfTwo(n: number): number {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}
