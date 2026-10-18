# Local Video Studio

The static Web app and stdio MCP server share one loopback companion. The hosted accounts API retains its disabled paid-video endpoints.

## Runtime boundaries

- `schema.ts` defines the provider model allowlist, validated request shapes, capability rules, pricing date, and extraction options. Browser and Node callers use the same rules.
- `providers.ts` owns provider HTTP requests and bounded downloads. Keys are sent in authorization headers to fixed provider API hosts.
- `vault.ts` stores provider keys under authenticated AES-256-GCM encryption. Scrypt derives a key from the user's passphrase. The passphrase is not stored.
- `service.ts` serializes state changes, reserves estimated costs before submission, persists job state, polls known operations, and invokes extraction.
- `http.ts` binds only to loopback, authenticates API calls with a local capability, and serves setup plus the static Web build.
- `process.ts` decodes local media with FFmpeg, invokes the existing chroma and collision core, and writes uniform sheet cells and engine-compatible metadata. Full-alpha bounding hitboxes cover detached parts; the existing silhouette tracer returns one connected outline per frame. Review generated shapes before using them for gameplay.
- `mcp/video-tools.ts` reads the private companion connection file. It never accepts provider credentials as tool arguments.

Default state is `~/.config/sprite-tools/video`. Override it with `SPRITE_TOOLS_VIDEO_HOME` or the companion's `--state-dir`. The MCP process must use the same location.

The directory is private, and credential/state files use mode 0600. The connection capability authorizes local paid requests within the configured budget. Protect it like a local session cookie. The setup URL carries it in a fragment, which is removed after pairing. Provider keys never appear in that URL.

## Budget and recovery

A zero budget disables generation. The total limit covers all jobs in this state directory. The per-job limit rejects costly settings before dispatch. Prices are bundled estimates; they do not reconcile invoices, include arbitrary external usage, or replace provider restrictions.

A stable request UUID identifies one immutable generation request. A duplicate with changed input fails. The service reserves before sending a provider POST. Ambiguous dispatch keeps the reservation and does not retry the POST.

An unresolved submission can be closed in the local video workspace while retaining its full reservation. A stale process lock fails closed; inspect it before recovery. A known provider operation can be polled after restart and vault unlock. Video processing runs from saved local bytes. Reprocessing changes the sheet and metadata without another provider request.

No generation credentials are accepted by the existing hosted accounts server. No change to its disabled paid routes is required.

## Loop extraction

Generation and extraction are separate decisions. Reuse a saved video to change the extraction window or frame budget without another provider request.

`startSeconds` and `endSeconds` trim the source. `loopMode: "auto"` proposes a contiguous moving cycle between `loopMinSeconds` and `loopMaxSeconds`. Endpoint and following-frame similarity rank candidates; this is a suggestion, not proof of a seamless loop. Inspect the animated preview.

`maxFrames` limits exported drawings while preserving the selected interval duration. Optional `dedupeThreshold` merges adjacent similar drawings and adds their holds. It never applies global duplicate removal across returning poses. Metadata records source indices, selected times, frame durations, and the suggested seam score.

The Web workspace can also open the original saved video in the existing Sheet Builder through an authenticated local job handoff. Its manual frame selection and duplicate controls remain available.

## Provider setup

Use a dedicated provider key with the narrowest supported video model and endpoint access. Enter it directly in the local setup screen.

Google's AI Studio project spend cap can take time to enforce. Do not describe it as an instantaneous hard limit. xAI's billing settings apply to a team; a postpaid limit does not cap existing prepaid credits. Inspect the selected project/team before changing any account-wide setting. Disable automatic top-ups for a bounded test.

Official references, checked 2026-10-18:

- [Google Veo controls](https://ai.google.dev/gemini-api/docs/veo)
- [Google pricing](https://ai.google.dev/gemini-api/docs/pricing)
- [Google billing caps](https://ai.google.dev/gemini-api/docs/billing)
- [Google key restrictions](https://ai.google.dev/gemini-api/docs/api-key)
- [xAI generation](https://docs.x.ai/developers/model-capabilities/video/generation)
- [xAI pricing](https://docs.x.ai/developers/pricing)
- [xAI billing](https://docs.x.ai/console/billing)

## Local clients

Build `dist/mcp/index.js`, then point a local client's stdio configuration at it. The repository's `plugin.json` and `mcp.json` describe the same server for local plugin loaders. The Web build in `out/` is bundled when packaging the npm module.

Local clients require a running companion. Cloud/browser MCP connections require a separate authenticated hosted service; this implementation does not create a tunnel or publish local files.

## Validation

Run `node --import tsx scripts/verify-video-e2e.ts` after the Web and MCP builds for an offline end-to-end receipt. Add `--preview` to inspect that fake-provider studio in a browser. Tests use fake keys and temporary state. Provider HTTP is injected. Media tests decode a generated local fixture with real FFmpeg and verify transparency, geometry, timing, and metadata normalization. A live-provider smoke test additionally needs provider login, restricted keys, and an explicit spending ceiling. Mock success does not certify live model access or actual provider billing.

## Reviewing and reusing a cut

The browser starts at 12 sampled frames per second. The 8/12/24 FPS presets produce
16/24/48 samples from an untrimmed two-second clip and clear the output frame budget.
They change extraction, not playback speed. Inspect the source motion before reducing
the budget or merging adjacent similar frames; neither operation invents in-between poses.

Scrub the saved source video and use **Mark start** / **Mark end** to prepare a manual
trim. **Use suggested cut as manual trim** copies a detected interval into the controls
and disables automatic loop search. Neither action processes immediately. **Apply cut**
reprocesses the saved bytes, without a generation request. The preview and downloads
continue to represent the last applied output while controls are dirty.

The sprite preview supports frame stepping, thumbnail selection, zoom, and speed or
loop-duration adjustment. These timing adjustments affect preview only; downloads retain
the processor's per-frame holds. Sheet Builder has the same preview timing controls and
uses imported Aseprite holds or the completed video import's sampling rate. Changing an
unapplied extraction FPS control no longer changes playback.

Save the processing recipe as JSON after review. Loading a recipe validates it and fills
the controls without starting work. Its object can be supplied directly as `processing`
to `sprite_video_reprocess` alongside the saved job's `job_id`. Recipes contain extraction
and cleanup settings only, with no provider credentials or generation request.
