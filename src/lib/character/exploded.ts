export interface LayerBounds {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Pack actual visible bounds, using translation only, so no two parts obscure each other. */
export function explodedLayout(layers: LayerBounds[], sourceWidth: number, sourceHeight: number) {
  const gap = Math.max(12, Math.round(Math.max(sourceWidth, sourceHeight) * 0.035));
  const labelHeight = Math.max(18, Math.round(gap * 0.8));
  const slotWidth = (width: number) => Math.max(width, gap * 4);
  const nonempty = layers.filter((l) => l.width > 0 && l.height > 0);
  const area = nonempty.reduce(
    (sum, l) => sum + (slotWidth(l.width) + gap) * (l.height + gap + labelHeight),
    0,
  );
  const rowWidth = Math.max(
    sourceWidth,
    ...nonempty.map((l) => l.width + gap * 2),
    Math.sqrt(area * 1.5),
  );
  let x = gap,
    y = gap,
    rowHeight = 0,
    width = gap;
  const items = nonempty.map((l) => {
    if (x > gap && x + slotWidth(l.width) + gap > rowWidth) {
      x = gap;
      y += rowHeight + gap;
      rowHeight = 0;
    }
    const item = {
      ...l,
      slotWidth: slotWidth(l.width),
      left: x,
      top: y,
      dx: x - l.x,
      dy: y + labelHeight - l.y,
    };
    x += item.slotWidth + gap;
    rowHeight = Math.max(rowHeight, l.height + labelHeight);
    width = Math.max(width, x);
    return item;
  });
  return {
    width: Math.ceil(width),
    height: Math.ceil(y + rowHeight + gap),
    labelHeight,
    gap,
    items,
  };
}
