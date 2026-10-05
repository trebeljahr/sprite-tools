# Rolling release readiness

The candidate image serves its full source commit at `/version.json` and in the
homepage `build-commit` metadata. The same commit is Next's deployment ID.
The workflow publishes only a SHA-tagged candidate and its exact image digest;
it does not move `latest` or deploy. This keeps the legacy Compose app serving
until its storage, credentials and replacement resource have been reviewed.

Use `/api/health/accounts` for readiness. It checks the account configuration and
required PostgreSQL schema. The homepage alone cannot detect a broken account
database. Match the image probe: GET, interval 2s, timeout 5s, five retries, 15s start
period. The readiness query has a two-second query deadline. PostgreSQL is shared
external state; do not create a fresh empty database during application cutover.
Keep the existing authentication secret, account origin and email configuration.

The PID 1 wrapper delivers SIGTERM directly to the Node server, avoiding the
intermediate dotenvx process's shorter forced-exit deadline. The server fails
only loopback readiness probes, drains for 20 seconds, and then closes accepted
HTTP work. The platform must allow 30 seconds and use unique container names with
no host port bindings. Confirm actual stop behavior and public routing during
live rollout. First adoption cannot retroactively add draining to the old image.

Account migrations use a PostgreSQL advisory lock. Review their compatibility
with both concurrently running versions before setting `ACCOUNTS_MIGRATE_ON_START`;
an advisory lock prevents simultaneous migration execution, not destructive
schema incompatibility. Paid video server actions remain disabled. Re-enabling
those actions requires separate authentication, durable job/budget and cross-build
Server Action compatibility checks; this deployment change does not enable them.

Next's deployment ID detects navigation skew but does not make an old image serve
new assets. The shared release volume in `RETAINED-ASSETS.md` does: every
container serves every retained release's hashed files, and a foreign-release RSC
request gets 409 before decoding. The volume is the only allowed mount (exact name
`sprite-tools-releases`, type volume, destination `/var/lib/sprite-tools-releases`,
read-write, owned by uid/gid 1000, seeded with its identity marker); images built
from this source refuse to start without it. Expired tabs are never reloaded
automatically, because tool settings live only in page state. Live mixed routing
and a browser-held edit across a real replacement are still open gates, not claims
implied by the release verifier.

Before live migration, record the actual legacy image digest and pin the legacy
Compose source to it for rollback. Confirm PostgreSQL persistence and a fresh
restore-tested backup. Then verify the exact replacement image, readiness,
authenticated account continuity, a browser-held sprite/edit state, old-container
retirement and uninterrupted public HTTP in a second compatible release.

Local checks: `node --test scripts/release.test.mjs scripts/shared-asset-releases.test.mjs`, `pnpm typecheck`, `pnpm build`,
and `actionlint .github/workflows/deploy.yml`. The release verifier requires 16
consecutive matching version/HTML/account-readiness samples. It verifies public
postconditions; it does not certify container retirement or deployment continuity.
