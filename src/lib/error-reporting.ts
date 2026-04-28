// GlitchTip wrapper — lazy-loads `@sentry/browser` in production and
// exposes a tiny `captureException()` helper. GlitchTip speaks the
// Sentry protocol, so the Sentry SDK works unmodified.
//
// Error reporting is a legitimate-interest category (debugging crashes
// affects every user) and does not require consent. If you prefer a
// stricter posture, gate this on `consent.ts` the same way analytics is.
//
// Env:
//   NEXT_PUBLIC_GLITCHTIP_DSN — Sentry-style DSN; empty ⇒ reporting off

const dsn = process.env.NEXT_PUBLIC_GLITCHTIP_DSN;
const isProd = process.env.NODE_ENV === "production";

export const errorReportingEnabled = Boolean(dsn) && isProd;

type SentryModule = typeof import("@sentry/browser");

let modulePromise: Promise<SentryModule> | null = null;
let initialized = false;

function loadSentry(): Promise<SentryModule> | null {
  if (!errorReportingEnabled) return null;
  if (typeof window === "undefined") return null;
  modulePromise ??= import("@sentry/browser");
  return modulePromise;
}

async function ensureInit(): Promise<SentryModule | null> {
  const mod = await loadSentry();
  if (!mod) return null;
  if (!initialized) {
    initialized = true;
    mod.init({
      dsn: dsn!,
      environment: process.env.NODE_ENV,
      // Same-origin proxy — see src/app/_e/route.ts. Sidesteps the
      // adblockers that default-block `*.glitchtip.*` and `*.sentry.*`
      // hosts; without this, ~30% of real error reports never arrive.
      tunnel: "/_e",
      // Intentionally conservative defaults — no session replay, no
      // performance tracing. Flip these on per-feature once you have a
      // reason and a budget for the extra network traffic.
      sampleRate: 1.0,
      tracesSampleRate: 0,
    });
  }
  return mod;
}

export function captureException(error: unknown, context?: Record<string, unknown>): void {
  void ensureInit().then((mod) => {
    if (!mod) return;
    if (context) {
      mod.withScope((scope) => {
        scope.setExtras(context);
        mod.captureException(error);
      });
    } else {
      mod.captureException(error);
    }
  });
}

// Boot GlitchTip as soon as the module is imported in a browser
// context, so unhandled errors caught by the SDK's global handlers are
// reported without any component needing to do something first.
if (typeof window !== "undefined" && errorReportingEnabled) {
  void ensureInit();
}
