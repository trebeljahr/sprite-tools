#!/bin/sh
set -eu
if [ "${ACCOUNTS_MIGRATE_ON_START:-false}" = "true" ]; then
  node scripts/db-migrate.mjs
fi
exec node --require /usr/local/lib/drain.cjs ./node_modules/next/dist/bin/next start
