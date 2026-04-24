"use client";

// Client-only provider bundle. Keeps the root layout a server component
// while still attaching browser-only concerns:
//   * error-reporting side-effect import — boots GlitchTip on first
//     render (no-op if DSN unset or NODE_ENV !== "production").
//   * ConsentProvider — localStorage-backed analytics consent state.
//   * ConsentBanner  — renders only when consent is still "pending".

import "@/lib/error-reporting";
import { ConsentProvider } from "@/lib/consent";
import { ConsentBanner } from "@/components/consent-banner";

export function ClientProviders({ children }: { children: React.ReactNode }) {
  return (
    <ConsentProvider>
      {children}
      <ConsentBanner />
    </ConsentProvider>
  );
}
