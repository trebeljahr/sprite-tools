// Named custom events for the self-hosted Plausible instance that
// app/layout.tsx loads on the production hostname. Plausible sets no
// cookies and writes nothing to localStorage or sessionStorage, so
// events go out without a consent step. Keep props aggregate: tool,
// format and counts only, never file names or anything a person typed.
//
// Each event name needs a matching custom-event goal in the Plausible
// dashboard before it shows up in reports.

type PlausibleProps = Record<string, string | number | boolean>;

declare global {
  interface Window {
    plausible?: (event: string, options?: { props?: PlausibleProps }) => void;
  }
}

export function track(name: string, properties?: PlausibleProps): void {
  if (typeof window === "undefined") return;
  window.plausible?.(name, properties ? { props: properties } : undefined);
}
