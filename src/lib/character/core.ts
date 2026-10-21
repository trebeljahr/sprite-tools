import {
  validatePlan,
  MAX_CHARACTER_PIXELS,
  type CharacterBundle,
  type CharacterPlan,
  type Pixels,
  type Point,
  type PreparedLayer,
} from "./types";

export function pixels(width: number, height: number): Pixels {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width * height > MAX_CHARACTER_PIXELS
  )
    throw new Error("Character must be at most 4 megapixels.");
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}
export function insidePolygon(x: number, y: number, poly: Point[]): boolean {
  let yes = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i],
      b = poly[j];
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) yes = !yes;
  }
  return yes;
}
function maskFor(width: number, height: number, poly: Point[]): Uint8Array {
  const m = new Uint8Array(width * height);
  const x0 = Math.max(0, Math.floor(Math.min(...poly.map((p) => p.x))));
  const y0 = Math.max(0, Math.floor(Math.min(...poly.map((p) => p.y))));
  const x1 = Math.min(width, Math.ceil(Math.max(...poly.map((p) => p.x))));
  const y1 = Math.min(height, Math.ceil(Math.max(...poly.map((p) => p.y))));
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) if (insidePolygon(x + 0.5, y + 0.5, poly)) m[y * width + x] = 1;
  return m;
}
export function composite(images: Pixels[]): Pixels {
  if (!images.length) throw new Error("No layers to composite.");
  const out = pixels(images[0].width, images[0].height);
  for (const img of images) {
    if (img.width !== out.width || img.height !== out.height)
      throw new Error("Layer canvas sizes must match.");
    for (let k = 0; k < out.data.length; k += 4) {
      const a = img.data[k + 3] / 255,
        b = out.data[k + 3] / 255,
        t = a + b * (1 - a);
      if (!a) continue;
      for (let c = 0; c < 3; c++)
        out.data[k + c] = (img.data[k + c] * a + out.data[k + c] * b * (1 - a)) / t;
      out.data[k + 3] = t * 255;
    }
  }
  return out;
}
/** Each original visible pixel has exactly one owner. Completion can never replace it. */
export function prepareCharacter(
  source: Pixels,
  input: unknown,
  completions: Record<string, Pixels> = {},
  completionKind: "imported" | "generated" | Record<string, "imported" | "generated"> = "imported",
): CharacterBundle {
  const plan = validatePlan(input),
    { width, height } = source;
  if (width !== plan.width || height !== plan.height || source.data.length !== width * height * 4)
    throw new Error("Plan and source canvas sizes must match.");
  for (const [id, im] of Object.entries(completions)) {
    if (!plan.parts.some((p) => p.id === id)) throw new Error(`Unknown completion part: ${id}`);
    if (im.width !== width || im.height !== height || im.data.length !== source.data.length)
      throw new Error("Completion must use the original canvas size.");
  }
  const masks = plan.parts.map((p) => maskFor(width, height, p.polygon));
  const owner = new Int16Array(width * height).fill(-1);
  for (let i = 0; i < masks.length; i++)
    for (let k = 0; k < owner.length; k++) if (masks[i][k] && source.data[k * 4 + 3]) owner[k] = i;
  let unassigned = 0;
  const remainder = pixels(width, height);
  for (let k = 0; k < owner.length; k++)
    if (owner[k] === -1 && source.data[k * 4 + 3]) {
      remainder.data.set(source.data.subarray(k * 4, k * 4 + 4), k * 4);
      unassigned++;
    }
  const layers: PreparedLayer[] = plan.parts.map((part, i) => {
    const visible = pixels(width, height),
      generated = pixels(width, height),
      hiddenMask = pixels(width, height);
    let visiblePixels = 0,
      hiddenPixels = 0,
      filledPixels = 0;
    const fill = completions[part.id];
    for (let k = 0; k < owner.length; k++) {
      const q = k * 4;
      if (owner[k] === i) {
        visible.data.set(source.data.subarray(q, q + 4), q);
        visiblePixels++;
      }
      // Fill only beneath opaque higher layers. This guarantees an unchanged rest-pose composite,
      // including anti-aliased alpha edges. No guesses outside the original silhouette.
      else if (masks[i][k] && owner[k] > i && source.data[q + 3] === 255) {
        hiddenMask.data.set([255, 255, 255, 255], q);
        hiddenPixels++;
        if (fill?.data[q + 3]) {
          generated.data.set(fill.data.subarray(q, q + 4), q);
          filledPixels++;
        }
      }
    }
    return {
      id: part.id,
      visible,
      generated,
      hiddenMask,
      image: composite([generated, visible]),
      visiblePixels,
      hiddenPixels,
      filledPixels,
      completion: !hiddenPixels
        ? "none"
        : filledPixels
          ? typeof completionKind === "string"
            ? completionKind
            : (completionKind[part.id] ?? "imported")
          : "missing",
    };
  });
  if (unassigned)
    layers.unshift({
      id: "unassigned",
      visible: remainder,
      generated: pixels(width, height),
      hiddenMask: pixels(width, height),
      image: remainder,
      visiblePixels: unassigned,
      hiddenPixels: 0,
      filledPixels: 0,
      completion: "none",
    });
  const reconstruction = composite(layers.map((l) => l.image));
  let changedPixels = 0;
  for (let k = 0; k < owner.length; k++) {
    const q = k * 4;
    if (
      source.data[q + 3] !== reconstruction.data[q + 3] ||
      (source.data[q + 3] &&
        [0, 1, 2].some((c) => source.data[q + c] !== reconstruction.data[q + c]))
    )
      changedPixels++;
  }
  return {
    plan,
    layers,
    reconstruction,
    report: {
      unassignedPixels: unassigned,
      changedPixels,
      warnings: [
        ...plan.notes,
        ...(unassigned
          ? [
              `${unassigned} visible pixels are unassigned. Correct the masks; these pixels are preserved in a separate layer.`,
            ]
          : []),
        ...layers
          .filter((l) => l.hiddenPixels > l.filledPixels)
          .map((l) => `${l.id}: ${l.hiddenPixels - l.filledPixels} hidden pixels need completion.`),
        "AI polygons and reconstructed anatomy are drafts. Review the bend test before rigging.",
      ],
    },
  };
}
export type Matrix = [number, number, number, number, number, number];
export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];
export function multiply(a: Matrix, b: Matrix): Matrix {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}
/** Angles are local to each joint; descendants inherit the entire parent transform. */
export function poseTransforms(
  plan: CharacterPlan,
  angles: Record<string, number>,
): Record<string, Matrix> {
  const out: Record<string, Matrix> = {};
  const visit = (id: string): Matrix => {
    if (out[id]) return out[id];
    const part = plan.parts.find((p) => p.id === id);
    if (!part) return IDENTITY;
    const a = ((angles[id] ?? 0) * Math.PI) / 180,
      c = Math.cos(a),
      s = Math.sin(a),
      p = part.pivot;
    const local: Matrix = [c, s, -s, c, p.x - c * p.x + s * p.y, p.y - s * p.x - c * p.y];
    out[id] = multiply(part.parent ? visit(part.parent) : IDENTITY, local);
    return out[id];
  };
  for (const p of plan.parts) visit(p.id);
  return out;
}
export function characterManifest(bundle: CharacterBundle, sourceHash?: string) {
  return {
    format: "sprite-tools-character",
    version: 1,
    sourceHash,
    canvas: { width: bundle.plan.width, height: bundle.plan.height },
    origin: bundle.plan.origin,
    plan: bundle.plan,
    layers: bundle.layers.map((l) => ({
      id: l.id,
      image: `layers/${l.id}.png`,
      visible: `visible/${l.id}.png`,
      generated: `generated/${l.id}.png`,
      hiddenMask: `masks/${l.id}.png`,
      visiblePixels: l.visiblePixels,
      hiddenPixels: l.hiddenPixels,
      filledPixels: l.filledPixels,
      completion: l.completion,
    })),
    report: bundle.report,
  };
}
