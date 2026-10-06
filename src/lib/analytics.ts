// Named custom events for the self-hosted Plausible instance that
// app/layout.tsx loads on the production hostname. Plausible sets no
// cookies, so pageviews run without the consent banner; named events
// stay behind it and are only sent after the visitor accepts.
//
// Each event name needs a matching custom-event goal in the Plausible
// dashboard before it shows up in reports.

type PlausibleProps = Record<string, string | number | boolean>;

declare global {
  interface Window {
    plausible?: (event: string, options?: { props?: PlausibleProps }) => void;
  }
}

export const analyticsConfigured = process.env.NODE_ENV === "production";

let consentGranted = false;

export function enableAnalytics(): void {
  consentGranted = true;
}

export function disableAnalytics(): void {
  consentGranted = false;
}

export function track(name: string, properties?: PlausibleProps): void {
  if (!consentGranted || typeof window === "undefined") return;
  window.plausible?.(name, properties ? { props: properties } : undefined);
}
