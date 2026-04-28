"use client";

import { useState } from "react";
import { ChevronRight, Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";

// Collapsible JSON preview panel for every tool that emits JSON. Shows a
// head-first slice of the payload so users (and agents running against the
// page) can see the shape without downloading. Full JSON is still one click
// away via "Copy" / "Download".

interface JsonPreviewProps {
  data: unknown;
  /** Approx character cap on the rendered text when collapsed. */
  previewChars?: number;
  /** Hide the component when data is null / empty. */
  hideWhenEmpty?: boolean;
  className?: string;
}

export function JsonPreview({
  data,
  previewChars = 1200,
  hideWhenEmpty = true,
  className,
}: JsonPreviewProps) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  if (hideWhenEmpty && (data === null || data === undefined)) return null;

  const full = JSON.stringify(data, null, 2);
  const truncated = full.length > previewChars && !expanded;
  const shown = truncated ? `${full.slice(0, previewChars)}\n  …` : full;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(full);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      // Best-effort — clipboard may be unavailable in some contexts.
    }
  };

  const lineCount = full.split("\n").length;
  const byteLen = new TextEncoder().encode(full).length;

  return (
    <div className={cn("rounded-md border bg-muted/20 overflow-hidden", className)}>
      <div className="flex items-center gap-2 px-3 py-2 bg-muted/40 text-xs border-b">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="inline-flex items-center gap-1 font-mono text-muted-foreground hover:text-foreground transition-colors"
          title={expanded ? "Collapse" : "Expand"}
        >
          <ChevronRight className={cn("w-3 h-3 transition-transform", expanded && "rotate-90")} />
          output JSON
        </button>
        <span className="text-muted-foreground font-mono">
          {lineCount} lines · {formatBytes(byteLen)}
        </span>
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => void copy()}
          className="inline-flex items-center gap-1 px-2 py-1 rounded hover:bg-accent/40 transition-colors text-muted-foreground hover:text-foreground"
          title="Copy to clipboard"
        >
          {copied ? (
            <>
              <Check className="w-3 h-3" /> copied
            </>
          ) : (
            <>
              <Copy className="w-3 h-3" /> copy
            </>
          )}
        </button>
      </div>
      <pre className="p-3 text-[11px] leading-snug font-mono overflow-x-auto max-h-[min(60vh,32rem)] overflow-y-auto whitespace-pre">
        {shown}
      </pre>
      {truncated && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="w-full text-xs text-primary hover:bg-primary/5 py-2 border-t transition-colors"
        >
          Show full payload ({lineCount - shown.split("\n").length} more lines)
        </button>
      )}
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}
