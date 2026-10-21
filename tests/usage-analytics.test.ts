import { expect, it } from "vitest";
import {
  aggregateActivity,
  EMPTY_USAGE_FILTER,
  filterActivity,
  localActivity,
  usageTotals,
  type UsageActivity,
} from "../src/lib/usage-analytics";
import { validateProcessing, type PublicJob } from "../src/lib/video/schema";
const row = (values: Partial<UsageActivity> = {}): UsageActivity => ({
  day: "2026-10-20",
  provider: "xai",
  model: "lite",
  status: "done",
  requests: 1,
  completed: 1,
  costMicros: 26000,
  unknownCosts: 0,
  ...values,
});
it("combines all-history bins and fills zero-activity days without losing precision", () => {
  const bins = aggregateActivity(
    [row(), row({ day: "2026-10-22" }), row({ day: null, costMicros: 100000 })],
    "day",
  );
  expect(bins.map((bin) => [bin.key, bin.costMicros])).toEqual([
    ["2026-10-20", 26000],
    ["2026-10-21", 0],
    ["2026-10-22", 26000],
    ["Date unknown", 100000],
  ]);
  expect(usageTotals([row(), row()]).costMicros).toBe(52000);
});
it("combines provider, model, result and inclusive date filters, excluding undated jobs only for date filters", () => {
  const rows = [
    row(),
    row({ provider: "google" }),
    row({ model: "pro" }),
    row({ status: "failed", completed: 0 }),
    row({ day: null }),
  ];
  expect(
    filterActivity(rows, { ...EMPTY_USAGE_FILTER, provider: "xai", model: "lite", status: "done" }),
  ).toHaveLength(2);
  expect(
    filterActivity(rows, {
      ...EMPTY_USAGE_FILTER,
      from: "2026-10-20",
      to: "2026-10-20",
      provider: "xai",
      model: "lite",
      status: "done",
    }),
  ).toEqual([row()]);
  expect(aggregateActivity(rows, "provider").find((bin) => bin.key === "xai")).toMatchObject({
    requests: 4,
    completed: 3,
    costMicros: 104000,
  });
});
it("groups weeks by Monday across year boundaries and months across empty periods", () => {
  expect(
    aggregateActivity([row({ day: "2027-01-03" }), row({ day: "2027-01-04" })], "week").map(
      (bin) => bin.key,
    ),
  ).toEqual(["2026-12-28", "2027-01-04"]);
  expect(
    aggregateActivity([row({ day: "2026-12-31" }), row({ day: "2027-02-01" })], "month").map(
      (bin) => bin.key,
    ),
  ).toEqual(["2026-12", "2027-01", "2027-02"]);
});
it("counts completed generations once despite reprocessing and excludes free video imports", () => {
  const job: PublicJob = {
    id: "one",
    status: "done",
    reservedUsd: 0.1,
    outputRevision: 9,
    processing: validateProcessing({}),
    createdAt: "2026-10-20T23:30:00-07:00",
    generationInfo: { provider: "xai", model: "lite", durationSeconds: 2, resolution: "720p" },
  };
  const rows = localActivity([
    job,
    { ...job, id: "import", generationInfo: undefined, reservedUsd: 0 },
    { ...job, id: "legacy", createdAt: undefined },
  ]);
  expect(rows).toHaveLength(2);
  expect(rows[0].day).toBe("2026-10-21");
  expect(rows[1].day).toBeNull();
  expect(usageTotals(rows)).toMatchObject({ requests: 2, completed: 2, costMicros: 200000 });
});
