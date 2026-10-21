import { z } from "zod";

const point = z.tuple([z.number().finite(), z.number().finite()]);
const line = z.tuple([point, point]);
export const inbetweenSchema = z.object({
  version: z.literal(1),
  frames: z.number().int().min(1).max(30).default(6),
  durationMs: z.number().int().min(80).max(4000).default(240),
  easing: z.enum(["linear", "smoothstep"]).default("smoothstep"),
  softness: z.number().min(0.1).max(100).default(4),
  guides: z
    .array(z.object({ name: z.string().max(100).optional(), from: line, to: line }))
    .min(1)
    .max(64),
});
export type InbetweenRecipe = z.infer<typeof inbetweenSchema>;
type Point = [number, number];
type Raster = { width: number; height: number; data: Uint8ClampedArray };
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

function prepared(guides: InbetweenRecipe["guides"], t: number) {
  return guides.map(({ from, to }) => {
    const p: Point = [lerp(from[0][0], to[0][0], t), lerp(from[0][1], to[0][1], t)];
    const q: Point = [lerp(from[1][0], to[1][0], t), lerp(from[1][1], to[1][1], t)];
    const dx = q[0] - p[0],
      dy = q[1] - p[1],
      length = Math.hypot(dx, dy);
    return {
      p,
      dx,
      dy,
      length,
      endpoints: [from, to].map(([a, b]) => ({
        x: a[0],
        y: a[1],
        dx: b[0] - a[0],
        dy: b[1] - a[1],
        length: Math.hypot(b[0] - a[0], b[1] - a[1]),
      })),
    };
  });
}

/** Bilinear sampling accumulates premultiplied RGB, excluding colour in invisible pixels. */
function sample(im: Raster, x: number, y: number, out: number[]) {
  out.fill(0);
  const ix = Math.floor(x),
    iy = Math.floor(y);
  for (let yy = 0; yy < 2; yy++)
    for (let xx = 0; xx < 2; xx++) {
      const sx = ix + xx,
        sy = iy + yy;
      if (sx < 0 || sy < 0 || sx >= im.width || sy >= im.height) continue;
      const k = (sy * im.width + sx) * 4;
      const a = (im.data[k + 3] / 255) * (xx ? x - ix : 1 - x + ix) * (yy ? y - iy : 1 - y + iy);
      for (let c = 0; c < 3; c++) out[c] += im.data[k + c] * a;
      out[3] += a;
    }
}

/** Guided line warping. Both endpoint images move into the intermediate pose before texture blending.
 * This cannot reconstruct occluded anatomy. Review crossings and silhouette changes before shipping.
 */
export function interpolatePoses(from: Raster, to: Raster, value: unknown) {
  const recipe = inbetweenSchema.parse(value);
  if (from.width !== to.width || from.height !== to.height)
    throw Error("Pose canvases must match.");
  const { width, height } = from;
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width * height > 4_194_304 ||
    width * height * (recipe.frames + 2) > 32_000_000
  )
    throw Error("Interpolation exceeds the canvas or 32 million output-pixel limit.");
  if (width * height * recipe.frames * recipe.guides.length > 256_000_000)
    throw Error(
      "Interpolation exceeds the guided-work limit; reduce canvas, frame count or guides.",
    );
  if (from.data.length !== width * height * 4 || to.data.length !== from.data.length)
    throw Error("Invalid RGBA pose data.");
  if (recipe.durationMs < (recipe.frames + 2) * 8)
    throw Error("Frame durations must be at least 8 ms.");
  for (const guide of recipe.guides) {
    for (const segment of [guide.from, guide.to]) {
      if (segment.some(([x, y]) => x < 0 || y < 0 || x >= width || y >= height))
        throw Error("Guide is outside the pose canvas.");
      if (Math.hypot(segment[1][0] - segment[0][0], segment[1][1] - segment[0][1]) < 0.01)
        throw Error("Guide lines must have nonzero length.");
    }
    // A line that collapses at any time has no perpendicular coordinate system.
    const a = [guide.from[1][0] - guide.from[0][0], guide.from[1][1] - guide.from[0][1]];
    const b = [guide.to[1][0] - guide.to[0][0] - a[0], guide.to[1][1] - guide.to[0][1] - a[1]];
    const divisor = b[0] ** 2 + b[1] ** 2;
    const t = divisor ? Math.max(0, Math.min(1, -(a[0] * b[0] + a[1] * b[1]) / divisor)) : 0;
    if (Math.hypot(a[0] + b[0] * t, a[1] + b[1] * t) < 0.01)
      throw Error(
        "Guide collapses during interpolation; keep endpoints in the same anatomical order.",
      );
  }
  const frames = [new ImageData(new Uint8ClampedArray(from.data), width, height)];
  const sa = [0, 0, 0, 0],
    sb = [0, 0, 0, 0];
  for (let index = 1; index <= recipe.frames; index++) {
    let t = index / (recipe.frames + 1);
    if (recipe.easing === "smoothstep") t = t * t * (3 - 2 * t);
    const guides = prepared(recipe.guides, t),
      out = new ImageData(width, height);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        let ax = 0,
          ay = 0,
          bx = 0,
          by = 0,
          total = 0;
        for (const g of guides) {
          const px = x - g.p[0],
            py = y - g.p[1];
          const u = (px * g.dx + py * g.dy) / (g.length * g.length);
          const v = (-px * g.dy + py * g.dx) / g.length;
          const distance =
            u < 0 ? Math.hypot(px, py) : u > 1 ? Math.hypot(px - g.dx, py - g.dy) : Math.abs(v);
          const weight = Math.sqrt(g.length) / (recipe.softness + distance) ** 2;
          const [a, b] = g.endpoints;
          ax += (a.x + u * a.dx - (v * a.dy) / a.length) * weight;
          ay += (a.y + u * a.dy + (v * a.dx) / a.length) * weight;
          bx += (b.x + u * b.dx - (v * b.dy) / b.length) * weight;
          by += (b.y + u * b.dy + (v * b.dx) / b.length) * weight;
          total += weight;
        }
        sample(from, ax / total, ay / total, sa);
        sample(to, bx / total, by / total, sb);
        const k = (y * width + x) * 4,
          alpha = lerp(sa[3], sb[3], t);
        if (alpha > 0) {
          for (let c = 0; c < 3; c++) out.data[k + c] = lerp(sa[c], sb[c], t) / alpha;
          out.data[k + 3] = alpha * 255;
        }
      }
    frames.push(out);
  }
  frames.push(new ImageData(new Uint8ClampedArray(to.data), width, height));
  const durations = frames.map(
    (_, i) =>
      Math.round(((i + 1) * recipe.durationMs) / frames.length) -
      Math.round((i * recipe.durationMs) / frames.length),
  );
  return { frames, durations, recipe };
}
