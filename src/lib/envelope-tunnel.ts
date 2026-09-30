// Only deployment configuration selects an upstream. Never derive it from input.
const MAX_BODY = 256 * 1024;
const DEADLINE_MS = 5_000;

function parseDsn(value: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.password ||
    url.port ||
    url.search ||
    url.hash ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(url.username) ||
    !/^\/[1-9][0-9]{0,19}$/.test(url.pathname)
  )
    throw new Error("Invalid DSN");
  return url;
}

async function readBody(request: Request, signal: AbortSignal): Promise<Uint8Array> {
  if (!request.body) throw new Error("Missing body");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) cancel();
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BODY) {
        cancel();
        throw new RangeError("Body too large");
      }
      chunks.push(value);
    }
    const body = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.length;
    }
    return body;
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

// Per-process global budget cannot be bypassed with spoofed forwarding headers.
// Edge rate limiting is still required for a deployment with multiple replicas.
export function createEnvelopeTunnel(getDsn: () => string | undefined) {
  let active = 0;
  let windowStart = 0;
  let accepted = 0;
  return async (request: Request): Promise<Response> => {
    const reply = (status: number, headers?: Record<string, string>) =>
      new Response(null, {
        status,
        headers: { "cache-control": "no-store", ...headers },
      });
    let trusted: URL;
    try {
      trusted = parseDsn(getDsn() ?? "");
    } catch {
      return reply(503);
    }
    const origin = request.headers.get("origin");
    if (
      (origin && origin !== new URL(request.url).origin) ||
      request.headers.get("sec-fetch-site") === "cross-site"
    )
      return reply(403);
    if (request.headers.has("content-encoding")) return reply(415);
    const size = request.headers.get("content-length");
    if (size && (!/^\d+$/.test(size) || Number(size) > MAX_BODY)) return reply(413);
    const now = Date.now();
    if (now - windowStart >= 60_000) {
      windowStart = now;
      accepted = 0;
    }
    if (active >= 8 || accepted >= 120) return reply(429, { "retry-after": "60" });
    accepted++;
    active++;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DEADLINE_MS);
    const abort = () => controller.abort();
    request.signal.addEventListener("abort", abort, { once: true });
    if (request.signal.aborted) controller.abort();
    try {
      let body: Uint8Array;
      try {
        body = await readBody(request, controller.signal);
      } catch (error) {
        return reply(controller.signal.aborted ? 408 : error instanceof RangeError ? 413 : 400);
      }
      const newline = body.indexOf(10);
      if (newline < 1 || newline > 8192) return reply(400);
      try {
        const header = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(body.subarray(0, newline)),
        );
        if (typeof header.dsn !== "string" || parseDsn(header.dsn).href !== trusted.href)
          return reply(400);
      } catch {
        return reply(400);
      }
      const upstream = new URL(`/api${trusted.pathname}/envelope/`, trusted.origin);
      upstream.searchParams.set("sentry_key", trusted.username);
      upstream.searchParams.set("sentry_version", "7");
      const response = await fetch(upstream, {
        method: "POST",
        body: body as BodyInit,
        headers: { "content-type": "application/x-sentry-envelope" },
        redirect: "error",
        signal: controller.signal,
        cache: "no-store",
      });
      // Do not stream an unbounded upstream body back to the browser.
      void response.body?.cancel().catch(() => {});
      if (response.status >= 300 && response.status < 400) return reply(502);
      const headers: Record<string, string> = {};
      for (const name of ["retry-after", "x-sentry-rate-limits"]) {
        const value = response.headers.get(name);
        if (value && value.length <= 4096) headers[name] = value;
      }
      return reply(response.status, headers);
    } catch {
      return reply(controller.signal.aborted ? 504 : 502);
    } finally {
      clearTimeout(timeout);
      controller.abort();
      request.signal.removeEventListener("abort", abort);
      active--;
    }
  };
}
