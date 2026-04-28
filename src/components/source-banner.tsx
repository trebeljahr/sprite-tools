"use client";

import { Link2, Upload, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useSharedProjectSource } from "@/lib/project/store";

// Thin banner at the top of each tool page that shows which source file is
// currently loaded and where it came from. The shared source can travel
// silently between tool tabs via IndexedDB — without an explicit affordance
// users see "ghost" uploads and get confused.
//
// Renders nothing when no source is loaded, so the tool's own empty state
// (upload zone) is the only thing the user sees on first visit.

interface SourceBannerProps {
  onReplace: () => void;
  className?: string;
}

export function SourceBanner({ onReplace, className }: SourceBannerProps) {
  const { sourceFile, clearSharedSource } = useSharedProjectSource();

  if (!sourceFile) return null;

  const kb = Math.round(sourceFile.size / 1024);

  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-md border border-border/60 bg-muted/30 px-3 py-1.5 mb-6 text-xs",
        className,
      )}
    >
      <Link2 className="w-3.5 h-3.5 text-primary shrink-0" />
      <div className="flex-1 min-w-0">
        <span className="font-mono truncate">{sourceFile.name}</span>
        <span className="text-muted-foreground ml-2">
          {kb.toLocaleString()} KB · shared across tools
        </span>
      </div>
      <button
        type="button"
        onClick={onReplace}
        className="inline-flex items-center gap-1 px-2 py-1 rounded hover:bg-accent/40 transition-colors text-muted-foreground hover:text-foreground"
        title="Upload a different image"
      >
        <Upload className="w-3 h-3" />
        Replace
      </button>
      <button
        type="button"
        onClick={() => void clearSharedSource()}
        className="inline-flex items-center p-1 rounded hover:bg-destructive/10 transition-colors text-muted-foreground hover:text-destructive"
        title="Clear source"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}
