import type { PublicJob } from "./video/schema";

/** Each entry is a request or an aggregated day/model/provider/result slice. */
export interface UsageActivity {
  day: string | null;
  provider: string;
  model: string;
  status: string;
  requests: number;
  completed: number;
  costMicros: number;
  unknownCosts: number;
}
export type UsageGroup = "day" | "week" | "month" | "provider" | "model";
export type UsageMetric = "cost" | "completed" | "requests";
export interface UsageFilter {
  from: string;
  to: string;
  provider: string;
  model: string;
  status: string;
}
export const EMPTY_USAGE_FILTER: UsageFilter = {
  from: "",
  to: "",
  provider: "all",
  model: "all",
  status: "all",
};
export interface UsageBucket {
  key: string;
  requests: number;
  completed: number;
  costMicros: number;
  unknownCosts: number;
}

export function localActivity(jobs: PublicJob[]): UsageActivity[] {
  return jobs
    .filter((job) => job.generationInfo || job.reservedUsd > 0)
    .map((job) => ({
      day:
        job.createdAt && Number.isFinite(Date.parse(job.createdAt))
          ? new Date(job.createdAt).toISOString().slice(0, 10)
          : null,
      provider: job.generationInfo?.provider ?? "Unknown",
      model: job.generationInfo?.model ?? "Not recorded",
      status: job.status,
      requests: 1,
      completed: job.status === "done" ? 1 : 0,
      costMicros: Math.round(job.reservedUsd * 1_000_000),
      unknownCosts: 0,
    }));
}
export function filterActivity(rows: UsageActivity[], filter: UsageFilter) {
  return rows.filter(
    (row) =>
      (filter.provider === "all" || row.provider === filter.provider) &&
      (filter.model === "all" || row.model === filter.model) &&
      (filter.status === "all" || row.status === filter.status) &&
      (!filter.from || (row.day !== null && row.day >= filter.from)) &&
      (!filter.to || (row.day !== null && row.day <= filter.to)),
  );
}
export function bucketKey(day: string, group: UsageGroup) {
  if (group === "month") return day.slice(0, 7);
  if (group !== "week") return day;
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return date.toISOString().slice(0, 10);
}
export function aggregateActivity(rows: UsageActivity[], group: UsageGroup): UsageBucket[] {
  const buckets = new Map<string, UsageBucket>();
  for (const row of rows) {
    const key =
      group === "provider"
        ? row.provider
        : group === "model"
          ? row.model
          : row.day
            ? bucketKey(row.day, group)
            : "Date unknown";
    const bucket = buckets.get(key) ?? {
      key,
      requests: 0,
      completed: 0,
      costMicros: 0,
      unknownCosts: 0,
    };
    bucket.requests += row.requests;
    bucket.completed += row.completed;
    bucket.costMicros += row.costMicros;
    bucket.unknownCosts += row.unknownCosts;
    buckets.set(key, bucket);
  }
  // Include zero-activity periods between observed dates. Weekly periods begin Monday.
  if (["day", "week", "month"].includes(group)) {
    const dated = [...buckets.keys()].filter((key) => key !== "Date unknown").sort();
    if (dated.length) {
      const cursor = new Date(`${dated[0]}${group === "month" ? "-01" : ""}T00:00:00Z`);
      const end = dated[dated.length - 1];
      while (true) {
        const key = bucketKey(cursor.toISOString().slice(0, 10), group);
        if (key > end) break;
        if (!buckets.has(key))
          buckets.set(key, { key, requests: 0, completed: 0, costMicros: 0, unknownCosts: 0 });
        if (group === "month") cursor.setUTCMonth(cursor.getUTCMonth() + 1);
        else cursor.setUTCDate(cursor.getUTCDate() + (group === "week" ? 7 : 1));
      }
    }
  }
  return [...buckets.values()].sort((a, b) =>
    a.key === "Date unknown" ? 1 : b.key === "Date unknown" ? -1 : a.key.localeCompare(b.key),
  );
}
export function metricValue(bucket: UsageBucket, metric: UsageMetric) {
  return metric === "cost"
    ? bucket.costMicros
    : metric === "completed"
      ? bucket.completed
      : bucket.requests;
}
export function usageTotals(rows: UsageActivity[]) {
  return rows.reduce(
    (sum, row) => ({
      requests: sum.requests + row.requests,
      completed: sum.completed + row.completed,
      costMicros: sum.costMicros + row.costMicros,
      unknownCosts: sum.unknownCosts + row.unknownCosts,
    }),
    { requests: 0, completed: 0, costMicros: 0, unknownCosts: 0 },
  );
}
