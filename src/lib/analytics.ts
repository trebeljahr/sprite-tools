// OpenPanel wrapper — lazy-loads the SDK, gates on consent, and exposes
// a tiny `track()` / `identify()` API. The SDK is only imported after
// the user grants analytics consent, so visitors who reject tracking
// never download or execute it.
//
// Env (all `NEXT_PUBLIC_*`, inlined at build time):
//   NEXT_PUBLIC_OPENPANEL_CLIENT_ID    — required; empty ⇒ tracking off
//   NEXT_PUBLIC_OPENPANEL_API_URL      — defaults to the hosted endpoint
//   NEXT_PUBLIC_OPENPANEL_ENABLE_IN_DEV — "true" to also track in `next dev`

const clientId = process.env.NEXT_PUBLIC_OPENPANEL_CLIENT_ID;
const apiUrl = process.env.NEXT_PUBLIC_OPENPANEL_API_URL ?? "https://api.openpanel.dev";
const enableInDev = process.env.NEXT_PUBLIC_OPENPANEL_ENABLE_IN_DEV === "true";

const isProd = process.env.NODE_ENV === "production";

export const analyticsConfigured = Boolean(clientId) && (isProd || enableInDev);

type OpenPanelModule = typeof import("@openpanel/web");
type OpenPanelInstance = InstanceType<OpenPanelModule["OpenPanel"]>;

let modulePromise: Promise<OpenPanelModule> | null = null;
let instance: OpenPanelInstance | null = null;
let consentGranted = false;

function loadModule(): Promise<OpenPanelModule> | null {
  if (!analyticsConfigured) return null;
  if (typeof window === "undefined") return null;
  modulePromise ??= import("@openpanel/web");
  return modulePromise;
}

async function ensureInstance(): Promise<OpenPanelInstance | null> {
  if (instance) return instance;
  if (!consentGranted) return null;
  const mod = await loadModule();
  if (!mod) return null;
  instance = new mod.OpenPanel({
    clientId: clientId!,
    apiUrl,
    trackScreenViews: true,
    trackOutgoingLinks: false,
    trackAttributes: true,
  });
  return instance;
}

// Called by the consent provider when the user accepts. Loads the SDK
// and fires a pageview for the current URL so the first tracked event
// isn't whatever interaction they take next.
export function enableAnalytics(): void {
  if (consentGranted) return;
  consentGranted = true;
  void ensureInstance();
}

// Called when the user revokes consent. We can't "unload" the SDK, but
// we drop our reference so future calls no-op until consent is re-granted.
export function disableAnalytics(): void {
  consentGranted = false;
  instance = null;
}

export function track(name: string, properties?: Record<string, unknown>): void {
  if (!consentGranted) return;
  void ensureInstance().then((inst) => inst?.track(name, properties));
}

export function identify(profile: {
  profileId: string;
  firstName?: string;
  lastName?: string;
  email?: string;
}): void {
  if (!consentGranted) return;
  void ensureInstance().then((inst) => inst?.identify(profile));
}
