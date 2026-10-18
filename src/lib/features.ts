// Runtime feature flags. Read at build time because Next.js inlines
// `NEXT_PUBLIC_*` env vars. Defaults are "launch-safe": features that
// depend on unshipped infrastructure (real auth, billing, Stripe) stay
// dark in production until the flag is explicitly flipped on.
//
// To re-enable locally during development:
//   echo 'NEXT_PUBLIC_ENABLE_AI=true' >> .env.local

/**
 * Legacy hosted AI Character UI. Hosted paid video remains disabled.
 * Video Studio has its own local companion and does not use this flag.
 */
export const AI_ENABLED = process.env.NEXT_PUBLIC_ENABLE_AI === "true";
