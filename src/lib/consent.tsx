"use client";

// Analytics consent state, persisted in localStorage. Single-category:
// the user either accepts analytics or rejects it. Error reporting is
// considered legitimate-interest and is not gated here.
//
// Consumers: <ConsentBanner /> reads `status` + `hydrated` to decide
// whether to render; settings pages call `grant()` / `revoke()` to let
// the user change their mind later.

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { analyticsConfigured, disableAnalytics, enableAnalytics } from "@/lib/analytics";

export type ConsentStatus = "pending" | "granted" | "denied";

const STORAGE_KEY = "sprite-tools:analytics-consent";

function readStored(): ConsentStatus {
  if (typeof window === "undefined") return "pending";
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    return v === "granted" || v === "denied" ? v : "pending";
  } catch {
    return "pending";
  }
}

function writeStored(value: Exclude<ConsentStatus, "pending">): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, value);
  } catch {
    // Storage blocked (private mode, quota). Treat as ephemeral.
  }
}

interface ConsentContextValue {
  status: ConsentStatus;
  // `hydrated` flips to true after the initial localStorage read —
  // gate UI that should only appear once we know the real state to
  // avoid a flash of "pending" banner on refresh.
  hydrated: boolean;
  configured: boolean;
  grant: () => void;
  revoke: () => void;
}

const NOOP: ConsentContextValue = {
  status: "denied",
  hydrated: true,
  configured: false,
  grant: () => {},
  revoke: () => {},
};

const ConsentContext = createContext<ConsentContextValue | null>(null);

export function ConsentProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<ConsentStatus>("pending");
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    // localStorage isn't available during SSR — read it after mount and
    // sync both status and hydration in the same commit.
    const stored = readStored();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setStatus(stored);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHydrated(true);
    if (stored === "granted") enableAnalytics();
  }, []);

  const grant = useCallback(() => {
    writeStored("granted");
    setStatus("granted");
    enableAnalytics();
  }, []);

  const revoke = useCallback(() => {
    writeStored("denied");
    setStatus("denied");
    disableAnalytics();
  }, []);

  return (
    <ConsentContext.Provider
      value={{
        status,
        hydrated,
        configured: analyticsConfigured,
        grant,
        revoke,
      }}
    >
      {children}
    </ConsentContext.Provider>
  );
}

export function useConsent(): ConsentContextValue {
  return useContext(ConsentContext) ?? NOOP;
}
