"use client";

// Side-by-side preview of every palette variant.
//
// Recoloring is O(pixels x palette) per variant, so a 12-variant set on a large
// frame is enough work to stall the color inputs if it all runs in one commit.
// Two rules keep the page responsive: paint at most one variant per animation
// frame, and only ever paint the frame the user is looking at — never the whole
// sheet.

import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";

import { applyPaletteSwap, type SwapEntry } from "@/lib/palette/extract";
import type { RGB } from "@/lib/pixel-art/pixelate";
import { cn } from "@/lib/utils";

export interface VariantPreview {
  name: string;
  slug: string;
  /** Output filename this variant would be written as. */
  file: string;
  swaps: SwapEntry[];
}

interface VariantGridProps {
  frame: ImageData | null;
  palette: RGB[];
  variants: VariantPreview[];
  className?: string;
}

/** Identity of a variant's *pixels* — renaming one must not repaint it. */
function swapSignature(variant: VariantPreview): string {
  return variant.swaps
    .map((s) => `${s.from.r},${s.from.g},${s.from.b}>${s.to.r},${s.to.g},${s.to.b}`)
    .join("|");
}

export function VariantGrid({ frame, palette, variants, className }: VariantGridProps) {
  const canvasRefs = useRef<(HTMLCanvasElement | null)[]>([]);
  // What each canvas currently holds. The ref drives the paint loop; the state
  // copy only drives the "still rendering" overlay.
  const paintedRef = useRef<{ frame: ImageData | null; palette: RGB[] | null; sigs: string[] }>({
    frame: null,
    palette: null,
    sigs: [],
  });
  const [paintedSigs, setPaintedSigs] = useState<string[]>([]);

  useEffect(() => {
    if (!frame || variants.length === 0) return;
    const painted = paintedRef.current;
    if (painted.frame !== frame || painted.palette !== palette) {
      painted.frame = frame;
      painted.palette = palette;
      painted.sigs = [];
      setPaintedSigs([]);
    }

    let raf = 0;
    let i = 0;
    const step = () => {
      while (i < variants.length && painted.sigs[i] === swapSignature(variants[i])) i++;
      if (i >= variants.length) return;

      const canvas = canvasRefs.current[i];
      const variant = variants[i];
      if (canvas) {
        canvas.width = frame.width;
        canvas.height = frame.height;
        const ctx = canvas.getContext("2d");
        if (ctx) {
          const out =
            variant.swaps.length > 0 ? applyPaletteSwap(frame, palette, variant.swaps) : frame;
          ctx.putImageData(out, 0, 0);
        }
      }

      const at = i;
      const sig = swapSignature(variant);
      painted.sigs[at] = sig;
      setPaintedSigs((prev) => {
        const next = [...prev];
        next[at] = sig;
        return next;
      });
      i++;
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [frame, palette, variants]);

  if (variants.length === 0) return null;

  return (
    <div
      className={cn("grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 gap-3", className)}
      data-testid="variant-grid"
    >
      {variants.map((variant, i) => (
        <figure
          // biome-ignore lint/suspicious/noArrayIndexKey: list position is the identity; names (and so slugs) are user-editable and may collide mid-typing
          key={`${variant.slug}-${i}`}
          className="rounded-lg border bg-muted/20 overflow-hidden"
        >
          <div className="relative aspect-square checkerboard-light flex items-center justify-center">
            <canvas
              ref={(el) => {
                canvasRefs.current[i] = el;
              }}
              className="w-full h-full object-contain p-1"
              style={{ imageRendering: "pixelated" }}
            />
            {paintedSigs[i] !== swapSignature(variant) && (
              <div className="absolute inset-0 flex items-center justify-center bg-background/60">
                <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
              </div>
            )}
          </div>
          <figcaption className="px-2 py-1.5 border-t">
            <p className="text-xs font-medium truncate" title={variant.name}>
              {variant.name}
            </p>
            <p
              className="text-[10px] font-mono text-muted-foreground truncate"
              title={variant.file}
            >
              {variant.file}
            </p>
          </figcaption>
        </figure>
      ))}
    </div>
  );
}
