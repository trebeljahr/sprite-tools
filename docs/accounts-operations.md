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

## AI credit

AI credit is a prepaid balance in US dollars. The ledger stores integer
micro-dollars (1,000,000 = US$1) in `video_budgets`; the table names say
"video" because video came first. An account exists only to hold this credit;
every tool works without one, and `/generate` also works with the visitor's own
xAI key, which the browser sends straight to xAI and never to this server.

Prices: `packages/server/src/image-generation.ts` lists each xAI image model's
list price (`IMAGE_MODELS`, checked on `IMAGE_PRICING_DATE`) and
`MARGIN_PERCENT`. One image costs the list price plus the margin, rounded up to
the next micro-dollar. xAI bills images at a flat price per image, so the list
price is the measured cost. Change the price, the date and the client copy in
`src/lib/ai-image.ts` together; a server test compares them. `GET /api/credits`
publishes the prices and the margin, and `/generate` and `/account` show them.

Generation: `POST /api/generate/image` (verified account, same-origin JSON)
reserves the price, calls xAI with `XAI_API_KEY`, and settles. The rule: an
account pays for an image when the image comes back, or when xAI does not
answer within 90 seconds (it may have billed). When xAI answers without an
image or cannot be reached, the reservation goes back to the balance, and the
operator carries any cost xAI still bills. The timeout stays under
Cloudflare's 100-second limit for proxied requests. Once the image exists, the
route returns it even if the ledger write fails. The ledger allows one
unresolved reservation per account and deduplicates request keys; a
reservation still open after `STALE_RESERVATION_MINUTES` (a crash, a deploy, a
failed write) is charged when that account next reserves, so a stuck job never
blocks the account. Without `XAI_API_KEY` the route answers 503 and
`/generate` offers only the own-key path.

Buying: `POST /api/credits/checkout` starts a Stripe Checkout Session for one of
`CREDIT_AMOUNTS_USD` (no bonus credit, no subscription, no trial). Stripe calls
`POST /api/credits/stripe-webhook`; the server checks the `Stripe-Signature`
header against `STRIPE_WEBHOOK_SECRET` and adds the credit once per session
(`credit_purchases`, migration `002`), to the account and to the global pool.
Only `checkout.session.completed` and `checkout.session.async_payment_succeeded`
with `payment_status: paid` and this product's metadata add credit; the credit
must equal the amount paid before tax. Without both Stripe secrets, buying is
off and `/account` says so. `STRIPE_AUTOMATIC_TAX=true` lets Stripe Tax add tax.
Refunds and disputes do not take credit back automatically: no refund rule is
decided yet, and a balance cannot go below zero. Handle them by hand in the
database until a rule exists.

## Credit administration

Accounts begin with zero credit. Operators can grant credit without a purchase.
An operator with database access can run, inside the server container (or from
`packages/server` after `pnpm build`) with the runtime connection variables:

```sh
node dist/account-credit.js <verified-user-id> <positive-micro-dollars> <grant-uuid>
node dist/account-credit.js __global__ <positive-micro-dollars> <different-grant-uuid>
```

A grant UUID makes retries idempotent. Reusing it with different parameters fails.
No account query or grant should be run during automated tests against live data.
A manual grant must fund both the user and the global budget; a purchase does
both itself. The global budget caps what all accounts together can spend. The
ledger locks the global budget before account/job changes, reserves atomically,
deduplicates request IDs and scopes every job lookup to its owner. An account
can have only one unresolved reservation. Settling twice cannot spend twice.

## Paid video stays disabled

The video endpoints (`POST /api/video/generations`, `GET
/api/video/generations/:id`) and the raw provider adapter still fail closed:
they answer 503 without reading the upload or the session. Video with AI credit
needs a durable job dispatcher with exactly-once claiming and crash recovery
and owner-scoped polling before it can use the ledger. Do not just restore the
old fetch calls or flip a public feature flag. Video works today through the
local Video Studio with the user's own keys (`docs/video-studio.md`).

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
