# Sprite Tools security remediation — 2026-09-30

## Verified findings and corrections

- F02: the handler constructed a fetch URL from a caller-provided DSN, followed redirects, read an unlimited body, and had no timeout or request budget. These are real unsafe code paths. However, the report's assertion that this file is public is incorrect for the checked-in Next App Router layout: `_e` is a private directory. Next's installed project-structure guide explicitly excludes underscore directories from routing. The secured handler moves to `%5Fe`, preserving the browser SDK's intended `/_e` URL. The existing primary checkout build manifest also has no tunnel entry. No internal services were probed.
- F08: existing `.dockerignore` already excluded root dotenv keys. It did not exclude nested secrets, Git metadata, or local build/tool state. Added those exclusions. The tracked `.env.production` has two assignments: the dotenv public key and an encrypted value; no plaintext private value was found. The encrypted production blob stays in the image to preserve the existing deployment flow. Private dotenv key permissions belong to the machine-exposure remediation chat.
- F11: final Docker stage had no USER directive. It now runs as node (1000:1000), listens on 8080, and only the Next cache directory is writable by that user. Compose drops capabilities and sets no-new-privileges. Health checks and exposed port are aligned.
- F13: Next 16.2.1 was a devDependency even though the deployed app uses `next start`. Next, React, React DOM, dotenvx, and the Next MDX config dependency are now production dependencies. Next/MDX are 16.3.7; SDK and transitive packages are refreshed, with scoped overrides for remaining patched transitive versions.

## Advisory conditions

Current registry audit and upstream advisories were checked on 2026-09-30:

- https://github.com/advisories/GHSA-p293-qw3h-jr36: Windows-hosted server RCE does not apply to this Linux image. The package version was nevertheless in the affected range before upgrading.
- https://github.com/advisories/GHSA-2xp9-vwfh-vxw4: AVIF optimization vulnerability affects Next <16.3.3 in this major. No application imports of next/image were found, but the default server optimizer remains relevant. Upgrade removes the affected version.
- Audit counts are package findings, not proof of reachable application exploits. Final all-dependency registry audit reports zero advisories (750 total dependency entries). All dependencies are audited because the Docker runtime still copies the complete node_modules tree.

## Tunnel behavior

The deployment-controlled NEXT_PUBLIC_GLITCHTIP_DSN is the only destination source and stays consistent with the browser SDK's build-time value. Incoming DSNs must match the configured HTTPS origin, public key, and numeric project exactly; passwords, nondefault ports, query strings and fragments are rejected. Missing/invalid config disables forwarding with 503.

Request bodies are limited to 256 KiB, envelope headers to 8 KiB, and upload plus upstream fetch to five seconds. Redirects fail. Upstream bodies are canceled rather than reflected; status, Retry-After, and X-Sentry-Rate-Limits preserve SDK backoff. Cross-origin browser submissions and compressed bodies are rejected. A per-process limit permits 120 requests/minute and eight simultaneous uploads/fetches, without trusting spoofable forwarded IP headers. This limits resource use but is not authentication: the public telemetry key is intentionally public.

## Related surface

`src/app/actions.ts` calls the fixed xAI API host through `src/lib/xai.ts`; it is not an arbitrary-host proxy. It does expose generation and polling without user authentication, ownership checks, or per-user budgets when XAI_API_KEY is configured. This needs an authenticated/entitled product flow before enabling a paid server credential on a public deployment. No provider calls or credentials were used in review. These actions and the editor were not redesigned in this patch.

## Validation

Passed: frozen-lockfile install with repository-pinned pnpm 10.33.2 (lifecycle scripts disabled), full dependency registry audit (zero advisories), focused Biome check, and git diff --check.

Added mocked-network cases for internal/metadata/loopback hosts, alternate numeric hosts, mismatched keys/projects, malformed DSNs, redirects, valid byte forwarding, upstream backoff headers, streaming body limits, upload/fetch deadlines, cross-origin requests, and global rate/concurrency limits.

Not run: regression tests, full existing suite, typecheck, production build, container build, and local main integration. Machine load reached 285 on ten CPUs; final pressure check still showed load above 100 and 14.8 GB swap in use on a 24 GB machine. The shared heavy-check lock was initially owned by another chat. No heavy validation processes were started. The patch is saved on the local security branch and must pass validation before fast-forward integration. No production credentials, keychain, internal services, or provider operations were used.

Resume in /private/tmp/sprite-tools-security. Recheck load/memory; acquire /private/tmp/projects-security-heavy-check.lock with mkdir and record ownership before each serialized suite/typecheck/build. Release only the owned lock in cleanup. Then rebase onto main and fast-forward, preserving the primary checkout’s existing .hatchkit.json, next.config.ts, package.json, pnpm-lock.yaml, .codex, and docs work. The package/lockfile changes overlap, so verify the Hatchkit dev-plugin addition survives integration.

## Rollout (not performed)

- Push/build/deploy only with direct authorization. Local changes do not establish production remediation.
- Verify Coolify targets container port 8080 and honors node UID, dropped capabilities, and no-new-privileges. Check cache write permissions with the actual image.
- Confirm the configured browser DSN works through `/_e` and upstream SDK rate limits survive. No live telemetry events were sent during this work.
- Add trusted-edge rate limits across replicas and egress restrictions to the configured telemetry host. In-process limits reset on restart and apply separately to each replica.
- Resolve paid video authentication/ownership/budgets before supplying a production XAI_API_KEY.
