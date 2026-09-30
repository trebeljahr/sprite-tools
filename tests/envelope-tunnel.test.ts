import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEnvelopeTunnel as createTunnel } from "../src/lib/envelope-tunnel";

const createEnvelopeTunnel = (getDsn: () => string | undefined) =>
  createTunnel(getDsn, () => "https://sprites.example.com");

const dsn = "https://publickey@errors.example.com/12";
const envelope = (value = dsn) =>
  `${JSON.stringify({ dsn: value })}\n{"type":"event"}\n{"message":"test"}`;
const request = (body: BodyInit = envelope(), headers: HeadersInit = {}) =>
  new Request("https://sprites.example.com/_e", {
    method: "POST",
    body,
    headers,
    duplex: "half",
  } as RequestInit);
let network = vi.fn<typeof fetch>();
beforeEach(() => {
  network = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 200 }));
  vi.stubGlobal("fetch", network);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("trusted envelope tunnel", () => {
  it("forwards valid bytes only to configured destination and preserves SDK backoff", async () => {
    network.mockResolvedValue(
      new Response("not reflected", {
        status: 429,
        headers: {
          "retry-after": "60",
          "x-sentry-rate-limits": "60:error:organization",
          "set-cookie": "bad=1",
        },
      }),
    );
    const body = envelope();
    const response = await createEnvelopeTunnel(() => dsn)(request(body));
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(response.headers.get("x-sentry-rate-limits")).toBe("60:error:organization");
    expect(response.headers.has("set-cookie")).toBe(false);
    expect(await response.text()).toBe("");
    const [url, init] = network.mock.calls[0];
    expect(String(url)).toBe(
      "https://errors.example.com/api/12/envelope/?sentry_key=publickey&sentry_version=7",
    );
    expect(init?.redirect).toBe("error");
    expect(new TextDecoder().decode(init?.body as Uint8Array)).toBe(body);
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    "http://key@127.0.0.1/12",
    "https://key@127.0.0.1/12",
    "https://key@localhost/12",
    "https://key@169.254.169.254/12",
    "https://key@[::1]/12",
    "https://key@10.0.0.1/12",
    "https://key@2130706433/12",
    "https://key@0x7f000001/12",
    "https://key@internal.local/12",
    "https://publickey@evil.example/12",
    "https://wrong@errors.example.com/12",
    "https://publickey@errors.example.com/13",
    "https://publickey:secret@errors.example.com/12",
    "https://publickey@errors.example.com/12?x=1",
    "https://publickey@errors.example.com/12#x",
    "https://publickey@errors.example.com:8443/12",
    "https://publickey@errors.example.com/12/other",
    "https://publickey@errors.example.com/%31%32",
    "file:///etc/passwd",
  ])("rejects attacker DSN %s without network access", async (value) => {
    expect((await createEnvelopeTunnel(() => dsn)(request(envelope(value)))).status).toBe(400);
    expect(network).not.toHaveBeenCalled();
  });

  it.each(["broken", "null\n", "{}\n", '{"dsn":42}\n', "{}"])(
    "rejects malformed header %s",
    async (body) => {
      expect((await createEnvelopeTunnel(() => dsn)(request(body))).status).toBe(400);
      expect(network).not.toHaveBeenCalled();
    },
  );
  it("fails closed without valid deployment config", async () => {
    expect((await createEnvelopeTunnel(() => undefined)(request())).status).toBe(503);
    expect(network).not.toHaveBeenCalled();
  });
  it("rejects redirects, including redirect to internal hosts", async () => {
    network.mockResolvedValue(
      new Response(null, { status: 307, headers: { location: "http://127.0.0.1" } }),
    );
    expect((await createEnvelopeTunnel(() => dsn)(request())).status).toBe(502);
    expect(network).toHaveBeenCalledTimes(1);
    expect(network.mock.calls[0][1]?.redirect).toBe("error");
  });
  it("handles fetch redirect/network errors without leaking details", async () => {
    network.mockRejectedValue(new TypeError("sensitive upstream detail"));
    expect((await createEnvelopeTunnel(() => dsn)(request())).status).toBe(502);
  });
  it("bounds bytes despite absent or misleading content-length", async () => {
    for (const headers of [{}, { "content-length": "1" }] as HeadersInit[]) {
      expect(
        (await createEnvelopeTunnel(() => dsn)(request("x".repeat(262145), headers))).status,
      ).toBe(413);
    }
    expect(network).not.toHaveBeenCalled();
  });
  it("rejects declared oversize and compressed requests before reading", async () => {
    expect(
      (await createEnvelopeTunnel(() => dsn)(request(envelope(), { "content-length": "262145" })))
        .status,
    ).toBe(413);
    expect(
      (await createEnvelopeTunnel(() => dsn)(request(envelope(), { "content-encoding": "gzip" })))
        .status,
    ).toBe(415);
    expect(network).not.toHaveBeenCalled();
  });
  it("rejects cross-origin browser abuse", async () => {
    for (const headers of [
      { origin: "https://evil.example" },
      { "sec-fetch-site": "cross-site" },
    ] as HeadersInit[]) {
      expect((await createEnvelopeTunnel(() => dsn)(request(envelope(), headers))).status).toBe(
        403,
      );
    }
    expect(network).not.toHaveBeenCalled();
  });
  it("uses the configured public origin behind a reverse proxy", async () => {
    const input = new Request("http://localhost:8080/_e", {
      method: "POST",
      body: envelope(),
      headers: { origin: "https://sprites.example.com" },
    });
    expect((await createEnvelopeTunnel(() => dsn)(input)).status).toBe(200);
    expect(network).toHaveBeenCalledOnce();
  });
  it("forwards binary envelope payloads without text conversion", async () => {
    const header = new TextEncoder().encode(`${JSON.stringify({ dsn })}\n`);
    const body = new Uint8Array([...header, 0, 255, 254, 128]);
    expect((await createEnvelopeTunnel(() => dsn)(request(body))).status).toBe(200);
    expect(network.mock.calls[0][1]?.body).toEqual(body);
  });
  it("cancels stalled request streams on deadline", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const pending = createEnvelopeTunnel(() => dsn)(request(new ReadableStream({ cancel })));
    await vi.advanceTimersByTimeAsync(5001);
    expect((await pending).status).toBe(408);
    expect(cancel).toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
  });
  it("cancels streams when the caller already disconnected", async () => {
    const cancel = vi.fn();
    const controller = new AbortController();
    controller.abort();
    const input = new Request(request(new ReadableStream({ cancel })), {
      signal: controller.signal,
    });
    expect((await createEnvelopeTunnel(() => dsn)(input)).status).toBe(408);
    // Request cloning forwards stream cancellation asynchronously.
    await vi.waitFor(() => expect(cancel).toHaveBeenCalled());
    expect(network).not.toHaveBeenCalled();
  });
  it("aborts stalled upstream requests on deadline", async () => {
    vi.useFakeTimers();
    network.mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const pending = createEnvelopeTunnel(() => dsn)(request());
    await vi.advanceTimersByTimeAsync(5001);
    expect((await pending).status).toBe(504);
  });
  it("caps global request rate independent of spoofed client IP", async () => {
    const tunnel = createEnvelopeTunnel(() => dsn);
    for (let i = 0; i < 120; i++) expect((await tunnel(request())).status).toBe(200);
    const response = await tunnel(request(envelope(), { "x-forwarded-for": "1.2.3.4" }));
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(network).toHaveBeenCalledTimes(120);
  });
  it("caps concurrent uploads", async () => {
    vi.useFakeTimers();
    const tunnel = createEnvelopeTunnel(() => dsn);
    const pending = Array.from({ length: 8 }, () => tunnel(request(new ReadableStream())));
    expect((await tunnel(request())).status).toBe(429);
    await vi.advanceTimersByTimeAsync(5001);
    await Promise.all(pending);
    expect((await tunnel(request())).status).toBe(200);
  });
});
