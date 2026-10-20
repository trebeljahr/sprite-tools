"use client";

// Client-only provider bundle. Keeps the root layout a server component
// while still attaching browser-only concerns:
//   * error-reporting side-effect import — boots GlitchTip on first
//     render (no-op if DSN unset or NODE_ENV !== "production").
//   * SupportedParam — records a `?supported=1` return from the donate page.
//   * ReleaseNotice  — asks before reloading a tab whose release expired.

import "@/lib/error-reporting";
import { ReleaseNotice } from "@/components/release-notice";
import { SupportedParam } from "@/components/supported-param";

export function ClientProviders({ children }: { children: React.ReactNode }) {
  return (
    <>
      {children}
      <SupportedParam />
      <ReleaseNotice />
    </>
  );
}
