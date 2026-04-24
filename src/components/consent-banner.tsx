"use client";

// Cookie/consent banner. Only renders when analytics is configured,
// state has hydrated, and the user hasn't yet made a choice. Sits at
// the bottom of the screen so it doesn't cover the tool UI.

import Link from "next/link";
import { useConsent } from "@/lib/consent";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function ConsentBanner() {
  const { status, hydrated, configured, grant, revoke } = useConsent();

  if (!configured || !hydrated) return null;
  if (status !== "pending") return null;

  return (
    <div
      role="dialog"
      aria-label="Cookie consent"
      aria-live="polite"
      className={cn(
        "fixed bottom-4 left-4 right-4 z-50 mx-auto max-w-xl",
        "rounded-lg border border-border bg-background/95 p-4 shadow-lg",
        "supports-[backdrop-filter]:bg-background/80 backdrop-blur",
      )}
    >
      <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3">
        <p className="text-sm text-foreground flex-1">
          We use lightweight, privacy-friendly analytics (no third-party
          tracking, no ads) to see which tools get used. See our{" "}
          <Link
            href="/privacy"
            className="underline decoration-foreground/30 underline-offset-2 hover:decoration-foreground"
          >
            privacy page
          </Link>
          .
        </p>
        <div className="flex gap-2 shrink-0">
          <Button variant="outline" size="sm" onClick={revoke}>
            Reject
          </Button>
          <Button size="sm" onClick={grant}>
            Accept
          </Button>
        </div>
      </div>
    </div>
  );
}
