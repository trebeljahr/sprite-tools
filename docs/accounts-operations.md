# Accounts and budgets

This Next.js adaptation uses Hatchkit's Better Auth, PostgreSQL and isolated SES
transactional-email conventions. `hatchkit server add --dry-run --json` reports
this repository as already fullstack; do not scaffold over its existing app.
The default Hatchkit starter's Express server is not required by this app.

## Runtime setup

Use a dedicated PostgreSQL database for Sprite Tools. Hatchkit/Coolify-managed
Postgres is preferred: supply its private connection URL as `POSTGRES_URL` and
join the app to that database's network. Never expose Postgres publicly.
Alternatively include `docker-compose.accounts.yml` alongside the existing
compose file; set a unique `ACCOUNTS_DB_PASSWORD` and leave `POSTGRES_URL` empty.
Do not switch between these modes against an existing deployment without a
separate data migration plan.

Configure the server variables in `.env.accounts.example`. Use a random
`BETTER_AUTH_SECRET` of at least 32 characters and the exact HTTPS app origin.
Prefer Hatchkit isolated SES (`EMAIL_TRANSPORT=ses`) with the project-scoped
`SES_PROJECT_*` configuration. The runtime uses explicit credentials and enforces
sender identity, region, tenant and configuration set. Tests do not send email;
non-production delivery is restricted to `EMAIL_TEST_RECIPIENT`. Alternatively
configure a project-scoped Hatchkit Listmonk user/template/from address with
`EMAIL_TRANSPORT=listmonk`. Never install the shared relay credential in this app.
Email verification is mandatory. Missing email configuration disables accounts;
verification and reset links are never logged. Sessions are checked against the
database rather than a cached cookie; reset revokes existing sessions.

Before serving accounts, run `node scripts/db-migrate.mjs` with the runtime
connection variables. The image contains the script and SQL. It takes an advisory
lock, applies the pinned Better Auth schema, then creates the budget/job tables
in a transaction. A failure must block the account rollout. Do not run migrations
with a shell that prints secrets, against production as a validation shortcut,
or through an unauthenticated HTTP endpoint.

After migration, `/api/health/accounts` must return `{ "ready": true }`. It checks
configuration and schema presence without reading user records. This is a rollout
check, not a substitute for checking email delivery and the full sign-in flow.

The existing signed Hatchkit/GHCR deployment workflow remains in place. The
compose change only forwards account variables. The account integration includes
the security fixes for dependencies, container port and the telemetry tunnel.
Preserve those fixes when deploying. Never regenerate the pipeline blindly.

## Credit administration

Accounts begin with zero credit. Credit grants have no public API. An operator
with database access can run:

```sh
node scripts/account-credit.mjs <verified-user-id> <positive-credits> <grant-uuid>
node scripts/account-credit.mjs __global__ <positive-credits> <different-grant-uuid>
```

A grant UUID makes retries idempotent. Reusing it with different parameters fails.
No account query or grant should be run during automated tests against live data.
Credits are policy units, not a dollar estimate. Fund both the user and global
budgets. The ledger locks the global budget before account/job changes, reserves
atomically, deduplicates request IDs and scopes every job lookup to its owner.
An account can have only one unresolved reservation. Settling twice cannot spend
twice. Failed/uncertain provider attempts must not trigger an automatic refund;
timeout alone does not prove the provider did not charge.

## Paid generation remains disabled

The existing server actions and raw provider adapter still fail closed. The
ledger is a tested foundation, not an active payment or provider integration.
Before enabling dispatch, define provider pricing and a conservative credit cost,
add a durable job dispatcher with exactly-once claiming and crash recovery, and
connect authenticated actions to reservations and owner-scoped polling. Do not
just restore the old fetch calls or flip a public feature flag. No checkout,
subscription, payment collection, or free credits are included.

## Rollback and validation

Rollback the application image/config to its prior revision without deleting the
database or volume. Preserve account data and backups; dropping resources requires
explicit approval. Source migrations are additive. Schema rollback is not automatic.

Focused tests use an in-memory PGlite database, fake accounts and intercepted email.
They check the real Better Auth schema and unverified sign-in rejection, ownership,
idempotency, global/account budgets and settlement. PGlite uses a single connection;
these checks do not certify multi-process PostgreSQL lock behavior or live email,
proxy headers, backups, TLS, or production migrations. Verify those in an authorized
staging rollout before enabling paid generation.
