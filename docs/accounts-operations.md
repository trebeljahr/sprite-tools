# Accounts and budgets

The accounts server (`packages/server`) is an Express app shaped like
Hatchkit's starter server. It uses Hatchkit's Better Auth, PostgreSQL and
isolated SES transactional-email conventions and serves only `/api/*`. The web
client is a static export on a Cloudflare Worker on the same hostname; see
`scripts/ROLLING_RELEASE.md` for the routing. Same origin means Better Auth's
base path `/api/auth`, its cookies and email links need no cross-site setup.

## Runtime setup

Use a dedicated PostgreSQL database for Sprite Tools. Hatchkit/Coolify-managed
Postgres is preferred: supply its private connection URL as `POSTGRES_URL` and
join the app to that database's network. Never expose Postgres publicly. Do
not move an existing deployment to another database without a separate data
migration plan.

Configure the server variables in `packages/server/.env.example`. Use a random
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

For the first rollout, set `ACCOUNTS_MIGRATE_ON_START=true` so the container
runs migrations before the server listens and exits if migration fails. The script
uses an advisory lock and is safe to rerun on subsequent starts. Alternatively,
before serving accounts, run `node dist/migrate-cli.js` in the server image
(`pnpm db:migrate` from a checkout) with the runtime connection variables. The
image contains the script and SQL. It takes an advisory
lock, applies the pinned Better Auth schema, then creates the budget/job tables
in a transaction. A failure must block the account rollout. Do not run migrations
with a shell that prints secrets, against production as a validation shortcut,
or through an unauthenticated HTTP endpoint.

After migration, `/api/health/accounts` must return `{ "ready": true }`. It checks
configuration and schema presence without reading user records. This is a rollout
check, not a substitute for checking email delivery and the full sign-in flow.

Releases go through `.github/workflows/deploy.yml` and the rolling release
controller (`scripts/ROLLING_RELEASE.md`). The account integration includes the
security fixes for dependencies, container port and the telemetry tunnel
(`/api/_e`). Preserve those fixes when deploying. Never regenerate the pipeline
blindly.

## Credit administration

Accounts begin with zero credit. Credit grants have no public API. An operator
with database access can run, inside the server container (or from
`packages/server` after `pnpm build`) with the runtime connection variables:

```sh
node dist/account-credit.js <verified-user-id> <positive-credits> <grant-uuid>
node dist/account-credit.js __global__ <positive-credits> <different-grant-uuid>
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

The video endpoints (`POST /api/video/generations`, `GET
/api/video/generations/:id`) and the raw provider adapter still fail closed:
they answer 503 without reading the upload or the session. The
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
