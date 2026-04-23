// Runtime feature flags. Read at build time because Next.js inlines
// `NEXT_PUBLIC_*` env vars. Defaults are "launch-safe": features that
// depend on unshipped infrastructure (real auth, billing, Stripe) stay
// dark in production until the flag is explicitly flipped on.
//
// To re-enable locally during development:
//   echo 'NEXT_PUBLIC_ENABLE_AI=true' >> .env.local

/**
 * AI Character / AI Animation. Requires real authentication + a credits
 * system + xAI/Pollinations API keys. None of that is wired up yet, so the
 * default is OFF — the Tools nav group and the pages are hidden entirely
 * until someone opts in.
 */
export const AI_ENABLED = process.env.NEXT_PUBLIC_ENABLE_AI === "true";
