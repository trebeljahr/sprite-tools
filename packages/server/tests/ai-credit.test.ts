import { createHmac, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { request as httpRequest, createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { getMigrations } from "better-auth/db/migration";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  XAI_IMAGE_MODELS,
  IMAGE_PRICING_DATE as CLIENT_PRICING_DATE,
} from "../../../src/lib/ai-image";
import { IMAGE_MODELS, IMAGE_PRICING_DATE } from "../src/image-generation";
import { MIGRATIONS } from "../src/migrate";
import { testDatabase } from "./helpers/account-database";

// AI credit end to end through Express: buy credit with a signed Stripe
// webhook, then generate a sprite paid from it. Stripe and xAI are stubbed;
// no real key or payment is involved.
const fixture = testDatabase();
vi.mock("../src/db", () => ({ getDatabase: () => fixture.pool, closeDatabase: async () => {} }));

const ORIGIN = "https://sprites.example.test";
const WEBHOOK_SECRET = "whsec_test_only_not_a_real_secret";
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

let server: Server;
let port: number;
let cookie = "";
let userId = "";
let xaiReply: () => Promise<Response>;
const stripeCalls: URLSearchParams[] = [];
const xaiCalls: Array<{ headers: Headers; body: unknown }> = [];

type Reply = { status: number; cookies: string[]; json: Record<string, unknown> | null };

function call(
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: unknown,
  raw?: string,
) {
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
    if (raw !== undefined) {
      req.setHeader("content-type", "application/json");
      req.end(raw);
    } else if (body !== undefined) {
      req.setHeader("content-type", "application/json");
      req.end(JSON.stringify(body));
    } else req.end();
  });
}

function stripeEvent(
  session: Record<string, unknown>,
  type = "checkout.session.completed",
  secret = WEBHOOK_SECRET,
) {
  const payload = JSON.stringify({ id: `evt_${randomUUID()}`, type, data: { object: session } });
  const t = Math.floor(Date.now() / 1000);
  const v1 = createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex");
  return { payload, signature: `t=${t},v1=${v1}` };
}

function paidSession(id: string, owner = userId, dollars = 5) {
  return {
    id,
    payment_status: "paid",
    amount_subtotal: dollars * 100,
    metadata: {
      purpose: "sprite-tools-ai-credit",
      owner_id: owner,
      credit_micros: String(dollars * 1_000_000),
    },
  };
}

async function balance() {
  return (await call("GET", "/api/account", { cookie })).json?.balanceUsd;
}

beforeAll(async () => {
  vi.stubEnv("BETTER_AUTH_SECRET", "test-only-secret-not-a-real-credential-1234567890");
  vi.stubEnv("BETTER_AUTH_URL", ORIGIN);
  vi.stubEnv("LISTMONK_URL", "https://mail.example.test");
  vi.stubEnv("LISTMONK_API_USER", "fake-user");
  vi.stubEnv("LISTMONK_API_TOKEN", "fake-token");
  vi.stubEnv("LISTMONK_TX_TEMPLATE_ID", "1");
  vi.stubEnv("LISTMONK_FROM_EMAIL", "accounts@example.test");
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_fake_not_a_real_key");
  vi.stubEnv("STRIPE_WEBHOOK_SECRET", WEBHOOK_SECRET);
  vi.stubEnv("XAI_API_KEY", "xai-test-fake-server-key");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url === "https://api.stripe.com/v1/checkout/sessions") {
        stripeCalls.push(new URLSearchParams(String(init?.body)));
        return Response.json({
          id: "cs_test_1",
          url: "https://checkout.stripe.com/c/pay/cs_test_1",
        });
      }
      if (url === "https://api.x.ai/v1/images/generations") {
        xaiCalls.push({
          headers: new Headers(init?.headers),
          body: JSON.parse(String(init?.body)),
        });
        return xaiReply();
      }
      return new Response("", { status: 200 });
    }),
  );
  const migration = await getMigrations({
    database: fixture.pool,
    rateLimit: { storage: "database" },
    logger: { disabled: true },
  });
  await migration.runMigrations();
  for (const file of MIGRATIONS)
    await fixture.database.exec(
      await readFile(new URL(`../db/migrations/${file}`, import.meta.url), "utf8"),
    );
  const { createApp } = await import("../src/app");
  server = createServer(createApp());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;

  const credentials = { email: "credit@example.test", password: "test-only-password-12345" };
  expect(
    (await call("POST", "/api/auth/sign-up/email", {}, { name: "C", ...credentials })).status,
  ).toBe(200);
  await fixture.pool.query('UPDATE "user" SET "emailVerified"=true WHERE email=$1', [
    credentials.email,
  ]);
  const signin = await call("POST", "/api/auth/sign-in/email", {}, credentials);
  cookie = signin.cookies
    .find((c) => c.startsWith("__Secure-better-auth.session_token="))!
    .split(";")[0];
  userId = (await fixture.pool.query('SELECT id FROM "user" WHERE email=$1', [credentials.email]))
    .rows[0].id as string;
}, 30000);

beforeEach(() => {
  xaiReply = async () => Response.json({ data: [{ b64_json: PNG }] });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await fixture.database.close();
});

describe("prices", () => {
  it("states the list price, the margin and the price per image", async () => {
    const info = await call("GET", "/api/credits");
    expect(info.json).toEqual({
      generation: true,
      purchase: true,
      marginPercent: 30,
      pricingDate: IMAGE_PRICING_DATE,
      amountsUsd: [5, 10, 20],
      models: [
        { id: "grok-imagine-image", label: "Grok Imagine", costUsd: 0.02, priceUsd: 0.026 },
        { id: "grok-imagine-image-2.0", label: "Grok Imagine 2.0", costUsd: 0.04, priceUsd: 0.052 },
      ],
    });
  });

  it("matches the prices the browser shows for the own-key path", () => {
    expect(XAI_IMAGE_MODELS).toEqual(IMAGE_MODELS);
    expect(CLIENT_PRICING_DATE).toBe(IMAGE_PRICING_DATE);
  });
});

describe("buying credit", () => {
  it("starts a plain Stripe Checkout for a listed amount only", async () => {
    expect((await call("POST", "/api/credits/checkout", { cookie }, { amountUsd: 7 })).status).toBe(
      400,
    );
    expect(
      (
        await call(
          "POST",
          "/api/credits/checkout",
          { cookie, origin: "https://foreign.example.test" },
          { amountUsd: 5 },
        )
      ).status,
    ).toBe(403);
    expect((await call("POST", "/api/credits/checkout", {}, { amountUsd: 5 })).status).toBe(401);

    const started = await call("POST", "/api/credits/checkout", { cookie }, { amountUsd: 5 });
    expect(started.json).toEqual({ url: "https://checkout.stripe.com/c/pay/cs_test_1" });
    const form = stripeCalls.at(-1)!;
    expect(form.get("mode")).toBe("payment");
    expect(form.get("line_items[0][price_data][unit_amount]")).toBe("500");
    expect(form.get("metadata[owner_id]")).toBe(userId);
    expect(form.get("metadata[project]")).toBe("sprite-tools");
    expect(form.get("metadata[credit_micros]")).toBe("5000000");
    expect(form.get("success_url")).toBe(`${ORIGIN}/account?purchase=done`);
    expect(form.has("subscription_data[trial_period_days]")).toBe(false);
  });

  it("adds credit once per paid session, and only for a valid signature", async () => {
    expect(await balance()).toBe(0);
    const forged = stripeEvent(
      paidSession("cs_test_forged"),
      "checkout.session.completed",
      "whsec_someone_elses_secret",
    );
    expect(
      (
        await call(
          "POST",
          "/api/credits/stripe-webhook",
          { "stripe-signature": forged.signature },
          undefined,
          forged.payload,
        )
      ).status,
    ).toBe(400);

    const unpaid = stripeEvent({ ...paidSession("cs_test_unpaid"), payment_status: "unpaid" });
    expect(
      (
        await call(
          "POST",
          "/api/credits/stripe-webhook",
          { "stripe-signature": unpaid.signature },
          undefined,
          unpaid.payload,
        )
      ).status,
    ).toBe(200);
    expect(await balance()).toBe(0);

    const paid = stripeEvent(paidSession("cs_test_1"));
    for (let i = 0; i < 2; i++)
      expect(
        (
          await call(
            "POST",
            "/api/credits/stripe-webhook",
            { "stripe-signature": paid.signature },
            undefined,
            paid.payload,
          )
        ).status,
      ).toBe(200);
    expect(await balance()).toBe(5);
  });
});

describe("generating with credit", () => {
  it("generates a sprite and takes the stated price", async () => {
    const result = await call(
      "POST",
      "/api/generate/image",
      { cookie },
      { model: "grok-imagine-image", prompt: "a knight", requestKey: randomUUID() },
    );
    expect(result.status).toBe(200);
    expect(result.json).toEqual({
      image: `data:image/png;base64,${PNG}`,
      priceUsd: 0.026,
      balanceUsd: 4.974,
    });
    const sent = xaiCalls.at(-1)!;
    expect(sent.headers.get("authorization")).toBe("Bearer xai-test-fake-server-key");
    expect(sent.body).toEqual({
      model: "grok-imagine-image",
      prompt: "a knight",
      n: 1,
      response_format: "b64_json",
    });
  });

  it("gives the price back when xAI refuses the request", async () => {
    xaiReply = async () => Response.json({ error: "prompt rejected" }, { status: 400 });
    const result = await call(
      "POST",
      "/api/generate/image",
      { cookie },
      { model: "grok-imagine-image", prompt: "a knight", requestKey: randomUUID() },
    );
    expect(result.status).toBe(502);
    expect(String(result.json?.error)).toContain("Your credit was not charged.");
    expect(await balance()).toBe(4.974);
  });

  it("keeps the price when xAI never answers, since it may have billed", async () => {
    xaiReply = async () => {
      throw new TypeError("network down");
    };
    const result = await call(
      "POST",
      "/api/generate/image",
      { cookie },
      { model: "grok-imagine-image", prompt: "a knight", requestKey: randomUUID() },
    );
    expect(result.status).toBe(504);
    expect(await balance()).toBe(4.948);
  });

  it("gives the price back when xAI cannot be reached or sends no image", async () => {
    xaiReply = async () => {
      throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
    };
    const generate = () =>
      call(
        "POST",
        "/api/generate/image",
        { cookie },
        { model: "grok-imagine-image", prompt: "a knight", requestKey: randomUUID() },
      );
    expect((await generate()).status).toBe(502);
    xaiReply = async () => Response.json({ data: [] });
    expect((await generate()).status).toBe(502);
    expect(await balance()).toBe(4.948);
  });

  it("charges a stranded reservation once and does not block the account", async () => {
    for (const owner of ["__global__", userId])
      await fixture.pool.query(
        "UPDATE video_budgets SET available=available-26000,reserved=reserved+26000 WHERE owner_id=$1",
        [owner],
      );
    await fixture.pool.query(
      "INSERT INTO video_jobs(id,owner_id,request_key,cost,created_at) VALUES($1,$2,$3,26000,now() - interval '20 minutes')",
      [randomUUID(), userId, randomUUID()],
    );
    const result = await call(
      "POST",
      "/api/generate/image",
      { cookie },
      { model: "grok-imagine-image", prompt: "a knight", requestKey: randomUUID() },
    );
    expect(result.status).toBe(200);
    const summary = (await call("GET", "/api/account", { cookie })).json;
    expect(summary?.balanceUsd).toBe(4.896);
    expect(summary?.reservedUsd).toBe(0);
  });

  it("answers 400, not 500, to a malformed body", async () => {
    expect((await call("POST", "/api/generate/image", { cookie }, undefined, "{")).status).toBe(
      400,
    );
  });

  it("refuses without an account, without enough credit, and on a replayed request", async () => {
    const body = { model: "grok-imagine-image", prompt: "a knight", requestKey: randomUUID() };
    expect((await call("POST", "/api/generate/image", {}, body)).status).toBe(401);
    expect((await call("POST", "/api/generate/image", { cookie }, body)).status).toBe(200);
    expect((await call("POST", "/api/generate/image", { cookie }, body)).status).toBe(409);

    await fixture.pool.query("UPDATE video_budgets SET available=1000 WHERE owner_id=$1", [userId]);
    const poor = await call(
      "POST",
      "/api/generate/image",
      { cookie },
      { model: "grok-imagine-image", prompt: "a knight", requestKey: randomUUID() },
    );
    expect(poor.status).toBe(402);
    expect(await balance()).toBe(0.001);
  });
});
