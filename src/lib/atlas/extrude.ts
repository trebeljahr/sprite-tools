// Edge extrusion (a.k.a. "bleed") for packed texture atlases.
//
// packAtlas() surrounds every sprite with a transparent gutter so neighbouring
// sprites never touch. That gutter is exactly what breaks rendering: GPUs
// sample atlases with bilinear filtering and mipmaps, so a texel on a sprite's
// border is blended with whatever sits just outside its rect. Against a
// transparent gutter that blend pulls in alpha 0 (and, in non-premultiplied
// pipelines, black RGB), which shows up in-engine as dark halos or seams
// around every sprite — worst at non-integer scales and on lower mip levels.
//
// The fix is to repeat each sprite's border pixels outward into the gutter, so
// the filter blends a sprite's edge colour with *itself*. Sprite rects in the
// manifest are unchanged — extrusion only fills space that was already
// reserved and empty — so nothing downstream needs new coordinates.
//
// No dependencies and no DOM APIs beyond ImageData, so the CLI and MCP server
// can run this under Node with the ImageData shim.

/** The minimal rect shape this module needs — matches PackResult from ./pack. */
export interface ExtrudeFrame {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Clamp a requested extrude amount to the gutter the padding actually provides.
 *
 * packAtlas() pads each sprite by `padding` on all four sides (w + padding*2),
 * so the gutter available to any one sprite on any one side is exactly
 * `padding` pixels. Extruding further would write into a neighbour's sprite
 * pixels. Extrude is therefore independent of padding but capped by it.
 *
 * At padding 0 this returns 0: extrusion becomes a no-op rather than silently
 * forcing a gutter, because growing the gutter would change atlas dimensions.
 * Negative or fractional inputs floor toward a sane integer >= 0.
 */
export function effectiveExtrude(extrude: number, padding: number): number {
  const want = Math.max(0, Math.floor(extrude) || 0);
  const room = Math.max(0, Math.floor(padding) || 0);
  return Math.min(want, room);
}

/**
 * Repeat each frame's edge pixels outward into the surrounding gutter, in place.
 *
 * Every destination pixel in the ring around a frame samples that frame's
 * nearest pixel (clamped in x and y), which handles the four edges and the four
 * corners uniformly: edges repeat the adjacent row/column, corners repeat the
 * corner pixel. The frame's own rect is never touched, and all writes are
 * clamped to the atlas bounds, so frames flush against an atlas edge are safe.
 *
 * `amount` should normally come from effectiveExtrude(); it is re-clamped to a
 * non-negative integer here so callers can pass a raw value safely.
 */
export function extrudeFrames(
  atlas: ImageData,
  frames: readonly ExtrudeFrame[],
  amount: number,
): void {
  const n = Math.max(0, Math.floor(amount) || 0);
  if (n === 0) return;

  const W = atlas.width;
  const H = atlas.height;
  const data = atlas.data;
  if (W <= 0 || H <= 0) return;

  for (const frame of frames) {
    const fx = frame.x;
    const fy = frame.y;
    const fw = frame.width;
    const fh = frame.height;
    if (fw <= 0 || fh <= 0) continue;

    // Source clamp range — the frame's own pixels, itself clipped to the atlas
    // so a partially out-of-bounds frame can never read outside the buffer.
    const srcMinX = Math.max(0, fx);
    const srcMaxX = Math.min(W - 1, fx + fw - 1);
    const srcMinY = Math.max(0, fy);
    const srcMaxY = Math.min(H - 1, fy + fh - 1);
    if (srcMaxX < srcMinX || srcMaxY < srcMinY) continue;

    // Destination ring — the padded rect, clipped to the atlas.
    const dstMinX = Math.max(0, fx - n);
    const dstMaxX = Math.min(W - 1, fx + fw - 1 + n);
    const dstMinY = Math.max(0, fy - n);
    const dstMaxY = Math.min(H - 1, fy + fh - 1 + n);

    for (let y = dstMinY; y <= dstMaxY; y++) {
      const insideY = y >= fy && y < fy + fh;
      const sy = y < srcMinY ? srcMinY : y > srcMaxY ? srcMaxY : y;
      const srcRow = sy * W;
      const dstRow = y * W;
      for (let x = dstMinX; x <= dstMaxX; x++) {
        // Skip the frame rect itself — never overwrite sprite pixels.
        if (insideY && x >= fx && x < fx + fw) continue;
        const sx = x < srcMinX ? srcMinX : x > srcMaxX ? srcMaxX : x;
        const si = (srcRow + sx) * 4;
        const di = (dstRow + x) * 4;
        data[di] = data[si];
        data[di + 1] = data[si + 1];
        data[di + 2] = data[si + 2];
        data[di + 3] = data[si + 3];
      }
    }
  }
}
