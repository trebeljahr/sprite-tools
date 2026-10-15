import type { AddressInfo } from "node:net";
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ configured: false, schema: false, broken: false }));
vi.mock("../src/auth", () => ({
  getAuth: () => {
    if (!state.configured) throw new Error("Accounts are not configured");
    return {
      handler: async () => {
        if (state.broken) throw new Error("database unavailable");
        return Response.json({ session: null });
      },
    };
  },
  requireAccount: async () => {
    throw new Error("Sign in with a verified account");
  },
}));
vi.mock("../src/db", () => ({
  getDatabase: () => ({ query: async () => ({ rows: [{ ready: state.schema }] }) }),
  closeDatabase: async () => {},
}));

const { createApp } = await import("../src/app");
const { startDraining } = await import("../src/drain");

const SHA = "a".repeat(40);
let server: Server;
let origin: string;
beforeAll(async () => {
  server = createServer(createApp());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
beforeEach(() => {
  state.configured = true;
  state.schema = true;
  vi.stubEnv("COMMIT_SHA", SHA);
});

describe("accounts API", () => {
  it("reports readiness and the build commit, uncached", async () => {
    const health = await fetch(`${origin}/api/health`);
    expect(health.status).toBe(200);
    expect(health.headers.get("cache-control")).toBe("no-store");
    expect(await health.json()).toEqual({ ready: true, version: SHA });
    const accounts = await fetch(`${origin}/api/health/accounts`);
    expect(accounts.status).toBe(200);
    expect(await accounts.json()).toEqual({ ready: true });
  });

  it("fails readiness without configuration or schema", async () => {
    state.schema = false;
    expect((await fetch(`${origin}/api/health/accounts`)).status).toBe(503);
    state.schema = true;
    state.configured = false;
    const health = await fetch(`${origin}/api/health`);
    expect(health.status).toBe(503);
    expect(await health.json()).toEqual({ ready: false, version: SHA });
  });

  it("serves Better Auth under /api/auth and fails closed", async () => {
    const failure = { message: "Accounts are temporarily unavailable" };
    state.configured = false;
    const unconfigured = await fetch(`${origin}/api/auth/get-session`);
    expect(unconfigured.status).toBe(503);
    expect(await unconfigured.json()).toEqual(failure);
    state.configured = true;
    expect((await fetch(`${origin}/api/auth/get-session`)).status).toBe(200);
    state.broken = true;
    const broken = await fetch(`${origin}/api/auth/get-session`);
    expect(broken.status).toBe(503);
    expect(await broken.json()).toEqual(failure);
    state.broken = false;
  });

  it("refuses the account summary without a verified session", async () => {
    const response = await fetch(`${origin}/api/account`);
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("answers only /api routes and keeps the tunnel closed without a DSN", async () => {
    for (const path of ["/", "/account", "/api/nope", "/_e"]) {
      const response = await fetch(`${origin}${path}`);
      expect(response.status).toBe(404);
      expect(response.headers.get("x-powered-by")).toBeNull();
    }
    vi.stubEnv("NEXT_PUBLIC_GLITCHTIP_DSN", undefined);
    const tunnel = await fetch(`${origin}/api/_e`, { method: "POST", body: "{}\n{}" });
    expect(tunnel.status).toBe(503);
  });

  // Last: the drain state is process-wide and never resets.
  it("fails only the loopback health probe while draining", async () => {
    startDraining();
    const probe = await fetch(`${origin}/api/health/accounts`);
    expect(probe.status).toBe(503);
    expect((await fetch(`${origin}/api/auth/get-session`)).status).toBe(200);
  });
});
