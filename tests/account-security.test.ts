import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getMigrations } from "better-auth/db/migration";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { VideoLedger } from "@/lib/server/video-ledger";
import { testDatabase } from "./helpers/account-database";

vi.mock("server-only", () => ({}));
const fixture = testDatabase();
vi.mock("@/lib/server/db", () => ({ getDatabase: () => fixture.pool }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
const ledger = new VideoLedger(fixture.pool);

beforeAll(async () => {
  vi.stubEnv("BETTER_AUTH_SECRET", "test-only-secret-not-a-real-credential-1234567890");
  vi.stubEnv("BETTER_AUTH_URL", "https://accounts.example.test");
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
  for (const id of ["alice", "bob", "carol"]) {
    await fixture.pool.query(
      'INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$1,$2,true,now(),now())',
      [id, `${id}@example.test`],
    );
    await fixture.pool.query("INSERT INTO video_budgets(owner_id,available) VALUES($1,10)", [id]);
  }
  await fixture.pool.query("UPDATE video_budgets SET available=15 WHERE owner_id='__global__'");
}, 30000);

afterAll(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await fixture.database.close();
});

describe("account and credit isolation", () => {
  it("reserves atomically, deduplicates retries, and refuses cross-account reads", async () => {
    const request = randomUUID();
    const results = await Promise.all([
      ledger.reserve("alice", request, 8),
      ledger.reserve("alice", request, 8),
    ]);
    expect(results[0].id).toBe(results[1].id);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    await expect(ledger.ownedJob("bob", results[0].id)).rejects.toThrow("Generation not found");
    await expect(ledger.reserve("alice", request, 9)).rejects.toThrow("Reservation conflict");
    await expect(ledger.reserve("alice", randomUUID(), 1)).rejects.toThrow("already active");
    await expect(ledger.settle("bob", results[0].id, "done")).rejects.toThrow(
      "Generation not found",
    );
    await ledger.settle("alice", results[0].id, "done");
    await ledger.settle("alice", results[0].id, "done");
    const balance = await fixture.pool.query(
      "SELECT available,reserved,spent FROM video_budgets WHERE owner_id='alice'",
    );
    expect(balance.rows[0]).toEqual({ available: 2, reserved: 0, spent: 8 });
  });

  it("cannot overspend the global budget across users", async () => {
    const results = await Promise.allSettled([
      ledger.reserve("bob", randomUUID(), 5),
      ledger.reserve("carol", randomUUID(), 5),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const balance = await fixture.pool.query(
      "SELECT available,reserved FROM video_budgets WHERE owner_id='__global__'",
    );
    expect(balance.rows[0]).toEqual({ available: 2, reserved: 5 });
  });

  it("rolls back global debit when the account has no credit", async () => {
    const result = await fixture.pool.query(
      "SELECT available FROM video_budgets WHERE owner_id='__global__'",
    );
    await expect(ledger.reserve("unfunded", randomUUID(), 1)).rejects.toThrow("Insufficient");
    expect(
      (await fixture.pool.query("SELECT available FROM video_budgets WHERE owner_id='__global__'"))
        .rows,
    ).toEqual(result.rows);
  });

  it("requires verified email and grants no credit at signup", async () => {
    const { getAuth } = await import("@/lib/server/auth");
    const auth = getAuth();
    const signup = await auth.handler(
      new Request("https://accounts.example.test/api/auth/sign-up/email", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "https://accounts.example.test" },
        body: JSON.stringify({
          name: "Test account",
          email: "signup@example.test",
          password: "test-only-password-12345",
        }),
      }),
    );
    expect(signup.status).toBe(200);
    const user = await fixture.pool.query('SELECT id,"emailVerified" FROM "user" WHERE email=$1', [
      "signup@example.test",
    ]);
    expect(user.rows[0].emailVerified).toBe(false);
    expect(
      (await fixture.pool.query("SELECT * FROM video_budgets WHERE owner_id=$1", [user.rows[0].id]))
        .rowCount,
    ).toBe(0);
    const signin = await auth.handler(
      new Request("https://accounts.example.test/api/auth/sign-in/email", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "https://accounts.example.test" },
        body: JSON.stringify({
          email: "signup@example.test",
          password: "test-only-password-12345",
        }),
      }),
    );
    expect(signin.status).toBe(403);
    const forged = await auth.api.getSession({
      headers: new Headers({ cookie: "better-auth.session_token=fake" }),
    });
    expect(forged).toBeNull();
  });
  it("rejects foreign origins and revokes live sessions on password reset", async () => {
    const { getAuth } = await import("@/lib/server/auth");
    const auth = getAuth();
    const request = (path: string, body: unknown, origin = "https://accounts.example.test") =>
      new Request(`https://accounts.example.test/api/auth/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: origin },
        body: JSON.stringify(body),
      });
    const credentials = { email: "signup@example.test", password: "test-only-password-12345" };
    expect(
      (await auth.handler(request("sign-in/email", credentials, "https://foreign.example.test")))
        .status,
    ).toBe(403);
    await fixture.pool.query('UPDATE "user" SET "emailVerified"=true WHERE email=$1', [
      credentials.email,
    ]);
    const signin = await auth.handler(request("sign-in/email", credentials));
    expect(signin.status).toBe(200);
    const cookie = signin.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    const sessionHeaders = new Headers({ cookie });
    expect(await auth.api.getSession({ headers: sessionHeaders })).not.toBeNull();
    await auth.handler(
      request("request-password-reset", { email: credentials.email, redirectTo: "/account" }),
    );
    const emailCall = vi.mocked(fetch).mock.calls.at(-1)!;
    const body = JSON.parse(String(emailCall[1]?.body));
    const resetUrl = String(body.data.body)
      .match(/href="([^"]+)"/)![1]
      .replaceAll("&amp;", "&");
    const token = new URL(resetUrl).pathname.split("/").at(-1)!;
    const reset = await auth.handler(
      request("reset-password", { token, newPassword: "different-test-password-12345" }),
    );
    expect(reset.status).toBe(200);
    expect(
      await auth.api.getSession({ headers: sessionHeaders, query: { disableCookieCache: true } }),
    ).toBeNull();
  });
});
