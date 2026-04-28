"use client";

import { Button } from "@/components/ui/button";
import { ZoomIn, ZoomOut, Maximize } from "lucide-react";
import { cn } from "@/lib/utils";

interface ViewportControlsProps {
  onZoomIn: () => void;
  onZoomOut: () => void;
  onReset: () => void;
  className?: string;
  size?: "sm" | "default" | "icon";
  variant?: "ghost" | "outline" | "default";
}

export function ViewportControls({
  onZoomIn,
  onZoomOut,
  onReset,
  className,
  size = "icon",
  variant = "ghost",
}: ViewportControlsProps) {
  const btnClass = cn(size === "icon" ? "h-8 w-8" : "h-8 px-3");

  return (
    <div className={cn("flex items-center gap-1", className)}>
      <Button
        size={size}
        variant={variant}
        className={btnClass}
        onClick={onZoomOut}
        title="Zoom Out"
      >
        <ZoomOut className="h-4 w-4" />
      </Button>
      <Button
        size={size}
        variant={variant}
        className={btnClass}
        onClick={onReset}
        title="Reset View"
      >
        <Maximize className="h-4 w-4" />
      </Button>
      <Button size={size} variant={variant} className={btnClass} onClick={onZoomIn} title="Zoom In">
        <ZoomIn className="h-4 w-4" />
      </Button>
    </div>
  );
}

export function ZoomIndicator({
  zoom,
  baseZoom = 1,
  className,
}: {
  zoom: number;
  baseZoom?: number;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "bg-black/60 text-white text-[10px] px-2 py-1 rounded-full font-mono pointer-events-none whitespace-nowrap",
        className,
      )}
    >
      {Math.round((zoom / baseZoom) * 100)}%
    </div>
  );
}
