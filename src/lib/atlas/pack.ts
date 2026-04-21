// Texture-atlas packing via a growing binary tree.
//
// Based on Jake Gordon's classic O(n²) algorithm: sort rectangles by longest
// side descending, then insert each into a binary partition of free space,
// growing the root when nothing fits. Simple, deterministic, fairly tight.

export interface PackInput {
  id: string;
  width: number;
  height: number;
}

export interface PackResult {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Source trim info — extracted from the original un-trimmed sprite. */
  trimmed?: { sourceWidth: number; sourceHeight: number; offsetX: number; offsetY: number };
}

export interface PackedAtlas {
  width: number;
  height: number;
  frames: PackResult[];
}

export interface PackOptions {
  padding: number;
  powerOfTwo: boolean;
  maxWidth?: number;
  maxHeight?: number;
}

interface Node {
  x: number;
  y: number;
  w: number;
  h: number;
  used?: boolean;
  right?: Node;
  down?: Node;
}

export function packAtlas(
  inputs: PackInput[],
  trim: Map<string, PackResult["trimmed"]>,
  opts: PackOptions,
): PackedAtlas {
  if (inputs.length === 0) return { width: 0, height: 0, frames: [] };
  const pad = Math.max(0, Math.floor(opts.padding));

  // Pad each sprite's bounding box by the padding value (a full-pad border
  // around every sprite — caller can treat as a half-pad gutter on each side).
  const boxes = inputs.map((s) => ({
    input: s,
    w: s.width + pad * 2,
    h: s.height + pad * 2,
  }));

  // Insert tallest first — best-fit for the bin-tree heuristic.
  boxes.sort((a, b) => Math.max(b.w, b.h) - Math.max(a.w, a.h));

  const root: Node = { x: 0, y: 0, w: boxes[0].w, h: boxes[0].h };
  const placements = new Map<string, { x: number; y: number; w: number; h: number }>();

  for (const box of boxes) {
    const fit = findNode(root, box.w, box.h);
    let node: Node;
    if (fit) {
      node = splitNode(fit, box.w, box.h);
    } else {
      node = growNode(root, box.w, box.h, opts);
      if (!node) {
        throw new Error(
          `Cannot pack sprite ${box.input.id} (${box.input.width}×${box.input.height}): atlas hit max size.`,
        );
      }
    }
    placements.set(box.input.id, {
      x: node.x + pad,
      y: node.y + pad,
      w: box.input.width,
      h: box.input.height,
    });
  }

  const frames: PackResult[] = inputs.map((s) => {
    const p = placements.get(s.id)!;
    return {
      id: s.id,
      x: p.x,
      y: p.y,
      width: p.w,
      height: p.h,
      trimmed: trim.get(s.id),
    };
  });

  let width = root.w;
  let height = root.h;
  if (opts.powerOfTwo) {
    width = nextPowerOfTwo(width);
    height = nextPowerOfTwo(height);
  }

  return { width, height, frames };
}

function findNode(root: Node, w: number, h: number): Node | null {
  if (root.used) {
    return findNode(root.right!, w, h) ?? findNode(root.down!, w, h);
  }
  if (w <= root.w && h <= root.h) return root;
  return null;
}

function splitNode(node: Node, w: number, h: number): Node {
  node.used = true;
  node.down = { x: node.x, y: node.y + h, w: node.w, h: node.h - h };
  node.right = { x: node.x + w, y: node.y, w: node.w - w, h: h };
  return node;
}

function growNode(root: Node, w: number, h: number, opts: PackOptions): Node {
  const canGrowDown = w <= root.w;
  const canGrowRight = h <= root.h;
  const shouldGrowRight = canGrowRight && root.h >= root.w + w;
  const shouldGrowDown = canGrowDown && root.w >= root.h + h;

  const within = (nw: number, nh: number) => {
    if (opts.maxWidth && nw > opts.maxWidth) return false;
    if (opts.maxHeight && nh > opts.maxHeight) return false;
    return true;
  };

  if (shouldGrowRight && within(root.w + w, root.h)) return growRight(root, w, h);
  if (shouldGrowDown && within(root.w, root.h + h)) return growDown(root, w, h);
  if (canGrowRight && within(root.w + w, root.h)) return growRight(root, w, h);
  if (canGrowDown && within(root.w, root.h + h)) return growDown(root, w, h);
  return null as unknown as Node;
}

function growRight(root: Node, w: number, h: number): Node {
  // Mutate root in place so external references stay valid.
  const old: Node = {
    used: root.used,
    x: root.x,
    y: root.y,
    w: root.w,
    h: root.h,
    right: root.right,
    down: root.down,
  };
  root.used = true;
  root.x = 0;
  root.y = 0;
  root.w = old.w + w;
  root.h = old.h;
  root.down = old;
  root.right = { x: old.w, y: 0, w, h: old.h };
  const fit = findNode(root, w, h)!;
  return splitNode(fit, w, h);
}

function growDown(root: Node, w: number, h: number): Node {
  const old: Node = {
    used: root.used,
    x: root.x,
    y: root.y,
    w: root.w,
    h: root.h,
    right: root.right,
    down: root.down,
  };
  root.used = true;
  root.x = 0;
  root.y = 0;
  root.w = old.w;
  root.h = old.h + h;
  root.down = { x: 0, y: old.h, w: old.w, h };
  root.right = old;
  const fit = findNode(root, w, h)!;
  return splitNode(fit, w, h);
}

function nextPowerOfTwo(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

/**
 * Compute the opaque content rect of an ImageData. Returns null if fully
 * transparent. Callers use this to trim transparent padding before packing.
 */
export function computeTrimRect(src: ImageData): {
  x: number;
  y: number;
  w: number;
  h: number;
} | null {
  const W = src.width;
  const H = src.height;
  const d = src.data;
  let minX = W;
  let minY = H;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (d[(y * W + x) * 4 + 3] > 0) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}
