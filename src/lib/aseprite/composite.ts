// Frame compositing: flatten a parsed Aseprite document's cels into one
// canvas-sized RGBA8 buffer per frame.
//
// Pure and DOM-free — the pixel maths lives in ./blend, the ordering rules and
// the clipping live here. Kept separate from parse.ts so callers that only want
// layer-level access (extracting a single layer as a variant) can skip it.

import { blendInto } from "./blend";
import type { AseBlendMode, AseCel, AseCompositedFrame, AseDocument, AseLayer } from "./types";

export interface CompositeOptions {
  /**
   * Composite hidden layers too. Default false. Reference layers
   * (`AseLayer.reference`) stay out regardless: they are not hidden, Aseprite
   * simply never renders them into an export.
   */
  includeHiddenLayers?: boolean;
  /**
   * Restrict to these layer indices (used to extract a single layer as a
   * variant). Selecting a reference layer here still renders nothing; its raw
   * pixels are available on `AseDocument.cels`.
   */
  layerIndices?: number[];
}

/**
 * The blend mode Aseprite actually applies for this sprite's colour depth.
 *
 * A grayscale (16bpp) sprite renders through get_graya_blender, which has no
 * HSL blenders at all: hue, saturation, color and luminosity all return
 * graya_blender_normal (blend_funcs.cpp). Running the RGBA HSL maths on the
 * replicated grey instead is not equivalent — a grey triple has zero
 * saturation, so hue and saturation hand back the backdrop and the layer
 * vanishes. This matches an export of the sprite in its own grayscale format;
 * Aseprite's on-screen editor preview composites into RGB and does apply the
 * RGBA HSL blenders, so the two genuinely differ there.
 */
function effectiveBlendMode(mode: AseBlendMode, doc: AseDocument): AseBlendMode {
  if (doc.colorDepth !== 16) return mode;
  if (mode === "hue" || mode === "saturation" || mode === "color" || mode === "luminosity") {
    return "normal";
  }
  return mode;
}

/**
 * pixman's MUL_UN8: rounded 8-bit multiply. Duplicated from blend.ts on purpose
 * — cel*layer opacity has to round identically to the per-channel maths there,
 * and importing a helper across the module boundary would tie the two files
 * together for four lines of arithmetic.
 */
function mulUn8(a: number, b: number): number {
  const t = a * b + 0x80;
  return ((t >> 8) + t) >> 8;
}

/**
 * `layer.index` is the position in file order (spec NOTE.2) and a well-formed
 * document has layers[i].index === i, but nothing in the type enforces that, so
 * resolve through an explicit lookup rather than trusting array position.
 */
function indexLayers(doc: AseDocument): (AseLayer | undefined)[] {
  const byIndex: (AseLayer | undefined)[] = [];
  for (const layer of doc.layers) byIndex[layer.index] = layer;
  return byIndex;
}

function warnOnce(doc: AseDocument, message: string): void {
  if (!doc.warnings.includes(message)) doc.warnings.push(message);
}

/**
 * This implementation flattens groups: image layers are blended straight onto
 * the canvas, so a group's own blend mode and opacity (valid only when main
 * header flag 2 is set, per spec NOTE.6) are NOT applied. Doing that faithfully
 * would mean rendering each group to its own buffer and blending that buffer
 * down once — which also conflicts with the flat, cross-group z-index ordering
 * of NOTE.5. Rather than silently producing a wrong image we record it.
 */
function warnAboutGroupBlending(
  doc: AseDocument,
  includeHidden: boolean,
  selected: Set<number> | null,
): void {
  for (const layer of doc.layers) {
    if (layer.type !== "group") continue;
    if (layer.blendMode === "normal" && layer.opacity === 255) continue;
    if (!layer.effectivelyVisible && !includeHidden) continue;
    // A group excluded from this render can't affect the output either way.
    if (selected && !hasSelectedDescendant(doc, layer.index, selected)) continue;
    warnOnce(
      doc,
      `Layer group "${layer.name}" carries blend mode "${layer.blendMode}" and opacity ${layer.opacity}; ` +
        "compositing flattens groups, so the group's own blend mode and opacity were not applied.",
    );
  }
}

function hasSelectedDescendant(
  doc: AseDocument,
  groupIndex: number,
  selected: Set<number>,
): boolean {
  for (const candidate of doc.layers) {
    if (!selected.has(candidate.index)) continue;
    let parent = candidate.parentIndex;
    while (parent !== null) {
      if (parent === groupIndex) return true;
      parent = doc.layers.find((l) => l.index === parent)?.parentIndex ?? null;
    }
  }
  return false;
}

/**
 * Render order, back to front, per spec NOTE.5: sort by `layerIndex + zIndex`
 * ascending, and when two cels tie on that, by `zIndex` ascending.
 *
 * The tie-break is load-bearing, not decoration. Two cels can share an `order()`
 * while sitting on different layers — e.g. layer 2 with zIndex 0 and layer 0
 * with zIndex +2 both order to 2 — and Aseprite resolves that by drawing the
 * one with the smaller zIndex first, i.e. the cel that was *not* nudged stays
 * behind the one that was pushed forward onto it. Collapsing this to a plain
 * sort by layer index reverses those pairs.
 */
function orderCels(cels: AseCel[]): AseCel[] {
  return cels.slice().sort((a, b) => {
    const orderA = a.layerIndex + a.zIndex;
    const orderB = b.layerIndex + b.zIndex;
    if (orderA !== orderB) return orderA - orderB;
    return a.zIndex - b.zIndex;
  });
}

function renderFrame(
  doc: AseDocument,
  layerByIndex: (AseLayer | undefined)[],
  cels: AseCel[],
  frameIndex: number,
  includeHidden: boolean,
  selected: Set<number> | null,
): AseCompositedFrame {
  const width = doc.width;
  const height = doc.height;
  const dst = new Uint8ClampedArray(width * height * 4); // zero-filled: fully transparent

  for (const cel of orderCels(cels)) {
    const layer = layerByIndex[cel.layerIndex];
    if (!layer) continue;
    // Groups hold no pixels of their own; a cel on one would be malformed.
    if (layer.type === "group") continue;
    // render.cpp skips reference layers unless the editor's "show reference
    // layers" flag is set, which no save or export path sets.
    if (layer.reference) continue;
    if (!layer.effectivelyVisible && !includeHidden) continue;
    if (selected && !selected.has(cel.layerIndex)) continue;
    if (cel.width <= 0 || cel.height <= 0) continue;

    const opacity = mulUn8(cel.opacity, layer.opacity);
    if (opacity === 0) continue;

    // A short buffer would read `undefined` off the typed array and feed NaN
    // into the blender, which silently paints garbage rather than throwing.
    if (cel.pixels.length < cel.width * cel.height * 4) {
      warnOnce(
        doc,
        `Cel on layer "${layer.name}" has a truncated pixel buffer (${cel.pixels.length} bytes for ` +
          `${cel.width}x${cel.height}); it was skipped.`,
      );
      continue;
    }

    // Clipping. Cel x/y are SIGNED and a cel is routinely smaller than the
    // canvas, larger than it, or hanging off any edge — Aseprite stores only
    // the cel's dirty rectangle, and moving a layer past the canvas edge leaves
    // a negative origin behind. So intersect the cel rect with the canvas rect
    // first and walk only the overlap, deriving the source and destination
    // indices from separate row strides. Writing `dst[(cel.y + y) * width +
    // cel.x + x]` instead looks equivalent and is not: a negative cel.x makes
    // the row index underflow into the previous row (pixels wrap around to the
    // right edge one row up), and a cel wider than the canvas runs the same way
    // off the other side.
    const x0 = cel.x > 0 ? cel.x : 0;
    const y0 = cel.y > 0 ? cel.y : 0;
    const x1 = cel.x + cel.width < width ? cel.x + cel.width : width;
    const y1 = cel.y + cel.height < height ? cel.y + cel.height : height;
    if (x1 <= x0 || y1 <= y0) continue; // entirely off-canvas

    const src = cel.pixels;
    const mode = effectiveBlendMode(layer.blendMode, doc);
    const celX = cel.x;
    const celY = cel.y;
    const celWidth = cel.width;

    for (let y = y0; y < y1; y++) {
      // Row bases hoisted: one multiply per row instead of two per pixel.
      let srcIndex = ((y - celY) * celWidth + (x0 - celX)) * 4;
      let dstIndex = (y * width + x0) * 4;
      for (let x = x0; x < x1; x++) {
        // blendInto already drops zero-alpha sources (Aseprite's mask-colour
        // skip), but testing here avoids the call entirely — sprite cels are
        // mostly empty, so this is the difference that matters on a full sheet.
        const sa = src[srcIndex + 3];
        if (sa !== 0) {
          blendInto(
            dst,
            dstIndex,
            src[srcIndex],
            src[srcIndex + 1],
            src[srcIndex + 2],
            sa,
            mode,
            opacity,
          );
        }
        srcIndex += 4;
        dstIndex += 4;
      }
    }
  }

  return {
    width,
    height,
    durationMs: doc.frames[frameIndex]?.durationMs ?? 100,
    pixels: dst,
  };
}

export function compositeFrame(
  doc: AseDocument,
  frameIndex: number,
  opts: CompositeOptions = {},
): AseCompositedFrame {
  if (!Number.isInteger(frameIndex) || frameIndex < 0 || frameIndex >= doc.frameCount) {
    throw new RangeError(
      `compositeFrame: frameIndex ${frameIndex} is out of range (frameCount ${doc.frameCount})`,
    );
  }

  const includeHidden = opts.includeHiddenLayers === true;
  const selected = opts.layerIndices ? new Set(opts.layerIndices) : null;
  warnAboutGroupBlending(doc, includeHidden, selected);

  const cels: AseCel[] = [];
  for (const cel of doc.cels) if (cel.frameIndex === frameIndex) cels.push(cel);

  return renderFrame(doc, indexLayers(doc), cels, frameIndex, includeHidden, selected);
}

export function compositeFrames(
  doc: AseDocument,
  opts: CompositeOptions = {},
): AseCompositedFrame[] {
  const includeHidden = opts.includeHiddenLayers === true;
  const selected = opts.layerIndices ? new Set(opts.layerIndices) : null;
  warnAboutGroupBlending(doc, includeHidden, selected);

  const layerByIndex = indexLayers(doc);

  // Bucket once instead of rescanning doc.cels per frame — that scan is
  // O(frames * cels), which on a 100-frame, 10-layer file is a thousand passes
  // over the same array before a single pixel is touched.
  const buckets: AseCel[][] = [];
  for (let f = 0; f < doc.frameCount; f++) buckets.push([]);
  for (const cel of doc.cels) buckets[cel.frameIndex]?.push(cel);

  const frames: AseCompositedFrame[] = [];
  for (let f = 0; f < doc.frameCount; f++) {
    frames.push(renderFrame(doc, layerByIndex, buckets[f], f, includeHidden, selected));
  }
  return frames;
}
