#!/bin/sh
set -eu
if [ "${ACCOUNTS_MIGRATE_ON_START:-false}" = "true" ]; then
  node scripts/db-migrate.mjs
fi
exec ./node_modules/.bin/next start
