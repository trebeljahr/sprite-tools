# syntax=docker/dockerfile:1
#
# Sprite Tools accounts API (packages/server). Built from the repository root:
#   docker build -f packages/server/Dockerfile .
# by .github/workflows/deploy.yml, pushed to GHCR and pulled by the Coolify
# Image app. The web client is a static export served by a Cloudflare Worker;
# this image serves only /api on the same hostname.
#
# Runtime configuration comes from the container environment that Coolify
# sets (POSTGRES_URL, BETTER_AUTH_*, email transport). The committed,
# dotenvx-encrypted .env.production travels with the image and is decrypted
# at startup with DOTENV_PRIVATE_KEY_PRODUCTION (src/config/env.ts). Values in
# the container environment win over the file.
ARG NODE_VERSION=24.21.0

FROM node:${NODE_VERSION}-bookworm-slim AS build
WORKDIR /app
RUN npm install -g pnpm@10.33.2
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/server/package.json packages/server/
RUN pnpm install --frozen-lockfile --filter @sprite-tools/server
COPY packages/server packages/server
# esbuild bundles the server and its dependencies into dist/ (build.mjs), so
# the runtime stage carries no node_modules.
RUN pnpm --filter @sprite-tools/server build

FROM node:${NODE_VERSION}-bookworm-slim AS runtime
WORKDIR /app

# curl for Coolify's health check, which runs `curl … || wget …` inside the
# container in place of the HEALTHCHECK below; bookworm-slim ships neither.
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV PORT=8080
# Shutdown drain, timed against the Coolify health check (every 2 s, five
# retries); see src/drain.ts. Docker's stop timeout must stay at least 30 s.
ENV SHUTDOWN_DRAIN_SECONDS=20

# The commit this image was built from, reported by /api/health. The release
# controller polls it until it names the commit it deployed.
ARG COMMIT_SHA
ENV COMMIT_SHA=$COMMIT_SHA

# package.json only for "type": "module"; dist/ holds the bundled server,
# migrate-cli.js and account-credit.js; db/ the SQL migrations.
COPY --from=build /app/packages/server/package.json ./
COPY --from=build /app/packages/server/dist ./dist
COPY --from=build /app/packages/server/db ./db
COPY .env.production ./

# Coolify cannot set no-new-privileges on a Docker Image app, so the image
# carries no setuid/setgid programs that could raise privileges instead.
RUN find / -xdev -perm /6000 -type f -exec chmod a-s {} + \
  && test -z "$(find / -xdev -perm /6000 -type f -print -quit)"
USER node
EXPOSE 8080
STOPSIGNAL SIGTERM

HEALTHCHECK --interval=2s --timeout=5s --start-period=15s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||'8080')+'/api/health/accounts',{signal:AbortSignal.timeout(4000)}).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
