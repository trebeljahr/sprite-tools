// Cell arithmetic for sprite sheets that are not flush.
//
// Real sheets (Kenney, itch.io, TexturePacker, Tiled) carry an outer margin and
// 1-2px gutters between cells. Slicing those as width/cols silently bleeds a
// strip of the neighbouring sprite into every frame, so every path that needs
// to know where a cell starts goes through here. DOM-free: browser UI, CLI and
// MCP server share it.

export interface GridMargin {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface GridSpacing {
  x: number;
  y: number;
}

export interface GridPadding {
  margin: GridMargin;
  spacing: GridSpacing;
}

// Four-sided margin, not marginX/marginY: detection can legitimately observe an
// asymmetric border (a trailing gutter that differs from the leading one), and
// the symmetric formula (W - 2*marginX - (cols-1)*spacingX)/cols then fails
// divisibility on a sheet that is actually fine. Spacing stays 2-axis because a
// gutter between cells has no per-side meaning.
export const ZERO_PADDING: GridPadding = Object.freeze({
  margin: Object.freeze({ left: 0, top: 0, right: 0, bottom: 0 }),
  spacing: Object.freeze({ x: 0, y: 0 }),
});

/** Loose author-facing input; normalizeGridPadding folds it into a GridPadding. */
export interface GridPaddingInput {
  margin?: number | Partial<GridMargin>;
  marginX?: number;
  marginY?: number;
  spacing?: number | Partial<GridSpacing>;
  spacingX?: number;
  spacingY?: number;
}

export class GridFitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GridFitError";
  }
}

export interface CellGeometry {
  cellW: number;
  cellH: number;
  padding: GridPadding;
}

function pixels(value: number, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new GridFitError(`${name} must be a finite number, got ${String(value)}`);
  }
  if (!Number.isInteger(value)) {
    throw new GridFitError(`${name} must be a whole number of pixels, got ${value}`);
  }
  if (value < 0) throw new GridFitError(`${name} must be >= 0, got ${value}`);
  return value;
}

/**
 * Fold the shorthands into the general form. Most specific wins:
 * per-side (`margin: {left}`) > axis (`marginX`) > uniform (`margin: 4`) > 0.
 * Same shape for spacing: `spacing: {x}` > `spacingX` > `spacing: 2` > 0.
 * A GridPadding passed back in is re-validated and defensively copied.
 */
export function normalizeGridPadding(input?: GridPaddingInput | GridPadding | null): GridPadding {
  if (!input) {
    return { margin: { left: 0, top: 0, right: 0, bottom: 0 }, spacing: { x: 0, y: 0 } };
  }

  // GridPadding is structurally a valid GridPaddingInput; read it as one.
  const inp = input as GridPaddingInput;

  const m = inp.margin;
  const sides = typeof m === "object" && m !== null ? m : undefined;
  const uniformM = typeof m === "number" ? pixels(m, "margin") : undefined;
  const marginX = inp.marginX === undefined ? undefined : pixels(inp.marginX, "marginX");
  const marginY = inp.marginY === undefined ? undefined : pixels(inp.marginY, "marginY");
  const side = (key: keyof GridMargin, axis: number | undefined): number => {
    const v = sides?.[key];
    if (v !== undefined) return pixels(v, `margin.${key}`);
    return axis ?? uniformM ?? 0;
  };

  const s = inp.spacing;
  const axes = typeof s === "object" && s !== null ? s : undefined;
  const uniformS = typeof s === "number" ? pixels(s, "spacing") : undefined;
  const spacingX = inp.spacingX === undefined ? undefined : pixels(inp.spacingX, "spacingX");
  const spacingY = inp.spacingY === undefined ? undefined : pixels(inp.spacingY, "spacingY");
  const gap = (key: keyof GridSpacing, shorthand: number | undefined): number => {
    const v = axes?.[key];
    if (v !== undefined) return pixels(v, `spacing.${key}`);
    return shorthand ?? uniformS ?? 0;
  };

  return {
    margin: {
      left: side("left", marginX),
      top: side("top", marginY),
      right: side("right", marginX),
      bottom: side("bottom", marginY),
    },
    spacing: { x: gap("x", spacingX), y: gap("y", spacingY) },
  };
}

export function isZeroPadding(p: GridPadding): boolean {
  return (
    p.margin.left === 0 &&
    p.margin.top === 0 &&
    p.margin.right === 0 &&
    p.margin.bottom === 0 &&
    p.spacing.x === 0 &&
    p.spacing.y === 0
  );
}

interface AxisLabels {
  size: string;
  lead: string;
  trail: string;
  gap: string;
  unit: string;
}

const X_AXIS: AxisLabels = {
  size: "width",
  lead: "marginLeft",
  trail: "marginRight",
  gap: "spacingX",
  unit: "columns",
};
const Y_AXIS: AxisLabels = {
  size: "height",
  lead: "marginTop",
  trail: "marginBottom",
  gap: "spacingY",
  unit: "rows",
};

/** Divisors of `inner` that would make a usable alternative count. */
function divisorSuggestions(inner: number, exclude: number): number[] {
  const out: number[] = [];
  for (let d = 2; d <= 32 && d <= inner; d++) {
    if (inner % d === 0 && d !== exclude) out.push(d);
    if (out.length === 5) break;
  }
  return out;
}

function fitAxis(
  total: number,
  count: number,
  lead: number,
  trail: number,
  gap: number,
  axis: AxisLabels,
): number {
  const inner = total - lead - trail - (count - 1) * gap;
  const head =
    `grid does not fit: ${axis.size} ${total} with ${axis.lead} ${lead}, ` +
    `${axis.trail} ${trail}, ${axis.gap} ${gap} leaves ${inner}px for ${count} ${axis.unit}`;
  if (inner <= 0) {
    throw new GridFitError(`${head} — margins and spacing use up the whole sheet.`);
  }
  const remainder = inner % count;
  if (remainder === 0) return inner / count;

  const cell = Math.floor(inner / count);
  const options: string[] = [];
  if (cell > 0) options.push(`${axis.trail} ${trail + remainder} for ${cell}px cells`);
  const divisors = divisorSuggestions(inner, count);
  if (divisors.length > 0) {
    options.push(`${axis.unit} ${divisors.join(" / ")} (divisors of ${inner})`);
  }
  const advice = options.length > 0 ? ` Try ${options.join(", or ")}.` : "";
  throw new GridFitError(
    `${head} (${(inner / count).toFixed(2)}px each) — not a whole number.${advice}`,
  );
}

/**
 * Cell size for a cols×rows grid.
 *
 * Divisibility policy is deliberately asymmetric. Zero padding takes the legacy
 * path and floors, exactly as every flush call site does today — turning that
 * into an error would break sheets that slice fine right now. But a caller who
 * states a margin or a gutter has asserted an exact geometry, so a mismatch
 * there is a real error and a message beats a silently wrong slice.
 */
export function computeCellGeometry(
  width: number,
  height: number,
  cols: number,
  rows: number,
  padding?: GridPaddingInput | GridPadding | null,
): CellGeometry {
  if (!Number.isInteger(cols) || cols <= 0) {
    throw new GridFitError(`cols must be a positive integer, got ${cols}`);
  }
  if (!Number.isInteger(rows) || rows <= 0) {
    throw new GridFitError(`rows must be a positive integer, got ${rows}`);
  }
  const p = normalizeGridPadding(padding);

  if (isZeroPadding(p)) {
    return { cellW: Math.floor(width / cols), cellH: Math.floor(height / rows), padding: p };
  }

  return {
    cellW: fitAxis(width, cols, p.margin.left, p.margin.right, p.spacing.x, X_AXIS),
    cellH: fitAxis(height, rows, p.margin.top, p.margin.bottom, p.spacing.y, Y_AXIS),
    padding: p,
  };
}

/** Top-left corner and size of one cell. Reduces to col*cellW / row*cellH when flush. */
export function cellRect(
  geom: CellGeometry,
  col: number,
  row: number,
): { x: number; y: number; w: number; h: number } {
  return {
    x: geom.padding.margin.left + col * (geom.cellW + geom.padding.spacing.x),
    y: geom.padding.margin.top + row * (geom.cellH + geom.padding.spacing.y),
    w: geom.cellW,
    h: geom.cellH,
  };
}
