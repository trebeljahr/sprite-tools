# Rolling release contract

`sprites.trebeljahr.com` has two halves, released together from one commit:

- **Accounts server** (`packages/server`): Coolify Image app
  `amu2xdnabqha4cy3uc9sg501`, image `ghcr.io/trebeljahr/sprite-tools`. It
  serves `/api/*` only.
- **Static client** (the Next export in `out/`): Cloudflare Worker
  `sprite-tools-client`, assets only (`wrangler.jsonc`). It serves every other
  path.

This controller manages only that app and that Worker, source
`trebeljahr/sprite-tools` on `main`. Builds publish a full-SHA server image tag
with a `release-<sha>-<run>-<attempt>` digest artifact, and upload a client
Worker version tagged with the full SHA. Building moves neither `latest` nor
the active Worker version.

`SPRITE_TOOLS_ROLLOUT_MODE` defaults to unset/off. `manual` permits an explicit
**Build & Release** dispatch with operation `deploy`, `target_sha`,
`image_digest`, and `expected_current_digest`. `automatic` also releases
successful future pushes. Repository/ref guards and a single workflow
concurrency group serialize this controller.

The server half requires the app's generic hook bundle: `COOLIFY_BASE_URL`,
`COOLIFY_RESOURCE_UUID`, `COOLIFY_DEPLOY_REPOSITORY`, `COOLIFY_DEPLOY_BRANCH`,
and `COOLIFY_DEPLOY_SECRET`. Each value must name this fixed app and source
repository; the secret must uniquely select it. It uses the built-in GitHub
package token and never receives a Coolify API token. The client half requires
`CLOUDFLARE_API_TOKEN` (a token limited to editing Workers scripts on the
account) and `CLOUDFLARE_ACCOUNT_ID`. That token cannot change routes or zone
settings.

## Hostname routing

One hostname, three Workers routes on the `trebeljahr.com` zone, made once
outside Wrangler (`wrangler.jsonc` has no `routes` key, so deploys leave them
alone):

| Pattern | Worker | Answered by |
| --- | --- | --- |
| `sprites.trebeljahr.com/api/*` | none | Coolify/Traefik, the accounts server |
| `sprites.trebeljahr.com/.well-known/acme-challenge/*` | none | Traefik (HTTP-01 renewals) |
| `sprites.trebeljahr.com/*` | `sprite-tools-client` | the static client |

The most specific pattern wins, so `/api/…` bypasses the Worker. Same origin:
Better Auth's base path `/api/auth`, its cookies and the email links are
unchanged. `/api` with no trailing path is the Worker's 404. Requests for
assets and on the no-Worker routes do not count toward the Workers Free
request limit. The zone (or a redirect rule for this host) must redirect HTTP
to HTTPS, because the Worker answers plain HTTP itself.

## Server app settings

A release changes the image only. These settings stay as they are; verify the
generated/running container, not only the saved values.

- Docker Image app pulling `ghcr.io/trebeljahr/sprite-tools:latest`, port
  `8080`, no host port bindings, container names that permit overlap.
- Custom Docker run option `--cap-drop=ALL`. The image runs as `node`
  (1000:1000) and its build fails if a setuid/setgid program remains, because
  Coolify cannot set `no-new-privileges` on an Image app.
- No mount is needed. The `sprite-tools-releases` volume belonged to the Next
  image that served pages; the server ignores it, and it can be detached once
  no rollback can return to that image.
- Loopback HTTP GET `/api/health/accounts`, response 200, interval 2s, timeout
  5s, five retries, 15s start period. This matches the image probe.
- `git_repository` and the bundle's `COOLIFY_DEPLOY_REPOSITORY` are
  `trebeljahr/sprite-tools`, both branch values `main`, watch path
  `.hatchkit/deploy-webhook`, auto-deploy on. Coolify stores a placeholder
  repository on a new Docker Image app; image publication does not repair it.

## Readiness and shared state

`/api/health/accounts` checks the account configuration and required
PostgreSQL schema; `/api/health` adds the commit the image was built from. The
readiness query has a two-second deadline. PostgreSQL is shared external state:
both containers of a rolling release use the same database, and a release never
creates or replaces it. Keep the existing authentication secret, account origin
and email configuration.

Node is PID 1 and loads the encrypted `.env.production` itself, so SIGTERM
reaches the server directly. The server fails only loopback readiness probes,
drains for 20 seconds, and then closes accepted HTTP work. Docker's effective
stop timeout must be at least 30 seconds.

Account migrations use a PostgreSQL advisory lock. Review their compatibility
with both concurrently running versions before setting `ACCOUNTS_MIGRATE_ON_START`;
an advisory lock prevents simultaneous migration execution, not destructive
schema incompatibility. With `automatic` on, a push that needs an incompatible
schema change deploys like any other, so land such a change in compatible
steps. Paid video endpoints remain disabled and answer 503 without reading the
upload. Re-enabling them requires separate authentication and durable
job/budget checks.

## Browser assets across releases

A Worker version serves only the files uploaded with it. Each client build
therefore downloads, from the live site, the hashed files of the releases the
live `/release-assets.json` lists (`scripts/carry-static.mjs`, two earlier
releases, checked by sha256) and uploads them again with its own. One path never
holds two different contents. `/releases.json` lists the releases carried;
`ReleaseNotice` asks a tab to reload once its release has left that list and
never reloads it by itself, because tool settings live only in page state. A
client navigation that fetches another build's RSC payload sees a different
build id and loads a full document instead.

Uploading first and activating later avoids the seconds-long window in which a
one-step deploy serves new HTML before its new chunks. `_headers` gives hashed
files no long `max-age`, because such a rule would also cache 404s.

## Activation

The client is uploaded by the `client` job and activated by the `deploy` job
only after the server half reached `http-verified`. A failure after that leaves
a new server with the previous client, which is the compatible direction; the
run ends red and says which half is live.

## Verification and recovery

Before promotion, the controller hashes the target manifest bytes and config,
checks Linux amd64 and the full OCI revision, matches the full-SHA tag to the
reviewed digest, and verifies the public baseline against current `latest`. It
copies the reviewed manifest bytes to `latest`, reads back the digest, and sends
one signed hook. A read-back that still shows the previous manifest is repeated
for four seconds, because a registry read can lag its write. Queue acceptance
must identify this app and one deployment UUID.

Server verification requires uncached `/api/health` to report the full commit
with accounts ready for 16 consecutive samples over at least 30s. It waits up to
nine minutes for that: a release needs three to four minutes (image pull, start
period, drain of the old container) before only the new build answers. The
baseline check of an image listed in `LEGACY_NEXT_RELEASES`
(`scripts/verify-release.mjs`), which served pages and `/api` together and has
no `/api/health`, accepts account readiness alone. Client verification then
requires uncached `/version.json` and the homepage `build-commit` metadata to
agree on the full commit for 16 samples. This is HTTP evidence;
`http-verified` is not a claim that the provider job finished or that old
containers retired. Read-only operation `verify` performs only the public
checks of both halves.

`rolling-started` and `rolling-verified` must both agree with current `latest`
before another run can mutate anything. A crash, unknown hook outcome, external
tag writer, or failed public check leaves the journal closed. The rollout
artifact records previous digest and returned deployment UUID. After any hook
attempt, failure never triggers another hook or tag rewrite. Inspect and settle
that exact queue before rollback or journal reconciliation; observing old HTML
does not prove a queued job stopped. Pre-hook failures may restore the previous
tag while keeping the journal closed.

To roll back the server, deploy the previous commit's reviewed digest through
the controller. If the controller cannot run, pin that digest in the app's tag
field (`sha256-<64 hex characters>` in Coolify 4.0.0-beta.469) and reconcile
the journal tags afterwards. To roll back the client, activate an earlier
version: `wrangler versions deploy <version-id>@100%` (or `wrangler rollback`).
A version keeps its own files, so that is complete within seconds.

Returning to the pre-split Next image means both: delete the
`sprites.trebeljahr.com/*` route (Traefik answers every path again within
about ten seconds) and pin that image's digest in the app.

Local checks: `node --test scripts/release.test.mjs scripts/rolling-release.test.mjs`,
`pnpm typecheck`, `pnpm test`, `pnpm build`, and
`actionlint .github/workflows/deploy.yml`. The controller tests cover fixed
scope, digest/revision disagreement, architecture, baseline drift, latched
failures, ambiguous hooks, account readiness, the legacy baseline, and
authenticated registry redirect limits. They do not replace a live release.
