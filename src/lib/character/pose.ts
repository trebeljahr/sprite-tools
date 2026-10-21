import { IDENTITY, pixels, poseTransforms, type Matrix } from "./core";
import type { CharacterBundle, Pixels } from "./types";
function point(m: Matrix, x: number, y: number) {
  return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
}
function bounds(im: Pixels) {
  let x = im.width,
    y = im.height,
    r = 0,
    b = 0;
  for (let yy = 0; yy < im.height; yy++)
    for (let xx = 0; xx < im.width; xx++)
      if (im.data[(yy * im.width + xx) * 4 + 3]) {
        x = Math.min(x, xx);
        y = Math.min(y, yy);
        r = Math.max(r, xx + 1);
        b = Math.max(b, yy + 1);
      }
  return { x, y, r, b };
}
/** Rasterized bend evidence uses the same inherited joint matrices as the Web preview. */
export function renderCharacterPose(bundle: CharacterBundle, angles: Record<string, number>) {
  const out = pixels(bundle.plan.width, bundle.plan.height),
    transforms = poseTransforms(bundle.plan, angles);
  let mayClip = false;
  for (const layer of bundle.layers) {
    const im = layer.image,
      m = transforms[layer.id] ?? IDENTITY,
      bb = bounds(im);
    if (bb.x >= bb.r) continue;
    const corners = [
      point(m, bb.x, bb.y),
      point(m, bb.r, bb.y),
      point(m, bb.r, bb.b),
      point(m, bb.x, bb.b),
    ];
    const x0 = Math.floor(Math.min(...corners.map((p) => p.x))),
      y0 = Math.floor(Math.min(...corners.map((p) => p.y))),
      x1 = Math.ceil(Math.max(...corners.map((p) => p.x))),
      y1 = Math.ceil(Math.max(...corners.map((p) => p.y)));
    mayClip ||= x0 < 0 || y0 < 0 || x1 > out.width || y1 > out.height;
    const det = m[0] * m[3] - m[1] * m[2],
      inv: Matrix = [
        m[3] / det,
        -m[1] / det,
        -m[2] / det,
        m[0] / det,
        (m[2] * m[5] - m[3] * m[4]) / det,
        (m[1] * m[4] - m[0] * m[5]) / det,
      ];
    for (let y = Math.max(0, y0); y < Math.min(out.height, y1); y++)
      for (let x = Math.max(0, x0); x < Math.min(out.width, x1); x++) {
        const p = point(inv, x + 0.5, y + 0.5),
          sx = p.x - 0.5,
          sy = p.y - 0.5,
          ix = Math.floor(sx),
          iy = Math.floor(sy);
        let a = 0;
        const color = [0, 0, 0];
        for (let dy = 0; dy < 2; dy++)
          for (let dx = 0; dx < 2; dx++) {
            const xx = ix + dx,
              yy = iy + dy;
            if (xx < 0 || yy < 0 || xx >= im.width || yy >= im.height) continue;
            const k = (yy * im.width + xx) * 4,
              w =
                ((dx ? sx - ix : 1 - sx + ix) * (dy ? sy - iy : 1 - sy + iy) * im.data[k + 3]) /
                255;
            a += w;
            for (let c = 0; c < 3; c++) color[c] += im.data[k + c] * w;
          }
        if (!a) continue;
        const k = (y * out.width + x) * 4,
          b = out.data[k + 3] / 255,
          t = a + b * (1 - a);
        for (let c = 0; c < 3; c++)
          out.data[k + c] = (color[c] + out.data[k + c] * b * (1 - a)) / t;
        out.data[k + 3] = t * 255;
      }
  }
  return { image: out, mayClip, angles, origin: bundle.plan.origin };
}
