#!/bin/sh
set -eu
if [ "${ACCOUNTS_MIGRATE_ON_START:-false}" = "true" ]; then
  node scripts/db-migrate.mjs
fi
if [ "${SPRITE_SHARED_ASSETS:-0}" = "1" ]; then
  # Loaded before drain.cjs so the drain health probe stays the outer handler.
  exec node --require /usr/local/lib/shared-assets.cjs --require /usr/local/lib/drain.cjs ./node_modules/next/dist/bin/next start
fi
exec node --require /usr/local/lib/drain.cjs ./node_modules/next/dist/bin/next start
