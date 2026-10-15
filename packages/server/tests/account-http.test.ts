import { request as httpRequest, createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFile } from "node:fs/promises";
import { getMigrations } from "better-auth/db/migration";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { testDatabase } from "./helpers/account-database";

// The whole account flow through Express and Better Auth's Node adapter, the
// way the browser reaches it behind the no-Worker /api/* route.
const fixture = testDatabase();
vi.mock("../src/db", () => ({ getDatabase: () => fixture.pool, closeDatabase: async () => {} }));

const ORIGIN = "https://sprites.example.test";
let server: Server;
let port: number;

type Reply = { status: number; cookies: string[]; json: { user?: { email?: string } } | null };

function call(method: string, path: string, headers: Record<string, string> = {}, body?: unknown) {
  return new Promise<Reply>((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, method, path, headers: { origin: ORIGIN, ...headers } },
      (res) => {
        let text = "";
        res.on("data", (chunk) => {
          text += chunk;
        });
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            cookies: res.headers["set-cookie"] ?? [],
            json: text ? JSON.parse(text) : null,
          }),
        );
      },
    );
    req.on("error", reject);
    if (body !== undefined) {
      req.setHeader("content-type", "application/json");
      req.end(JSON.stringify(body));
    } else req.end();
  });
}

beforeAll(async () => {
  vi.stubEnv("BETTER_AUTH_SECRET", "test-only-secret-not-a-real-credential-1234567890");
  vi.stubEnv("BETTER_AUTH_URL", ORIGIN);
  vi.stubEnv("LISTMONK_URL", "https://mail.example.test");
  vi.stubEnv("LISTMONK_API_USER", "fake-user");
  vi.stubEnv("LISTMONK_API_TOKEN", "fake-token");
  vi.stubEnv("LISTMONK_TX_TEMPLATE_ID", "1");
  vi.stubEnv("LISTMONK_FROM_EMAIL", "accounts@example.test");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("", { status: 200 })),
  );
  const migration = await getMigrations({
    database: fixture.pool,
    rateLimit: { storage: "database" },
    logger: { disabled: true },
  });
  await migration.runMigrations();
  await fixture.database.exec(
    await readFile(new URL("../db/migrations/001-video-budgets.sql", import.meta.url), "utf8"),
  );
  const { createApp } = await import("../src/app");
  server = createServer(createApp());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
}, 30000);

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await fixture.database.close();
});

it("signs up, refuses the unverified account, then signs in to a session and summary", async () => {
  const credentials = { email: "http@example.test", password: "test-only-password-12345" };
  const signup = await call(
    "POST",
    "/api/auth/sign-up/email",
    {},
    { name: "HTTP", ...credentials },
  );
  expect(signup.status).toBe(200);
  expect((await call("POST", "/api/auth/sign-in/email", {}, credentials)).status).toBe(403);
  expect(
    (
      await call(
        "POST",
        "/api/auth/sign-in/email",
        { origin: "https://foreign.example.test" },
        credentials,
      )
    ).status,
  ).toBe(403);

  await fixture.pool.query('UPDATE "user" SET "emailVerified"=true WHERE email=$1', [
    credentials.email,
  ]);
  const signin = await call("POST", "/api/auth/sign-in/email", {}, credentials);
  expect(signin.status).toBe(200);
  const session = signin.cookies.find((cookie) =>
    cookie.startsWith("__Secure-better-auth.session_token="),
  );
  expect(session).toMatch(/; Secure/i);
  expect(session).toMatch(/; HttpOnly/i);
  const cookie = session!.split(";")[0];

  const current = await call("GET", "/api/auth/get-session", { cookie });
  expect(current.json?.user?.email).toBe(credentials.email);
  const summary = await call("GET", "/api/account", { cookie });
  expect(summary.status).toBe(200);
  expect(summary.json).toEqual({
    name: "HTTP",
    credits: 0,
    reserved: 0,
    spent: 0,
    paidVideoEnabled: false,
  });

  expect((await call("POST", "/api/auth/sign-out", { cookie }, {})).status).toBe(200);
  expect((await call("GET", "/api/account", { cookie })).status).toBe(401);
});
