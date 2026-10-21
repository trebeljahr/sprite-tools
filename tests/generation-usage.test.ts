import { expect, it } from "vitest";
import { creditOutcome, localUsage, usageMoney } from "../src/lib/generation-usage";
import { validateProcessing, type PublicJob } from "../src/lib/video/schema";

it("counts each saved generation once, keeps failure reservations, and separates free imports", () => {
  const job = (
    reservedUsd: number,
    status: PublicJob["status"],
    outputRevision = 1,
  ): PublicJob => ({
    id: String(Math.random()),
    reservedUsd,
    status,
    outputRevision,
    processing: validateProcessing({}),
  });
  const result = localUsage([
    job(0.1, "done", 8),
    job(0.2, "done"),
    job(0.1, "failed"),
    job(0.3, "uncertain"),
    job(0, "done"),
  ]);
  expect(result).toMatchObject({
    completedMicros: 300000,
    failedMicros: 100000,
    activeMicros: 300000,
  });
  expect(result.models).toEqual([
    { model: "Unknown model", provider: "unknown", count: 4, micros: 700000 },
    { model: "Local import", provider: "local", count: 1, micros: 0 },
  ]);
  expect(usageMoney(26000)).toBe("$0.026");
  expect(usageMoney(1)).toBe("$0.000001");
});
it("does not label a historical failure as refunded or charged", () => {
  const job = {
    id: "a",
    model: null,
    provider: null,
    status: "failed",
    billingStatus: null,
    costMicros: 26000,
    createdAt: "2026-10-22",
  } as const;
  expect(creditOutcome(job)).toBe("Historical outcome unknown");
  expect(creditOutcome({ ...job, billingStatus: "refunded" })).toBe("Returned");
  expect(creditOutcome({ ...job, billingStatus: "charged" })).toBe("Charged · uncertain result");
});
