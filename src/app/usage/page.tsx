"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { UsageExplorer } from "@/components/usage-explorer";
import { localActivity } from "@/lib/usage-analytics";
import { Input } from "@/components/ui/input";
import {
  type CreditUsage,
  creditOutcome,
  localUsage,
  usageMoney as money,
} from "@/lib/generation-usage";
import { isLocalStudio, studioStatus, type StudioStatus } from "@/lib/video/client";

function Totals({ values }: { values: [string, string][] }) {
  return (
    <dl className="grid grid-cols-2 gap-6 border-y py-6 md:grid-cols-4">
      {values.map(([label, value]) => (
        <div key={label}>
          <dt className="text-xs text-muted-foreground">{label}</dt>
          <dd className="mt-2 text-2xl font-medium tabular-nums tracking-tight md:text-3xl">
            {value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
const cell = "px-3 py-3 text-left align-top";
function when(date?: string) {
  return date ? new Date(date).toLocaleString() : "Date not recorded";
}

export default function UsagePage() {
  const [studio, setStudio] = useState<StudioStatus | null>(null);
  const [credits, setCredits] = useState<CreditUsage | null>(null);
  const [local, setLocal] = useState(false);
  const [studioError, setStudioError] = useState("");
  const [creditError, setCreditError] = useState("");
  const [busy, setBusy] = useState(true);
  const [page, setPage] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const [search, setSearch] = useState("");
  const [outcome, setOutcome] = useState("all");
  useEffect(() => {
    // The refresh counter intentionally reloads the current history page.
    void refresh;
    const controller = new AbortController();
    const local = isLocalStudio();
    setLocal(local);
    setBusy(true);
    setCreditError("");
    setStudioError("");
    const account = fetch(`/api/account/usage?page=${page}`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (response.status === 401)
          throw new Error("Sign in on the account page to view prepaid credit usage.");
        if (!response.ok)
          throw new Error(
            "Credit usage is unavailable on this server. Open your hosted account to view it.",
          );
        return response.json() as Promise<CreditUsage>;
      })
      .then((data) => {
        if (!controller.signal.aborted) setCredits(data);
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          setCredits(null);
          setCreditError(error.message);
        }
      });
    const video = local
      ? studioStatus()
          .then((data) => {
            if (!controller.signal.aborted) setStudio(data);
          })
          .catch((error) => {
            if (!controller.signal.aborted) {
              setStudio(null);
              setStudioError(error.message);
            }
          })
      : Promise.resolve();
    void Promise.all([account, video]).finally(() => {
      if (!controller.signal.aborted) setBusy(false);
    });
    return () => controller.abort();
  }, [page, refresh]);
  const summary = localUsage(studio?.jobs ?? []);
  const jobs = [...(studio?.jobs ?? [])]
    .reverse()
    .filter(
      (job) =>
        (outcome === "all" || job.status === outcome) &&
        `${job.id} ${job.generationInfo?.model ?? "local import"} ${job.generationInfo?.provider ?? ""}`
          .toLowerCase()
          .includes(search.toLowerCase()),
    );
  return (
    <main className="mx-auto w-full max-w-6xl space-y-12 px-4 py-10 md:px-8">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Generation usage</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Prepaid credit deductions and local video reservations. All amounts in US dollars.
          </p>
        </div>
        <Button variant="outline" disabled={busy} onClick={() => setRefresh((value) => value + 1)}>
          {busy ? "Loading…" : "Refresh"}
        </Button>
      </header>
      <nav aria-label="Usage sections" className="flex gap-6 border-b pb-3 text-sm">
        <a href="#credits" className="underline underline-offset-4">
          AI Character credits
        </a>
        <a href="#video" className="underline underline-offset-4">
          Video Studio
        </a>
      </nav>
      <section id="credits" className="scroll-mt-6 space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-xl font-medium">AI Character credits</h2>
          <a href="/account" className="text-sm underline underline-offset-4">
            Your account
          </a>
        </div>
        <p className="text-sm text-muted-foreground">
          Exact deductions from your prepaid balance, including the stated margin. Own-key image
          requests are billed separately by xAI.
        </p>
        {creditError && (
          <p role="status" className="text-sm">
            {creditError}{" "}
            {local && (
              <a href="https://sprites.trebeljahr.com/usage" className="underline">
                Hosted credit dashboard
              </a>
            )}
          </p>
        )}
        {credits && (
          <>
            <Totals
              values={[
                ["Available credit", money(credits.balanceMicros)],
                ["Credit spent · all time", money(credits.spentMicros)],
                ["Currently reserved", money(credits.reservedMicros)],
                ["Generation requests", String(credits.total)],
              ]}
            />
            {credits.total === 0 ? (
              <p className="text-sm text-muted-foreground">No prepaid generations yet.</p>
            ) : (
              <>
                {credits.activity ? (
                  <UsageExplorer
                    activity={credits.activity}
                    costLabel="Credit deducted"
                    noun="images"
                  />
                ) : (
                  <p className="text-sm text-muted-foreground">
                    Update the accounts server to view full-history charts.
                  </p>
                )}
                {credits.unknownCount > 0 && (
                  <p className="text-sm text-muted-foreground">
                    {credits.unknownCount} historical failed requests lack a charge or return
                    record. The all-time spent total remains exact; model totals exclude these
                    unknown amounts.
                  </p>
                )}
                <div className="max-h-[28rem] overflow-auto">
                  <table className="w-full min-w-[680px] border-collapse text-sm">
                    <caption className="sr-only">Prepaid generation history, newest first</caption>
                    <thead className="sticky top-0 border-b bg-background text-xs text-muted-foreground">
                      <tr>
                        {["Date / request", "Model", "Result", "Credit outcome", "Amount"].map(
                          (label) => (
                            <th key={label} scope="col" className={cell}>
                              {label}
                            </th>
                          ),
                        )}
                      </tr>
                    </thead>
                    <tbody>
                      {credits.jobs.map((job) => (
                        <tr key={job.id} className="border-b transition-colors hover:bg-muted/40">
                          <td className={cell}>
                            {when(job.createdAt)}
                            <span className="block font-mono text-xs text-muted-foreground">
                              {job.id}
                            </span>
                          </td>
                          <td className={cell}>{job.model ?? "Not recorded"}</td>
                          <td className={cell}>{job.status}</td>
                          <td className={cell}>{creditOutcome(job)}</td>
                          <td className={`${cell} tabular-nums`}>
                            {money(job.costMicros)}
                            <span className="block text-xs text-muted-foreground">
                              {job.billingStatus === "charged"
                                ? "deducted"
                                : job.billingStatus === "refunded"
                                  ? "returned"
                                  : "reservation"}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="flex items-center justify-end gap-4 text-sm">
                  <Button
                    variant="outline"
                    disabled={busy || page === 0}
                    onClick={() => setPage((value) => value - 1)}
                  >
                    Previous
                  </Button>
                  <span>
                    Page {page + 1} of {Math.max(1, Math.ceil(credits.total / 50))}
                  </span>
                  <Button
                    variant="outline"
                    disabled={busy || (page + 1) * 50 >= credits.total}
                    onClick={() => setPage((value) => value + 1)}
                  >
                    Next
                  </Button>
                </div>
              </>
            )}
          </>
        )}
      </section>
      <section id="video" className="scroll-mt-6 space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-xl font-medium">Local Video Studio</h2>
          <a href="/animate" className="text-sm underline underline-offset-4">
            Open Video Studio
          </a>
        </div>
        <p className="text-sm text-muted-foreground">
          Reservations protect your local budget. Actual provider charges are not recorded here;
          check Google or xAI billing for confirmed spending.
        </p>
        {!local && !busy && (
          <p className="text-sm">
            Open <span className="font-mono">/usage</span> on your local companion to see video
            history. Local records stay on your computer.
          </p>
        )}
        {studioError && (
          <p role="status" className="text-sm">
            {studioError}{" "}
            <a href="/setup" className="underline">
              Connect local Studio
            </a>
          </p>
        )}
        {studio && (
          <>
            {studio.simulation && (
              <p className="text-sm font-medium">Simulation data · no provider charges</p>
            )}
            <Totals
              values={[
                ["Committed reservations", money(Math.round(studio.budget.committedUsd * 1e6))],
                ["Local budget remaining", money(Math.round(studio.budget.remainingUsd * 1e6))],
                ["Local budget limit", money(Math.round(studio.budget.limitUsd * 1e6))],
                ["Saved jobs", String(studio.jobs.length)],
              ]}
            />
            <p className="text-sm text-muted-foreground">
              Completed: {money(summary.completedMicros)} · Failed: {money(summary.failedMicros)} ·
              Active / uncertain: {money(summary.activeMicros)}. Failed reservations remain
              committed.
            </p>
            <UsageExplorer
              activity={localActivity(studio.jobs)}
              costLabel="Reserved cost"
              noun="videos"
            />
            <div className="flex flex-wrap items-end gap-4">
              <div className="min-w-56 flex-1 space-y-2">
                <label htmlFor="usage-search" className="text-xs text-muted-foreground">
                  Find a model, provider or request
                </label>
                <Input
                  id="usage-search"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search local history"
                />
              </div>
              <div className="space-y-2">
                <label htmlFor="usage-outcome" className="block text-xs text-muted-foreground">
                  Result
                </label>
                <select
                  id="usage-outcome"
                  value={outcome}
                  onChange={(event) => setOutcome(event.target.value)}
                  className="h-9 rounded-md border bg-background px-3 text-sm"
                >
                  {["all", "done", "failed", "uncertain", "queued", "generating", "processing"].map(
                    (status) => (
                      <option key={status} value={status}>
                        {status === "all" ? "All results" : status}
                      </option>
                    ),
                  )}
                </select>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              {jobs.length} of {studio.jobs.length} jobs · Historical dates were not recorded.
            </p>
            <div className="max-h-[28rem] overflow-auto">
              <table className="w-full min-w-[700px] border-collapse text-sm">
                <caption className="sr-only">Local video reservations, newest saved first</caption>
                <thead className="sticky top-0 border-b bg-background text-xs text-muted-foreground">
                  <tr>
                    {["Date / request", "Provider / model", "Video", "Result", "Reserved"].map(
                      (label) => (
                        <th key={label} scope="col" className={cell}>
                          {label}
                        </th>
                      ),
                    )}
                  </tr>
                </thead>
                <tbody>
                  {jobs.map((job) => (
                    <tr key={job.id} className="border-b transition-colors hover:bg-muted/40">
                      <td className={cell}>
                        {when(job.createdAt)}
                        <span className="block font-mono text-xs text-muted-foreground">
                          {job.id}
                        </span>
                      </td>
                      <td className={cell}>
                        {job.generationInfo?.provider ??
                          (job.reservedUsd ? "Unknown" : "Local import")}
                        <span className="block text-xs text-muted-foreground">
                          {job.generationInfo?.model}
                        </span>
                      </td>
                      <td className={cell}>
                        {job.generationInfo
                          ? `${job.generationInfo.durationSeconds}s · ${job.generationInfo.resolution}`
                          : "—"}
                      </td>
                      <td className={cell}>{job.status}</td>
                      <td className={`${cell} tabular-nums`}>
                        {money(Math.round(job.reservedUsd * 1e6))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {jobs.length === 0 && (
              <p className="text-sm text-muted-foreground">
                {studio.jobs.length ? "No jobs match these filters." : "No local jobs yet."}
              </p>
            )}
          </>
        )}
      </section>
    </main>
  );
}
