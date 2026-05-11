import Link from "next/link";
import { Github } from "lucide-react";

// Repo URL lives in one place. Swap when the repo moves.
export const REPO_URL = "https://github.com/trebeljahr/sprite-tools";
const VERSION = "0.1.0";

export function SiteFooter() {
  return (
    <footer className="mt-auto border-t border-border/40 bg-background/50">
      <div className="container mx-auto max-w-5xl px-4 py-4 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <div className="flex items-center gap-3">
          <span>sprite-tools v{VERSION}</span>
          <span aria-hidden>·</span>
          <Link href="/docs" className="hover:text-foreground transition-colors">
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
          <span>
            Built with{" "}
            <svg
              aria-hidden="true"
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="currentColor"
              className="inline-block h-3.5 w-3.5 align-[-0.2em] text-[#e8839b]"
              style={{ animation: "heartbeat 2s ease-in-out infinite" }}
            >
              <path d="M11.645 20.91l-.007-.003-.022-.012a15.247 15.247 0 01-.383-.218 25.18 25.18 0 01-4.244-3.17C4.688 15.36 2.25 12.174 2.25 8.25 2.25 5.322 4.714 3 7.688 3A5.5 5.5 0 0112 5.052 5.5 5.5 0 0116.313 3c2.973 0 5.437 2.322 5.437 5.25 0 3.925-2.438 7.111-4.739 9.256a25.175 25.175 0 01-4.244 3.17 15.247 15.247 0 01-.383.219l-.022.012-.007.004-.003.001a.752.752 0 01-.704 0l-.003-.001z" />
            </svg>{" "}
            by{" "}
            <Link
              href="https://portfolio.trebeljahr.com"
              className="hover:text-foreground transition-colors"
              target="_blank"
              rel="noopener noreferrer"
            >
              Rico Trebeljahr
            </Link>
            .
          </span>
        </div>
      </div>
    </footer>
  );
}
