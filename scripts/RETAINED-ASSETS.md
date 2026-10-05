# Browser assets during rolling releases

During a rolling release the old and new containers serve traffic at the same
time. A tab opened from either release must keep loading its own hashed chunks
(including the chroma worker, which the bundler also hashes) from whichever
container answers. `next start` only knows its own build's files, so these
assets live in a shared named volume instead.

## Required app-owned volume

Mount Docker named volume `sprite-tools-releases` read/write at
`/var/lib/sprite-tools-releases` in every container. The host controller must
verify mount type, exact volume name, destination and write permission.
Initialize it for runtime UID/GID 1000 (`node`) with this `.store-identity.json`:

```json
{"schema":1,"app":"trebeljahr/sprite-tools","volume":"sprite-tools-releases","purpose":"immutable-next-assets"}
```

With `SPRITE_SHARED_ASSETS=1` (set in the image), `drain-entrypoint.sh` refuses
to start without a real writable mount and that marker. Under one exclusive
publication lock it copies this image's `.next/static` snapshot into
`releases/<SHA>`, links every retained hashed file into a shared `_next/static`
union and atomically writes `releases.json`, all before Next starts or the
health check can pass. Same-path files with different bytes fail closed, as
does a store over 256 MiB or 20,000 files. PID 1 keeps a shared kernel lease on
its SHA until the server exits.

Each image publishes itself, so the store needs no build ancestry: a newly
started release becomes the head, a restart inside the window never rewinds
it, and the three newest releases plus every leased (still running) image stay
available. Older unleased files are pruned. Only `version.json` and hashed
browser files enter the store; it holds no application data and needs no
backup. Do not erase it while containers serve from it.

## Routing

`start-accounts.sh` preloads `shared-assets.cjs` before `drain.cjs`. It answers
`/_next/static/…` and `/releases.json` from the volume before Next sees the
request. Missing chunks are real 404s. An RSC request whose `x-deployment-id`
names another release gets 409 before React decodes foreign module references;
Next then loads a full document at the destination.

## Browser state

| State | Where | Survives reload |
| --- | --- | --- |
| Loaded project image | IndexedDB `sprite-tools` / `project` | Yes |
| Cross-tab change ping, tutorial dismissal, consent, donation | localStorage | Yes |
| Tool settings (grid, thresholds, crop, frame selection, export options) | React state | No |
| Spritesheet, lasso, atlas, animate and generate inputs | React state | No |

A full-document navigation after a foreign-release 409 resets page state just
like a reload. Because tool settings are not persisted, `ReleaseNotice` never
reloads a tab by itself: once the tab's release leaves the retained set it
shows a notice with a Reload button and explains that settings reset. Paid
video actions remain disabled on the server.

## Limits

The current live image predates this store. Its tabs lose their chunks once it
retires; the first adoption is a controlled step. `/samples/*.png` are
unversioned public files; change them only with new names. Keep automatic mode
off until a live replacement proves asset sharing, expiry and drain on the
host, including PostgreSQL overlap.
