"use client";

// Mirror a tool's knobs to the URL hash so a tweaked configuration is
// shareable. Image data is never encoded — the hash only holds the
// small bag of settings that the tool's controls expose.
//
// Usage:
//
//   const [alphaThreshold, setAlphaThreshold] = useState(8);
//   const [softness, setSoftness] = useState(10);
//
//   useUrlSettings({
//     alphaThreshold: [alphaThreshold, setAlphaThreshold, 8],
//     softness: [softness, setSoftness, 10],
//   });
//
// Each entry is [currentValue, setter, defaultValue]. On mount, the
// hash is decoded and any present keys are pushed into their setters.
// On change, values that differ from their defaults are serialized back
// to `#s=<base64url(JSON)>` via history.replaceState. Defaults are
// stripped to keep URLs short; an all-defaults config clears the hash
// entirely.

import { useEffect, useRef } from "react";
/* eslint-disable react-hooks/exhaustive-deps */

const HASH_KEY = "s";

// Each tuple: [current value, setter, default value]. Per-entry T lets
// React's Dispatch<SetStateAction<T>> flow through (contravariance —
// (value: unknown) => void can't accept a setter typed for a specific T).
// The hook only JSON-roundtrips the values, so heterogeneous call sites
// land in Entry<any>.
type Entry<T = unknown> = readonly [T, (value: T) => void, T];
// biome-ignore lint/suspicious/noExplicitAny: heterogeneous setter bag — per-entry T narrows at call sites
type Settings = Record<string, Entry<any>>;

function toBase64Url(input: string): string {
  if (typeof window === "undefined") return "";
  const b64 = window.btoa(unescape(encodeURIComponent(input)));
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(input: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    const pad = input.length % 4 === 0 ? "" : "=".repeat(4 - (input.length % 4));
    const b64 = input.replace(/-/g, "+").replace(/_/g, "/") + pad;
    return decodeURIComponent(escape(window.atob(b64)));
  } catch {
    return null;
  }
}

function readHash(): Record<string, unknown> | null {
  if (typeof window === "undefined") return null;
  const raw = window.location.hash.replace(/^#/, "");
  if (!raw) return null;
  const params = new URLSearchParams(raw);
  const encoded = params.get(HASH_KEY);
  if (!encoded) return null;
  const json = fromBase64Url(encoded);
  if (!json) return null;
  try {
    const parsed = JSON.parse(json);
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

function writeHash(patch: Record<string, unknown>) {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (Object.keys(patch).length === 0) {
    if (url.hash) {
      url.hash = "";
      window.history.replaceState(null, "", url.toString());
    }
    return;
  }
  url.hash = `${HASH_KEY}=${toBase64Url(JSON.stringify(patch))}`;
  window.history.replaceState(null, "", url.toString());
}

export function useUrlSettings(settings: Settings) {
  const hydratedRef = useRef(false);

  // Hydrate from the hash once on mount. Closes over first-render
  // settings, which is enough — setters are stable across renders.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional — mount-only hydration
  useEffect(() => {
    if (hydratedRef.current) return;
    hydratedRef.current = true;
    const fromUrl = readHash();
    if (!fromUrl) return;
    for (const [key, entry] of Object.entries(settings)) {
      if (key in fromUrl) {
        const [, setter] = entry;
        setter(fromUrl[key]);
      }
    }
  }, []);

  // Mirror current values → hash. Keyed on a JSON signature of the
  // value bag so the effect re-runs only when values change (not on
  // every render, even though the settings object identity does).
  const signature = JSON.stringify(
    Object.fromEntries(Object.entries(settings).map(([k, v]) => [k, v[0]])),
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run on value changes only, not object-identity churn
  useEffect(() => {
    if (!hydratedRef.current) return;
    const patch: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(settings)) {
      const [value, , defaultValue] = entry;
      if (JSON.stringify(value) !== JSON.stringify(defaultValue)) {
        patch[key] = value;
      }
    }
    writeHash(patch);
  }, [signature]);
}
