"use client";

import Link from "next/link";
import { HelpCircle, type LucideIcon } from "lucide-react";

// Shared h1 + docs-link + category tint for every tool page.
// Keeps the chrome consistent and lets a user jump to the page's docs
// without hunting through the nav.

export type ToolCategory = "ai" | "extract" | "metadata" | "transform" | "export";

// Subtle category tints — same palette as the Tools dropdown. Applied to
// the title icon so each category stays glanceable across the app.
const CATEGORY_COLOR: Record<ToolCategory, string> = {
  ai: "text-violet-500",
  extract: "text-slate-400",
  metadata: "text-emerald-500",
  transform: "text-amber-500",
  export: "text-sky-500",
};

interface ToolHeaderProps {
  title: string;
  description: string;
  icon: LucideIcon;
  /** Path under /docs/web/<slug>; omit to hide the help link. */
  docs?: string;
  category?: ToolCategory;
}

export function ToolHeader({
  title,
  description,
  icon: Icon,
  docs,
  category = "metadata",
}: ToolHeaderProps) {
  return (
    <div className="text-center mb-8">
      <h1 className="text-4xl font-bold tracking-tight mb-2 flex items-center justify-center gap-2">
        <Icon className={`w-8 h-8 ${CATEGORY_COLOR[category]}`} />
        {title}
        {docs && (
          <Link
            href={docs.startsWith("/") ? docs : `/docs/web/${docs}`}
            className="inline-flex items-center text-muted-foreground/60 hover:text-foreground transition-colors"
            title="Open docs for this tool"
          >
            <HelpCircle className="w-4 h-4" />
          </Link>
        )}
      </h1>
      <p className="text-muted-foreground">{description}</p>
    </div>
  );
}
