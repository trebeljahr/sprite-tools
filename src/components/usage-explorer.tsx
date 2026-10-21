"use client";

import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { usageMoney as money } from "@/lib/generation-usage";
import {
  aggregateActivity,
  EMPTY_USAGE_FILTER,
  filterActivity,
  metricValue,
  usageTotals,
  type UsageActivity,
  type UsageFilter,
  type UsageGroup,
  type UsageMetric,
} from "@/lib/usage-analytics";

const control = "h-9 min-w-0 rounded-md border bg-background px-2 text-sm";
const GROUPS: [UsageGroup, string][] = [
  ["day", "Day"],
  ["week", "Week"],
  ["month", "Month"],
  ["provider", "Provider"],
  ["model", "Model"],
];
function label(key: string, group: UsageGroup) {
  if (key === "Date unknown" || group === "provider" || group === "model") return key;
  if (group === "month")
    return new Date(`${key}-01T00:00:00Z`).toLocaleDateString("en", {
      month: "short",
      year: "numeric",
      timeZone: "UTC",
    });
  return `${group === "week" ? "Week of " : ""}${new Date(`${key}T00:00:00Z`).toLocaleDateString("en", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })}`;
}
export function UsageExplorer({
  activity,
  costLabel,
  noun,
}: {
  activity: UsageActivity[];
  costLabel: string;
  noun: "videos" | "images";
}) {
  const id = useId();
  const [filter, setFilter] = useState<UsageFilter>(EMPTY_USAGE_FILTER);
  const [group, setGroup] = useState<UsageGroup>(activity.some((row) => row.day) ? "day" : "model");
  const [metric, setMetric] = useState<UsageMetric>("cost");
  const [selected, setSelected] = useState<string | null>(null);
  const [range, setRange] = useState("all");
  const filtered = filterActivity(activity, filter);
  const totals = usageTotals(filtered);
  const buckets = aggregateActivity(filtered, group);
  if (group === "provider" || group === "model")
    buckets.sort((a, b) => metricValue(b, metric) - metricValue(a, metric));
  const peak = Math.max(
    metric === "cost" ? 10000 : 4,
    ...buckets.map((bucket) => metricValue(bucket, metric)),
  );
  const max = metric === "cost" ? peak : Math.ceil(peak / 4) * 4;
  const active = buckets.find((bucket) => bucket.key === selected);
  const missing = activity.filter((row) => !row.day).reduce((sum, row) => sum + row.requests, 0);
  const showValue = (value: number) => (metric === "cost" ? money(value) : value.toLocaleString());
  const metricLabel =
    metric === "cost"
      ? costLabel
      : metric === "completed"
        ? `Completed ${noun}`
        : "Generation requests";
  function change(key: keyof UsageFilter, value: string) {
    setFilter((previous) => ({ ...previous, [key]: value }));
    setSelected(null);
  }
  function preset(value: string) {
    setRange(value);
    setSelected(null);
    if (value === "custom") return;
    const today = new Date();
    const to = today.toISOString().slice(0, 10);
    today.setUTCDate(today.getUTCDate() - Number(value) + 1);
    setFilter((previous) => ({
      ...previous,
      from: value === "all" ? "" : today.toISOString().slice(0, 10),
      to: value === "all" ? "" : to,
    }));
  }
  function download() {
    const csvCell = (value: string | number) => `"${String(value).replace(/"/g, '""')}"`;
    const csv = [
      [group, "cost_usd", "requests", `completed_${noun}`, "unknown_credit_outcomes"],
      ...buckets.map((bucket) => [
        bucket.key,
        (bucket.costMicros / 1e6).toFixed(6),
        bucket.requests,
        bucket.completed,
        bucket.unknownCosts,
      ]),
    ]
      .map((row) => row.map(csvCell).join(","))
      .join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `${noun}-usage-${group}.csv`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <section className="space-y-6 border-y py-6" aria-label={`${noun} usage explorer`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="font-medium">Usage over time</h3>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setFilter(EMPTY_USAGE_FILTER);
            setRange("all");
            setSelected(null);
          }}
        >
          Reset filters
        </Button>
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
        <label className="grid gap-1.5 text-xs text-muted-foreground">
          Date range
          <select
            className={control}
            value={range}
            onChange={(event) => preset(event.target.value)}
          >
            <option value="all">All time</option>
            <option value="7">Last 7 days</option>
            <option value="30">Last 30 days</option>
            <option value="90">Last 90 days</option>
            <option value="custom">Custom</option>
          </select>
        </label>
        <label className="grid gap-1.5 text-xs text-muted-foreground">
          Provider
          <select
            className={control}
            value={filter.provider}
            onChange={(event) => {
              change("provider", event.target.value);
              change("model", "all");
            }}
          >
            <option value="all">All providers</option>
            {[...new Set(activity.map((row) => row.provider))].sort().map((provider) => (
              <option key={provider}>{provider}</option>
            ))}
          </select>
        </label>
        <label className="grid gap-1.5 text-xs text-muted-foreground">
          Model
          <select
            className={control}
            value={filter.model}
            onChange={(event) => change("model", event.target.value)}
          >
            <option value="all">All models</option>
            {[
              ...new Set(
                activity
                  .filter((row) => filter.provider === "all" || row.provider === filter.provider)
                  .map((row) => row.model),
              ),
            ]
              .sort()
              .map((model) => (
                <option key={model}>{model}</option>
              ))}
          </select>
        </label>
        <label className="grid gap-1.5 text-xs text-muted-foreground">
          Result
          <select
            className={control}
            value={filter.status}
            onChange={(event) => change("status", event.target.value)}
          >
            <option value="all">All results</option>
            {[...new Set(activity.map((row) => row.status))].sort().map((status) => (
              <option key={status}>{status}</option>
            ))}
          </select>
        </label>
        <label className="grid gap-1.5 text-xs text-muted-foreground">
          Group by
          <select
            className={control}
            value={group}
            onChange={(event) => {
              setGroup(event.target.value as UsageGroup);
              setSelected(null);
            }}
          >
            {GROUPS.map(([value, text]) => (
              <option key={value} value={value}>
                {text}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1.5 text-xs text-muted-foreground">
          Measure
          <select
            className={control}
            value={metric}
            onChange={(event) => setMetric(event.target.value as UsageMetric)}
          >
            <option value="cost">{costLabel}</option>
            <option value="completed">Completed {noun}</option>
            <option value="requests">Generation requests</option>
          </select>
        </label>
      </div>
      {range === "custom" && (
        <div className="flex flex-wrap gap-3">
          <label className="grid gap-1.5 text-xs text-muted-foreground">
            From (UTC)
            <input
              type="date"
              className={control}
              value={filter.from}
              max={filter.to || undefined}
              onChange={(event) => change("from", event.target.value)}
            />
          </label>
          <label className="grid gap-1.5 text-xs text-muted-foreground">
            To (UTC)
            <input
              type="date"
              className={control}
              value={filter.to}
              min={filter.from || undefined}
              onChange={(event) => change("to", event.target.value)}
            />
          </label>
        </div>
      )}
      <dl className="grid grid-cols-2 gap-5 md:grid-cols-4" aria-label="Filtered usage totals">
        {[
          [costLabel, money(totals.costMicros)],
          [`Completed ${noun}`, totals.completed.toLocaleString()],
          ["Generation requests", totals.requests.toLocaleString()],
          [
            "Cost per completed",
            totals.completed ? money(Math.round(totals.costMicros / totals.completed)) : "—",
          ],
        ].map(([name, value]) => (
          <div key={name}>
            <dt className="text-xs text-muted-foreground">{name}</dt>
            <dd className="mt-1 text-2xl font-medium tabular-nums tracking-tight">{value}</dd>
          </div>
        ))}
      </dl>
      <p className="text-xs text-muted-foreground">
        Filtered totals and charts cover all recorded history. Dates use UTC; weeks start Monday.
        Cost per completed includes costs from failed requests.
      </p>
      {missing > 0 && (
        <p className="text-sm text-muted-foreground">
          {missing} requests have no recorded date. Time charts use “Date unknown”; date filters
          exclude them.
        </p>
      )}
      {totals.unknownCosts > 0 && (
        <p className="text-sm text-muted-foreground">
          {totals.unknownCosts} credit outcomes are unknown and excluded from chart costs. The
          all-time account spent total above remains exact.
        </p>
      )}
      <figure aria-labelledby={`${id}-title`} className="min-w-0">
        <figcaption
          id={`${id}-title`}
          className="mb-4 flex flex-wrap justify-between gap-2 text-sm"
        >
          <span className="font-medium">
            {metricLabel} by {GROUPS.find(([value]) => value === group)?.[1].toLowerCase()}
          </span>
          <span className="text-muted-foreground">
            {metric === "cost" ? "USD" : "Count"} · {buckets.length} groups
          </span>
        </figcaption>
        {buckets.length ? (
          <div className="flex gap-3">
            <div className="flex h-60 w-16 shrink-0 flex-col justify-between text-right text-[11px] tabular-nums text-muted-foreground">
              {[1, 0.75, 0.5, 0.25, 0].map((fraction) => (
                <span key={fraction}>{showValue(Math.ceil(max * fraction))}</span>
              ))}
            </div>
            <div className="min-w-0 flex-1 overflow-x-auto pb-2">
              <div style={{ minWidth: Math.max(480, buckets.length * 48) }}>
                <div className="relative h-60 border-b">
                  <div
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-0 flex flex-col justify-between"
                  >
                    {[0, 1, 2, 3, 4].map((line) => (
                      <div key={line} className="border-t border-dashed border-border/70" />
                    ))}
                  </div>
                  <div className="relative flex h-full items-end gap-1.5 px-2">
                    {buckets.map((bucket) => {
                      const value = metricValue(bucket, metric);
                      return (
                        <button
                          type="button"
                          key={bucket.key}
                          onMouseEnter={() => setSelected(bucket.key)}
                          onFocus={() => setSelected(bucket.key)}
                          onClick={() => setSelected(bucket.key)}
                          aria-label={`${label(bucket.key, group)}: ${showValue(value)}, ${bucket.completed} completed ${noun}, ${bucket.requests} requests`}
                          aria-pressed={selected === bucket.key}
                          className={`group relative flex h-full min-w-0 flex-1 items-end rounded-t outline-offset-2 focus-visible:outline-2 focus-visible:outline-teal-600 ${selected === bucket.key ? "bg-muted/60" : "hover:bg-muted/40"}`}
                        >
                          <span
                            className="mx-auto block w-full max-w-20 rounded-t bg-teal-600 transition-[height,opacity] duration-200 group-hover:opacity-80 motion-reduce:transition-none dark:bg-teal-400"
                            style={{ height: `${(value / max) * 100}%` }}
                          />
                          <span className="sr-only">{showValue(value)}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
                <div className="mt-2 flex gap-1.5 px-2 text-center text-[10px] text-muted-foreground">
                  {buckets.map((bucket) => (
                    <span key={bucket.key} className="min-w-0 flex-1 break-words px-1">
                      {label(bucket.key, group)}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          </div>
        ) : (
          <p role="status" className="py-16 text-center text-sm text-muted-foreground">
            No generation activity matches these filters.
          </p>
        )}
        <div className="mt-4 min-h-10 text-sm" aria-live="polite">
          {active ? (
            <>
              <span className="font-medium">{label(active.key, group)}</span>
              <span className="text-muted-foreground">
                {" "}
                · {money(active.costMicros)} · {active.completed} completed {noun} ·{" "}
                {active.requests} requests
              </span>
            </>
          ) : (
            <span className="text-muted-foreground">
              Hover, tap or focus a bar for its totals. Scroll the chart sideways for more groups.
            </span>
          )}
        </div>
      </figure>
      <details className="text-sm">
        <summary className="w-fit cursor-pointer underline underline-offset-4">
          View chart data
        </summary>
        <div className="mt-4 flex justify-end">
          <Button variant="outline" size="sm" onClick={download} disabled={!buckets.length}>
            Download filtered CSV
          </Button>
        </div>
        <div className="mt-3 max-h-64 overflow-auto">
          <table className="w-full min-w-[520px] text-left text-xs">
            <caption className="sr-only">Filtered chart data</caption>
            <thead className="sticky top-0 bg-background">
              <tr>
                {["Group", costLabel, `Completed ${noun}`, "Requests"].map((name) => (
                  <th scope="col" key={name} className="border-b px-2 py-2 font-medium">
                    {name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {buckets.map((bucket) => (
                <tr key={bucket.key}>
                  <th scope="row" className="border-b px-2 py-2 font-normal">
                    {label(bucket.key, group)}
                  </th>
                  <td className="border-b px-2 py-2 tabular-nums">{money(bucket.costMicros)}</td>
                  <td className="border-b px-2 py-2 tabular-nums">{bucket.completed}</td>
                  <td className="border-b px-2 py-2 tabular-nums">{bucket.requests}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  );
}
