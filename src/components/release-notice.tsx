"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

/**
 * Tell a tab its release has left the server's retained set, without
 * reloading it.
 *
 * During a rolling release both servers share browser assets through the
 * release volume (scripts/RETAINED-ASSETS.md), so an old tab keeps working
 * until its release expires. Tool settings live only in page state, so an
 * automatic reload would silently reset them. The tab asks instead; the
 * loaded project image is kept in IndexedDB and survives the reload.
 */
export function isExpired(commit: string, data: unknown): boolean {
  if (!data || typeof data !== "object") return false;
  const { schema, releases } = data as { schema?: unknown; releases?: unknown };
  return (
    schema === 2 &&
    Array.isArray(releases) &&
    releases.length >= 1 &&
    releases.length <= 6 &&
    releases.every((id) => typeof id === "string" && /^[a-f0-9]{40}$/.test(id)) &&
    !releases.includes(commit)
  );
}

export function ReleaseNotice() {
  const [expired, setExpired] = useState(false);
  useEffect(() => {
    const commit = process.env.NEXT_PUBLIC_BUILD_COMMIT;
    if (!commit || !/^[a-f0-9]{40}$/.test(commit)) return;
    let stopped = false;
    const check = async () => {
      try {
        const response = await fetch(`/releases.json?at=${Date.now()}`, {
          cache: "no-store",
          signal: AbortSignal.timeout(5000),
        });
        if (!response.ok || stopped) return;
        if (isExpired(commit, await response.json())) setExpired(true);
      } catch {
        /* A transient network failure says nothing about the release. */
      }
    };
    const resourceError = (event: Event) => {
      const source = event.target;
      if (source instanceof HTMLScriptElement && source.src.includes("/_next/static/"))
        void check();
    };
    const rejection = (event: PromiseRejectionEvent) => {
      if (event.reason?.name === "ChunkLoadError") void check();
    };
    const focus = () => void check();
    const interval = window.setInterval(check, 60_000);
    window.addEventListener("error", resourceError, true);
    window.addEventListener("unhandledrejection", rejection);
    window.addEventListener("focus", focus);
    void check();
    return () => {
      stopped = true;
      window.clearInterval(interval);
      window.removeEventListener("error", resourceError, true);
      window.removeEventListener("unhandledrejection", rejection);
      window.removeEventListener("focus", focus);
    };
  }, []);
  if (!expired) return null;
  return (
    <div
      role="status"
      data-testid="release-expired"
      className="fixed inset-x-4 bottom-4 z-50 mx-auto flex max-w-xl items-center gap-3 rounded-md border bg-background p-3 text-sm shadow-lg"
    >
      <span className="flex-1">
        A newer version of Sprite Tools is available. Reload to keep every tool working. Reloading
        resets the settings on this page.
      </span>
      <Button size="sm" onClick={() => window.location.reload()}>
        Reload
      </Button>
    </div>
  );
}
