import Link from "next/link";
import { Github, Heart } from "lucide-react";

// Repo URL lives in one place. Swap when the repo moves.
export const REPO_URL = "https://github.com/yourname/sprite-tools";
const VERSION = "0.1.0";

export function SiteFooter() {
  return (
    <footer className="mt-auto border-t border-border/40 bg-background/50">
      <div className="container mx-auto max-w-5xl px-4 py-4 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <div className="flex items-center gap-3">
          <span>sprite-tools v{VERSION}</span>
          <span aria-hidden>·</span>
          <Link
            href="/docs"
            className="hover:text-foreground transition-colors"
          >
            docs
          </Link>
          <span aria-hidden>·</span>
          <Link
            href={`${REPO_URL}/blob/main/LICENSE`}
            className="hover:text-foreground transition-colors"
            target="_blank"
            rel="noopener noreferrer"
          >
            MIT
          </Link>
        </div>
        <div className="flex items-center gap-3">
          <Link
            href={REPO_URL}
            className="inline-flex items-center gap-1.5 hover:text-foreground transition-colors"
            target="_blank"
            rel="noopener noreferrer"
          >
            <Github className="w-3.5 h-3.5" />
            GitHub
          </Link>
          <span className="inline-flex items-center gap-1">
            made with <Heart className="w-3 h-3 text-destructive/70" />
          </span>
        </div>
      </div>
    </footer>
  );
}
