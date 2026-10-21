import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { beforeAll, afterAll, expect, it, vi } from "vitest";
import { testDatabase } from "./helpers/account-database";
import { MIGRATIONS } from "../src/migrate";

const fixture = testDatabase();
let owner: string | null = "alice";
vi.mock("../src/db", () => ({ getDatabase: () => fixture.pool }));
vi.mock("../src/auth", () => ({
  requireAccount: async () => {
    if (!owner) throw Error("No session");
    return { id: owner };
  },
}));
let server: Server;
let origin: string;
beforeAll(async () => {
  await fixture.database.exec(
    "CREATE TABLE \"user\" (id text PRIMARY KEY); INSERT INTO \"user\" VALUES ('alice'),('bob')",
  );
  for (const file of MIGRATIONS)
    await fixture.database.exec(
      await readFile(new URL(`../db/migrations/${file}`, import.meta.url), "utf8"),
    );
  await fixture.database.exec(
    "INSERT INTO video_budgets(owner_id,available,reserved,spent) VALUES('alice',1000000,26000,52000),('bob',9000000,0,999999)",
  );
  for (const [status, billing, cost] of [
    ["done", "charged", 26000],
    ["failed", "charged", 26000],
    ["failed", "refunded", 26000],
    ["failed", null, 26000],
    ["reserved", null, 26000],
  ] as const)
    await fixture.pool.query(
      "INSERT INTO video_jobs(id,owner_id,request_key,cost,status,billing_status,model,provider) VALUES($1,'alice',$2,$3,$4,$5,'image-model','xai')",
      [randomUUID(), randomUUID(), cost, status, billing],
    );
  await fixture.pool.query(
    "INSERT INTO video_jobs(id,owner_id,request_key,cost,status) VALUES($1,'bob',$2,999999,'done')",
    [randomUUID(), randomUUID()],
  );
  const { usage } = await import("../src/routes/usage");
  const app = express();
  app.get("/usage", usage);
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 30000);
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await fixture.database.close();
});
it("isolates accounts, separates charged/refunded/unknown requests, and keeps integer amounts", async () => {
  const response = await fetch(`${origin}/usage`);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const data = await response.json();
  expect(data).toMatchObject({
    balanceMicros: 1000000,
    reservedMicros: 26000,
    spentMicros: 52000,
    total: 5,
    unknownCount: 1,
    models: [{ model: "image-model", count: 5, chargedMicros: 52000 }],
  });
  expect(data.jobs).toHaveLength(5);
  expect(
    data.jobs.filter((job: { billingStatus: string }) => job.billingStatus === "refunded"),
  ).toHaveLength(1);
  expect(JSON.stringify(data)).not.toContain("999999");
});
it("validates pagination and returns an empty later page without losing totals", async () => {
  expect((await fetch(`${origin}/usage?page=-1`)).status).toBe(400);
  expect((await fetch(`${origin}/usage?page=1.2`)).status).toBe(400);
  const data = await (await fetch(`${origin}/usage?page=1`)).json();
  expect(data).toMatchObject({ total: 5, page: 1, jobs: [] });
});
it("requires a session even when another account has usage", async () => {
  owner = null;
  const response = await fetch(`${origin}/usage`);
  expect(response.status).toBe(401);
  expect(response.headers.get("cache-control")).toBe("no-store");
});
