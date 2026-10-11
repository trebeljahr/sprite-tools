# Rolling image release contract

This controller manages only `amu2xdnabqha4cy3uc9sg501` (Sprite Tools,
`sprites.trebeljahr.com`), source `trebeljahr/sprite-tools` on `main`, image
`ghcr.io/trebeljahr/sprite-tools`. Builds publish full-SHA candidate tags and a
`release-<sha>-<run>-<attempt>` digest artifact. Building does not move
`latest`.

`SPRITE_TOOLS_ROLLOUT_MODE` defaults to unset/off. `manual` permits an explicit
**Build & Release** dispatch with operation `deploy`, `target_sha`,
`image_digest`, and `expected_current_digest`. `automatic` also releases
successful future pushes. Repository/ref guards and a single workflow
concurrency group serialize this controller.

The controller requires the app's generic hook bundle: `COOLIFY_BASE_URL`,
`COOLIFY_RESOURCE_UUID`, `COOLIFY_DEPLOY_REPOSITORY`, `COOLIFY_DEPLOY_BRANCH`,
and `COOLIFY_DEPLOY_SECRET`. Each value must name this fixed app and source
repository; the secret must uniquely select it. It uses the built-in GitHub
package token and never receives a Coolify API token. A bundle issued for the
Compose app that this Image app replaced does not select it.

## App settings

A release changes the image only. These settings stay as they are; verify the
generated/running container, not only the saved values.

- Docker Image app pulling `ghcr.io/trebeljahr/sprite-tools:latest`, port
  `8080`, no host port bindings, container names that permit overlap.
- Custom Docker run option `--cap-drop=ALL`. The image runs as `node`
  (1000:1000) and its build fails if a setuid/setgid program remains, because
  Coolify cannot set `no-new-privileges` on an Image app.
- The only mount is the shared release volume in `RETAINED-ASSETS.md` (exact
  name `sprite-tools-releases`, type volume, destination
  `/var/lib/sprite-tools-releases`, read-write, owned by uid/gid 1000, seeded
  with its identity marker). Images built from this source refuse to start
  without it.
- Loopback HTTP GET `/api/health/accounts`, response 200, interval 2s, timeout
  5s, five retries, 15s start period. This matches the image probe.
- `git_repository` and the bundle's `COOLIFY_DEPLOY_REPOSITORY` are
  `trebeljahr/sprite-tools`, both branch values `main`, watch path
  `.hatchkit/deploy-webhook`, auto-deploy on. Coolify stores a placeholder
  repository on a new Docker Image app; image publication does not repair it.

## Readiness and shared state

`/api/health/accounts` checks the account configuration and required
PostgreSQL schema. The homepage alone cannot detect a broken account database.
The readiness query has a two-second deadline. PostgreSQL is shared external
state: both containers of a rolling release use the same database, and a release
never creates or replaces it. Keep the existing authentication secret, account
origin and email configuration.

The PID 1 wrapper delivers SIGTERM directly to the Node server, avoiding the
intermediate dotenvx process's shorter forced-exit deadline. The server fails
only loopback readiness probes, drains for 20 seconds, and then closes accepted
HTTP work. Docker's effective stop timeout must be at least 30 seconds.

Account migrations use a PostgreSQL advisory lock. Review their compatibility
with both concurrently running versions before setting `ACCOUNTS_MIGRATE_ON_START`;
an advisory lock prevents simultaneous migration execution, not destructive
schema incompatibility. With `automatic` on, a push that needs an incompatible
schema change deploys like any other, so land such a change in compatible
steps. Paid video server actions remain disabled. Re-enabling those actions
requires separate authentication, durable job/budget and cross-build Server
Action compatibility checks.

Next's deployment ID detects navigation skew but does not make an old image serve
new assets. The shared release volume does: every container serves every
retained release's hashed files, and a foreign-release RSC request gets 409
before decoding. Expired tabs are never reloaded automatically, because tool
settings live only in page state. The release verifier does not exercise mixed
routing or a browser-held edit across a replacement.

## Activation

Align `latest` with the digest the app serves, then configure the app to pull
`latest`. Enable `manual` and deploy a distinct reviewed candidate through the
controller. This initializes the journal; an already-serving no-op deliberately
does not. Enable `automatic` only after this replacement is proven, including
operator inspection of the exact provider deployment. Confirm no active
deployment or other mutable-tag writer before activation.

## Verification and recovery

Before promotion, the controller hashes the target manifest bytes and config,
checks Linux amd64 and the full OCI revision, matches the full-SHA tag to the
reviewed digest, and verifies the public baseline against current `latest`. It
copies the reviewed manifest bytes to `latest`, reads back the digest, and sends
one signed hook. A read-back that still shows the previous manifest is repeated
for four seconds, because a registry read can lag its write. Queue acceptance
must identify this app and one deployment UUID.

Public verification requires uncached `/version.json`, the homepage
`build-commit` metadata and `/api/health/accounts` to agree on the full commit
with accounts ready for 16 consecutive samples over at least 30s. This is HTTP
evidence; `http-verified` is not a claim that the provider job finished or that
old containers retired. Read-only operation `verify` performs only the public
checks.

`rolling-started` and `rolling-verified` must both agree with current `latest`
before another run can mutate anything. A crash, unknown hook outcome, external
tag writer, or failed public check leaves the journal closed. The rollout
artifact records previous digest and returned deployment UUID. After any hook
attempt, failure never triggers another hook or tag rewrite. Inspect and settle
that exact queue before rollback or journal reconciliation; observing old HTML
does not prove a queued job stopped. Pre-hook failures may restore the previous
tag while keeping the journal closed.

To roll back, deploy the previous commit's reviewed digest through the
controller. If the controller cannot run, pin that digest in the app's tag field
(`sha256-<64 hex characters>` in Coolify 4.0.0-beta.469) and reconcile the
journal tags afterwards.

Local checks: `node --test scripts/release.test.mjs scripts/rolling-release.test.mjs scripts/shared-asset-releases.test.mjs`,
`pnpm typecheck`, `pnpm build`, and `actionlint .github/workflows/deploy.yml`.
The controller tests cover fixed scope, digest/revision disagreement,
architecture, baseline drift, latched failures, ambiguous hooks, account
readiness, and authenticated registry redirect limits. They do not replace a
live release.
