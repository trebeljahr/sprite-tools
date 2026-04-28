// GlitchTip / Sentry envelope tunnel. The Sentry SDK is configured with
// `tunnel: "/_e"` which makes it POST envelopes to this same-origin
// route instead of directly to the ingestion server. That hides the
// reporting endpoint from ad blockers (uBlock and Brave default-block
// `*.glitchtip.*` and `*.sentry.io` paths) at the cost of a single
// extra hop.
//
// Path naming: `/_e` follows Next's `_next` / Vercel's `_vercel`
// "infrastructure" prefix so framework routes can't collide. Don't
// rename to `/sentry`, `/bugs`, or `/e` — all three are blocked or
// ambiguous in real-world deployments.

import { NextResponse } from "next/server";

// Build the upstream URL from the envelope header. The first line of
// the POST body is a JSON object that always contains the `dsn` of the
// project the SDK is reporting to; we re-derive the ingestion URL from
// that so the proxy is configuration-free.
function buildUpstream(envelopeHeader: string): URL {
  const header = JSON.parse(envelopeHeader) as { dsn?: string };
  if (!header.dsn) throw new Error("envelope header missing dsn");
  const dsn = new URL(header.dsn);
  const projectId = dsn.pathname.replace(/^\//, "");
  const publicKey = dsn.username;
  if (!projectId || !publicKey) {
    throw new Error("malformed dsn — no project id or public key");
  }
  const upstream = new URL(
    `/api/${projectId}/envelope/?sentry_key=${encodeURIComponent(publicKey)}&sentry_version=7`,
    `${dsn.protocol}//${dsn.host}`,
  );
  return upstream;
}

export async function POST(request: Request) {
  let body: string;
  try {
    body = await request.text();
  } catch {
    return new NextResponse("bad body", { status: 400 });
  }

  // The envelope is `\n`-delimited; the first line is always the
  // header object.
  const firstNewline = body.indexOf("\n");
  if (firstNewline < 0) {
    return new NextResponse("bad envelope", { status: 400 });
  }

  let upstream: URL;
  try {
    upstream = buildUpstream(body.slice(0, firstNewline));
  } catch {
    return new NextResponse("bad envelope header", { status: 400 });
  }

  // Forward as-is. We deliberately don't propagate every header — the
  // upstream only needs the body and a content type. Surface the
  // GlitchTip response so the SDK's rate-limit handling still works.
  const upstreamResponse = await fetch(upstream, {
    method: "POST",
    headers: { "content-type": "application/x-sentry-envelope" },
    body,
  });

  return new NextResponse(upstreamResponse.body, {
    status: upstreamResponse.status,
    headers: { "content-type": "application/json" },
  });
}
