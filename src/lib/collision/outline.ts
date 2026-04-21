// Collision outline generation.
//
// Given an RGBA ImageData, walk the alpha channel to produce a polygon that
// tightly wraps the opaque pixels. Pipeline:
//   1. Moore-neighbor contour tracing on pixels above an alpha threshold.
//   2. (Optional) Convex hull via Andrew's monotone chain — for engines that
//      want convex fixtures.
//   3. (Optional) Ramer–Douglas–Peucker simplification to cut the polygon
//      down to a usable point count.

export interface Point {
  x: number;
  y: number;
}

export interface OutlineOptions {
  /** Alpha channel value (0-255) above which a pixel is considered "inside". */
  alphaThreshold: number;
  /** RDP tolerance in pixels. 0 disables simplification. */
  simplifyTolerance: number;
  /** If true, reduce the polygon to its convex hull. */
  convexHull: boolean;
}

export const DEFAULT_OUTLINE_OPTIONS: OutlineOptions = {
  alphaThreshold: 10,
  simplifyTolerance: 1.5,
  convexHull: false,
};

export interface OutlineResult {
  polygon: Point[];
  rawContourLength: number;
  bounds: { x: number; y: number; width: number; height: number } | null;
}

export function generateOutline(
  imageData: ImageData,
  opts: Partial<OutlineOptions> = {},
): OutlineResult {
  const options = { ...DEFAULT_OUTLINE_OPTIONS, ...opts };
  const contour = traceContour(imageData, options.alphaThreshold);
  if (contour.length === 0) {
    return { polygon: [], rawContourLength: 0, bounds: null };
  }

  const bounds = computeBounds(contour);
  const hulled = options.convexHull ? convexHull(contour) : contour;
  const polygon =
    options.simplifyTolerance > 0 && hulled.length > 2
      ? simplifyPolygon(hulled, options.simplifyTolerance)
      : hulled;

  return { polygon, rawContourLength: contour.length, bounds };
}

// 8-neighbor offsets in clockwise order, starting at W. The index is the
// "direction" used by the tracing state machine.
const OFFSETS: Array<readonly [number, number]> = [
  [-1, 0], // 0 W
  [-1, -1], // 1 NW
  [0, -1], // 2 N
  [1, -1], // 3 NE
  [1, 0], // 4 E
  [1, 1], // 5 SE
  [0, 1], // 6 S
  [-1, 1], // 7 SW
];

/**
 * Moore-neighbor boundary trace. Starts from the topmost-leftmost opaque
 * pixel and walks the outer contour clockwise. Only returns the *outer*
 * boundary of the first connected region found — holes and disconnected
 * islands are ignored.
 */
export function traceContour(imageData: ImageData, alphaThreshold = 10): Point[] {
  const { width, height, data } = imageData;
  const isInside = (x: number, y: number): boolean => {
    if (x < 0 || x >= width || y < 0 || y >= height) return false;
    return data[(y * width + x) * 4 + 3] > alphaThreshold;
  };

  // Scan row-major for the first opaque pixel.
  let sx = -1;
  let sy = -1;
  outer: for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (isInside(x, y)) {
        sx = x;
        sy = y;
        break outer;
      }
    }
  }
  if (sx < 0) return [];

  const contour: Point[] = [{ x: sx, y: sy }];
  let bx = sx;
  let by = sy;
  // Virtual "previous" pixel sits to the west of start — matches the
  // left-to-right scan direction that found it.
  let prevDir = 0;

  const maxSteps = width * height * 4;
  for (let step = 0; step < maxSteps; step++) {
    let advanced = false;
    // Sweep 8 neighbors clockwise, starting one step past where we came from.
    for (let i = 1; i <= 8; i++) {
      const dir = (prevDir + i) % 8;
      const nx = bx + OFFSETS[dir][0];
      const ny = by + OFFSETS[dir][1];
      if (!isInside(nx, ny)) continue;

      // Stop on return to start — sufficient for outlines of sprite-shaped
      // silhouettes (no pathological figure-8s touching the start pixel).
      if (nx === sx && ny === sy && contour.length > 1) {
        return contour;
      }
      prevDir = (dir + 4) % 8;
      bx = nx;
      by = ny;
      contour.push({ x: nx, y: ny });
      advanced = true;
      break;
    }
    if (!advanced) break; // isolated pixel
  }
  return contour;
}

/** Ramer–Douglas–Peucker polyline simplification. Operates on the open
 * sequence — the seam between the last and first point is left unsimplified. */
export function simplifyPolygon(points: Point[], tolerance: number): Point[] {
  if (points.length < 3 || tolerance <= 0) return [...points];
  const toleranceSq = tolerance * tolerance;
  return rdp(points, 0, points.length - 1, toleranceSq);
}

function rdp(points: Point[], start: number, end: number, toleranceSq: number): Point[] {
  if (end - start < 2) return [points[start], points[end]];

  const a = points[start];
  const b = points[end];
  let maxDistSq = 0;
  let index = start;
  for (let i = start + 1; i < end; i++) {
    const d = perpDistSq(points[i], a, b);
    if (d > maxDistSq) {
      maxDistSq = d;
      index = i;
    }
  }

  if (maxDistSq > toleranceSq) {
    const left = rdp(points, start, index, toleranceSq);
    const right = rdp(points, index, end, toleranceSq);
    return [...left.slice(0, -1), ...right];
  }
  return [a, b];
}

function perpDistSq(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) {
    const ex = p.x - a.x;
    const ey = p.y - a.y;
    return ex * ex + ey * ey;
  }
  const num = dy * p.x - dx * p.y + b.x * a.y - b.y * a.x;
  return (num * num) / lenSq;
}

/** Andrew's monotone chain convex hull. Returns vertices in CCW order. */
export function convexHull(points: Point[]): Point[] {
  if (points.length < 3) return [...points];
  const pts = [...points].sort((p, q) => p.x - q.x || p.y - q.y);

  const cross = (o: Point, a: Point, b: Point) =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

  const lower: Point[] = [];
  for (const p of pts) {
    while (
      lower.length >= 2 &&
      cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0
    ) {
      lower.pop();
    }
    lower.push(p);
  }

  const upper: Point[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (
      upper.length >= 2 &&
      cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0
    ) {
      upper.pop();
    }
    upper.push(p);
  }

  lower.pop();
  upper.pop();
  return [...lower, ...upper];
}

function computeBounds(points: Point[]): { x: number; y: number; width: number; height: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return {
    x: minX,
    y: minY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
  };
}
