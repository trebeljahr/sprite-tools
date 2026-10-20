// Runtime feature flags. Read at build time because Next.js inlines
// `NEXT_PUBLIC_*` env vars. Defaults are "launch-safe": features that
// depend on unshipped infrastructure (real auth, billing, Stripe) stay
// dark in production until the flag is explicitly flipped on.
//
// To re-enable locally during development:
//   echo 'NEXT_PUBLIC_ENABLE_AI=true' >> .env.local

/**
 * Lists /animate in the sitemap. /generate is always on: it works with the
 * visitor's own xAI key, and AI credit depends on the server's config.
 */
export const AI_ENABLED = process.env.NEXT_PUBLIC_ENABLE_AI === "true";
