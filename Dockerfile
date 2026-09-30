# syntax=docker/dockerfile:1
#
# Next.js + Coolify image for sprite-tools.
# Built by .github/workflows/deploy.yml, pushed to GHCR, pulled by
# Coolify via docker-compose.yml.
#
# Runtime: node + `next start`. NOT nginx + a static export, because
# this app has features that require a Node runtime and won't compile
# under `output: "export"`:
#   - Server Actions in src/app/actions.ts (xAI video generation)
#   - Route handler at src/app/%5Fe/route.ts (GlitchTip/Sentry tunnel)
#
# Env story: .env.production is committed dotenvx-encrypted. The build
# stage decrypts it via the dotenvx_private_key BuildKit secret (passed
# by the workflow from the GH Actions secret DOTENV_PRIVATE_KEY_PRODUCTION)
# so `next build` can inline NEXT_PUBLIC_* into the browser bundle. The
# runtime stage then decrypts again at startup so server-side secrets
# (XAI_API_KEY etc.) are available to Server Actions.
#
# Why BuildKit secrets and not ARG: ARG values land in `docker history`
# and the image manifest. BuildKit secrets are mounted as tmpfs at build
# time and never persist. Requires BuildKit (default in modern Docker;
# the workflow uses docker/setup-buildx-action which enables it).
ARG NODE_VERSION=24.21.0

# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS build
WORKDIR /app

RUN npm install -g pnpm@10.33.2

# Install deps first (layer cache) before copying source.
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .

# Two separate RUN steps on purpose: BuildKit echoes the entire RUN
# body into any failure log, so splitting the secret-presence check
# off means the "secret not supplied" message only surfaces when
# that's actually what failed — a downstream `next build` error
# won't drag the misleading echo into its context.
RUN --mount=type=secret,id=dotenvx_private_key,env=DOTENV_PRIVATE_KEY_PRODUCTION \
    test -n "$DOTENV_PRIVATE_KEY_PRODUCTION" || { \
      echo "ERROR: dotenvx_private_key build secret not supplied. The workflow at .github/workflows/deploy.yml should pass it via 'secrets:' from the GH Actions secret DOTENV_PRIVATE_KEY_PRODUCTION." >&2; \
      exit 1; \
    }

# dotenvx decrypts .env.production in memory and re-exports each
# KEY=VALUE for the wrapped command. next build sees the plain values
# and bakes NEXT_PUBLIC_* into the static client bundle.
RUN --mount=type=secret,id=dotenvx_private_key,env=DOTENV_PRIVATE_KEY_PRODUCTION \
    pnpm exec dotenvx run -- pnpm build

# ---------------------------------------------------------------------------
# Runtime — `next start` on PORT=8080.
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
WORKDIR /app

# curl for Coolify's health check. Coolify probes the container by
# running `curl … || wget … || exit 1` INSIDE it, in place of any
# HEALTHCHECK here, and bookworm-slim ships neither. Without one the
# probe can never pass and every deploy is rolled back. With it, a
# deploy is a rolling update: the old container serves until this one
# is healthy.
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV PORT=8080

# Bring across everything `next start` needs to serve the app. The
# encrypted .env.production travels with the image so dotenvx can
# decrypt at startup; the matching private key arrives via the
# container env (set by Coolify, see docker-compose.yml).
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/package.json ./
COPY --from=build /app/pnpm-lock.yaml ./
COPY --from=build /app/next.config.ts ./
COPY --from=build /app/.env.production ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/scripts/db-migrate.mjs ./scripts/db-migrate.mjs
COPY --from=build /app/scripts/account-credit.mjs ./scripts/account-credit.mjs
COPY --from=build /app/db ./db

RUN mkdir -p /app/.next/cache && chown -R node:node /app/.next/cache
USER node

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=5 \
  CMD node -e "require('http').get('http://127.0.0.1:8080/',r=>{process.exit(r.statusCode<400?0:1)}).on('error',()=>process.exit(1))"

# dotenvx decrypts .env.production at startup using
# DOTENV_PRIVATE_KEY_PRODUCTION from the container env (forwarded by
# Coolify via docker-compose.yml). next start then sees XAI_API_KEY,
# NEXT_PUBLIC_*, etc. and binds to PORT=8080 from the ENV above.
CMD ["./node_modules/.bin/dotenvx", "run", "--", "./node_modules/.bin/next", "start"]
