"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

export interface FrameCrop {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export const EMPTY_CROP: FrameCrop = { top: 0, right: 0, bottom: 0, left: 0 };

export function isCropEmpty(c: FrameCrop): boolean {
  return c.top === 0 && c.right === 0 && c.bottom === 0 && c.left === 0;
}

type HandleKind =
  | "move"
  | "n"
  | "s"
  | "e"
  | "w"
  | "ne"
  | "nw"
  | "se"
  | "sw";

interface CropOverlayProps {
  crop: FrameCrop;
  onCropChange: (crop: FrameCrop) => void;
  onCropCommit?: () => void;
  cellCols?: number;
  cellRows?: number;
  zoom?: number;
  disabled?: boolean;
  className?: string;
}

const MIN_REMAINING = 0.05;

export function CropOverlay({
  crop,
  onCropChange,
  onCropCommit,
  cellCols = 1,
  cellRows = 1,
  zoom = 1,
  disabled = false,
  className,
}: CropOverlayProps) {
  const rootRef = React.useRef<HTMLDivElement>(null);
  const [hover, setHover] = React.useState(false);

  const cellWFrac = 1 / cellCols;
  const cellHFrac = 1 / cellRows;

  const startDrag = (e: React.PointerEvent, kind: HandleKind) => {
    if (disabled) return;
    e.stopPropagation();
    e.preventDefault();
    const root = rootRef.current;
    if (!root) return;
    const rect = root.getBoundingClientRect();
    const cellPxW = (rect.width * cellWFrac) || 1;
    const cellPxH = (rect.height * cellHFrac) || 1;
    const startX = e.clientX;
    const startY = e.clientY;
    const startCrop = { ...crop };

    (e.target as Element).setPointerCapture?.(e.pointerId);

    const onMove = (ev: PointerEvent) => {
      const dx = (ev.clientX - startX) / cellPxW;
      const dy = (ev.clientY - startY) / cellPxH;
      const next = { ...startCrop };

      const applyN = (delta: number) => {
        next.top = Math.max(0, Math.min(1 - startCrop.bottom - MIN_REMAINING, startCrop.top + delta));
      };
      const applyS = (delta: number) => {
        next.bottom = Math.max(0, Math.min(1 - startCrop.top - MIN_REMAINING, startCrop.bottom - delta));
      };
      const applyW = (delta: number) => {
        next.left = Math.max(0, Math.min(1 - startCrop.right - MIN_REMAINING, startCrop.left + delta));
      };
      const applyE = (delta: number) => {
        next.right = Math.max(0, Math.min(1 - startCrop.left - MIN_REMAINING, startCrop.right - delta));
      };

      if (kind === "move") {
        const innerW = 1 - startCrop.left - startCrop.right;
        const innerH = 1 - startCrop.top - startCrop.bottom;
        const maxLeft = 1 - innerW;
        const maxTop = 1 - innerH;
        next.left = Math.max(0, Math.min(maxLeft, startCrop.left + dx));
        next.right = 1 - innerW - next.left;
        next.top = Math.max(0, Math.min(maxTop, startCrop.top + dy));
        next.bottom = 1 - innerH - next.top;
      } else {
        if (kind.includes("n")) applyN(dy);
        if (kind.includes("s")) applyS(dy);
        if (kind.includes("w")) applyW(dx);
        if (kind.includes("e")) applyE(dx);
      }

      onCropChange(next);
    };

    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      onCropCommit?.();
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const insetStyle = (c: FrameCrop): React.CSSProperties => ({
    left: `${c.left * 100}%`,
    top: `${c.top * 100}%`,
    right: `${c.right * 100}%`,
    bottom: `${c.bottom * 100}%`,
  });

  const cropRect = insetStyle(crop);
  const scaledHandle = Math.max(6, Math.min(14, 10 / zoom));

  return (
    <div
      ref={rootRef}
      className={cn("absolute inset-0 pointer-events-none", className)}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
    >
      {Array.from({ length: cellRows }).map((_, row) =>
        Array.from({ length: cellCols }).map((_, col) => {
          const isPrimary = row === 0 && col === 0;
          const cellStyle: React.CSSProperties = {
            left: `${col * cellWFrac * 100}%`,
            top: `${row * cellHFrac * 100}%`,
            width: `${cellWFrac * 100}%`,
            height: `${cellHFrac * 100}%`,
          };
          return (
            <div
              key={`${row}-${col}`}
              className="absolute"
              style={cellStyle}
            >
              {/* Dimmed mask panels outside the crop */}
              <div
                className="absolute bg-black/55"
                style={{ left: 0, top: 0, right: 0, height: `${crop.top * 100}%` }}
              />
              <div
                className="absolute bg-black/55"
                style={{ left: 0, bottom: 0, right: 0, height: `${crop.bottom * 100}%` }}
              />
              <div
                className="absolute bg-black/55"
                style={{
                  left: 0,
                  top: `${crop.top * 100}%`,
                  bottom: `${crop.bottom * 100}%`,
                  width: `${crop.left * 100}%`,
                }}
              />
              <div
                className="absolute bg-black/55"
                style={{
                  right: 0,
                  top: `${crop.top * 100}%`,
                  bottom: `${crop.bottom * 100}%`,
                  width: `${crop.right * 100}%`,
                }}
              />

              {/* Crop rectangle border */}
              <div
                className={cn(
                  "absolute border-2 border-primary/90",
                  isPrimary ? "shadow-[0_0_0_1px_rgba(0,0,0,0.35)]" : "border-primary/50 border-dashed",
                )}
                style={cropRect}
              >
                {/* Rule-of-thirds */}
                {isPrimary && hover && (
                  <>
                    <div className="absolute inset-y-0 left-1/3 w-px bg-white/30" />
                    <div className="absolute inset-y-0 left-2/3 w-px bg-white/30" />
                    <div className="absolute inset-x-0 top-1/3 h-px bg-white/30" />
                    <div className="absolute inset-x-0 top-2/3 h-px bg-white/30" />
                  </>
                )}
              </div>

              {/* Handles (primary cell only) */}
              {isPrimary && !disabled && (
                <>
                  <Handle
                    kind="move"
                    style={{ ...cropRect, pointerEvents: "auto" }}
                    className="cursor-move"
                    onPointerDown={startDrag}
                    size={scaledHandle}
                    variant="move"
                  />
                  <Handle
                    kind="n"
                    style={{
                      left: `calc(${crop.left * 100}% + ${(1 - crop.left - crop.right) * 50}%)`,
                      top: `${crop.top * 100}%`,
                    }}
                    className="cursor-ns-resize"
                    onPointerDown={startDrag}
                    size={scaledHandle}
                  />
                  <Handle
                    kind="s"
                    style={{
                      left: `calc(${crop.left * 100}% + ${(1 - crop.left - crop.right) * 50}%)`,
                      bottom: `${crop.bottom * 100}%`,
                    }}
                    className="cursor-ns-resize"
                    onPointerDown={startDrag}
                    size={scaledHandle}
                  />
                  <Handle
                    kind="w"
                    style={{
                      left: `${crop.left * 100}%`,
                      top: `calc(${crop.top * 100}% + ${(1 - crop.top - crop.bottom) * 50}%)`,
                    }}
                    className="cursor-ew-resize"
                    onPointerDown={startDrag}
                    size={scaledHandle}
                  />
                  <Handle
                    kind="e"
                    style={{
                      right: `${crop.right * 100}%`,
                      top: `calc(${crop.top * 100}% + ${(1 - crop.top - crop.bottom) * 50}%)`,
                    }}
                    className="cursor-ew-resize"
                    onPointerDown={startDrag}
                    size={scaledHandle}
                  />
                  <Handle
                    kind="nw"
                    style={{ left: `${crop.left * 100}%`, top: `${crop.top * 100}%` }}
                    className="cursor-nwse-resize"
                    onPointerDown={startDrag}
                    size={scaledHandle}
                  />
                  <Handle
                    kind="ne"
                    style={{ right: `${crop.right * 100}%`, top: `${crop.top * 100}%` }}
                    className="cursor-nesw-resize"
                    onPointerDown={startDrag}
                    size={scaledHandle}
                  />
                  <Handle
                    kind="sw"
                    style={{ left: `${crop.left * 100}%`, bottom: `${crop.bottom * 100}%` }}
                    className="cursor-nesw-resize"
                    onPointerDown={startDrag}
                    size={scaledHandle}
                  />
                  <Handle
                    kind="se"
                    style={{ right: `${crop.right * 100}%`, bottom: `${crop.bottom * 100}%` }}
                    className="cursor-nwse-resize"
                    onPointerDown={startDrag}
                    size={scaledHandle}
                  />
                </>
              )}
            </div>
          );
        }),
      )}
    </div>
  );
}

interface HandleProps {
  kind: HandleKind;
  style: React.CSSProperties;
  className?: string;
  size: number;
  variant?: "corner" | "edge" | "move";
  onPointerDown: (e: React.PointerEvent, kind: HandleKind) => void;
}

function Handle({ kind, style, className, size, variant, onPointerDown }: HandleProps) {
  if (variant === "move") {
    return (
      <div
        className={cn("absolute pointer-events-auto", className)}
        style={style}
        onPointerDown={(e) => onPointerDown(e, kind)}
        onMouseDown={(e) => e.stopPropagation()}
      />
    );
  }
  return (
    <div
      className={cn(
        "absolute pointer-events-auto bg-white border border-primary rounded-sm -translate-x-1/2 -translate-y-1/2 shadow-md",
        className,
      )}
      style={{ ...style, width: size, height: size }}
      onPointerDown={(e) => onPointerDown(e, kind)}
      onMouseDown={(e) => e.stopPropagation()}
    />
  );
}
