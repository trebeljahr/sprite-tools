import type { PublicJob } from "./video/schema";

export interface CreditUsage {
  balanceMicros: number;
  reservedMicros: number;
  spentMicros: number;
  total: number;
  unknownCount: number;
  page: number;
  models: { model: string | null; provider: string | null; count: number; chargedMicros: number }[];
  jobs: {
    id: string;
    model: string | null;
    provider: string | null;
    status: string;
    billingStatus: "charged" | "refunded" | null;
    costMicros: number;
    createdAt: string;
  }[];
}

/** Sum integer micro-dollars, so repeated small reservations never accumulate float drift. */
export function localUsage(jobs: PublicJob[]) {
  const groups = new Map<
    string,
    { model: string; provider: string; count: number; micros: number }
  >();
  let completedMicros = 0,
    failedMicros = 0,
    activeMicros = 0;
  for (const job of jobs) {
    const value = Math.round(job.reservedUsd * 1_000_000);
    if (job.status === "done") completedMicros += value;
    else if (job.status === "failed") failedMicros += value;
    else activeMicros += value;
    const model = job.generationInfo?.model ?? (value ? "Unknown model" : "Local import");
    const provider = job.generationInfo?.provider ?? (value ? "unknown" : "local");
    const key = `${provider}:${model}`;
    const group = groups.get(key) ?? { model, provider, count: 0, micros: 0 };
    group.count++;
    group.micros += value;
    groups.set(key, group);
  }
  return {
    completedMicros,
    failedMicros,
    activeMicros,
    models: [...groups.values()].sort((a, b) => b.micros - a.micros),
  };
}

export function usageMoney(micros: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  }).format(micros / 1_000_000);
}

export function creditOutcome(job: CreditUsage["jobs"][number]): string {
  if (job.billingStatus === "refunded") return "Returned";
  if (job.billingStatus === "charged")
    return job.status === "failed" ? "Charged · uncertain result" : "Charged";
  return job.status === "failed" ? "Historical outcome unknown" : "Reserved";
}
