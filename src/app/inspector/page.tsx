import Link from "next/link";
import { Suspense } from "react";
import { connection } from "next/server";
import { getSql } from "@/infra/db";
import { evaluators } from "@/evaluators";
import { listRuns, qualityByEvaluator, runStats } from "@/infra/inspector-queries";
import { headers } from "next/headers";
import { clientKey } from "@/server/http";
import { checkAccess, withCode } from "@/server/access";
import { AccessForm } from "../access-form";
import { ChecksCell, fmtDate, fmtMs, OutcomeBadge, RunOutcomeCell } from "./components";
import { QualityPanel } from "./quality";
import { DemoNav } from "../site-nav";

async function Runs({ searchParams }: { searchParams: PageProps<"/inspector">["searchParams"] }) {
  await connection();
  const { code, failing: failingParam } = await searchParams;
  const access = checkAccess(code, clientKey(await headers()));
  if (access !== "granted") return <AccessForm locked={access === "locked"} />;
  // Only a known evaluator id filters; anything else is ignored.
  const failing = evaluators.find((e) => e.id === failingParam)?.id ?? null;
  const sql = getSql();
  const [runs, stats, quality] = await Promise.all([
    listRuns(sql, { evaluators, failing }),
    runStats(sql),
    qualityByEvaluator(sql, evaluators),
  ]);
  const link = (extra: Record<string, string>) => {
    const query = new URLSearchParams({ ...(typeof code === "string" && code ? { code } : {}), ...extra }).toString();
    return query ? `?${query}` : "";
  };

  return (
    <>
      {/* This is the platform view (is the agent behaving?). What to attend lives in Operations. */}
      <p className="mb-6 text-body-sm text-muted">
        Open tickets and reviews to attend are in the{" "}
        <Link href={`/operations${link({})}`} className="text-accent underline-offset-2 hover:underline">
          Operations view
        </Link>
        . Here: how the agent behaves — checks on every run and each run&apos;s trace.
      </p>
      <QualityPanel rows={quality} evaluators={evaluators} flaggedHref={(id) => `/inspector${link({ failing: id })}#runs-heading`} />
      <h2 id="runs-heading" className="mb-3 text-title font-semibold">
        Runs
      </h2>
      {failing && (
        <p role="status" className="mb-4 flex flex-wrap items-center gap-2 rounded-md border border-border-strong bg-surface px-3 py-2 text-body-sm">
          Showing runs flagged by <span className="font-mono">{failing}</span> (fail or error).
          <Link href={`/inspector${link({})}`} className="text-accent underline-offset-2 hover:underline">
            Show all runs
          </Link>
        </p>
      )}
      <dl className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          ["Runs", String(stats.total)],
          ["Failed", String(stats.failed)],
          ["Completed without tool calls", String(stats.withoutToolCalls)],
          ["Average duration", fmtMs(stats.avgDurationMs)],
        ].map(([label, value]) => (
          <div key={label} className="rounded-lg border border-border bg-surface p-3 shadow-panel">
            <dt className="text-label text-muted">{label}</dt>
            <dd className="font-mono text-title tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>

      <div
        tabIndex={0}
        role="region"
        aria-labelledby="runs-caption"
        className="max-h-[70vh] overflow-auto rounded-lg border border-border bg-surface shadow-panel"
      >
        <table className="w-full border-separate border-spacing-0 text-body-sm">
          <caption id="runs-caption" className="sr-only">
            Latest agent runs
          </caption>
          <thead className="sticky top-0 z-10 bg-subtle text-left text-label text-muted">
            <tr>
              {["Time", "Workflow", "Tenant", "Agency", "Run", "Outcome (now)", "Checks", "Tools", "Steps", "Duration", "Tokens", "Source"].map((h) => (
                <th key={h} scope="col" className="border-b border-border px-3 py-2 font-medium whitespace-nowrap">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {runs.length === 0 && (
              <tr>
                <td colSpan={12} className="p-8 text-center text-muted">
                  {failing ? "No runs flagged by this evaluator." : "No runs yet. Send a message from the tenant portal."}
                </td>
              </tr>
            )}
            {runs.map((run) => (
              <tr key={run.id} className="hover:bg-subtle">
                <th scope="row" className="border-b border-border px-3 py-2 text-left font-normal whitespace-nowrap">
                  <Link href={`/inspector/${run.id}${withCode(code)}`} className="text-accent underline-offset-2 hover:underline">
                    {fmtDate(run.createdAt)}
                  </Link>
                </th>
                <td className="border-b border-border px-3 py-2 font-mono">{run.workflowId}</td>
                <td className="border-b border-border px-3 py-2 whitespace-nowrap">{run.tenant ?? "—"}</td>
                <td className="border-b border-border px-3 py-2 whitespace-nowrap">{run.agency ?? "—"}</td>
                <td className="border-b border-border px-3 py-2">
                  <OutcomeBadge status={run.status} />
                  {run.error && <span className="ml-1 font-mono text-label text-muted">{run.error}</span>}
                </td>
                <td className="border-b border-border px-3 py-2">
                  <RunOutcomeCell outcome={run.outcome} />
                </td>
                <td className="border-b border-border px-3 py-2 whitespace-nowrap">
                  <ChecksCell checks={run.checks} />
                </td>
                <td className="border-b border-border px-3 py-2 text-right font-mono tabular-nums">{run.toolCalls}</td>
                <td className="border-b border-border px-3 py-2 text-right font-mono tabular-nums">{run.steps}</td>
                <td className="border-b border-border px-3 py-2 text-right font-mono tabular-nums">{fmtMs(run.durationMs)}</td>
                <td className="border-b border-border px-3 py-2 text-right font-mono tabular-nums whitespace-nowrap">
                  {run.inputTokens === null ? "—" : `${run.inputTokens} / ${run.outputTokens}`}
                </td>
                <td className="border-b border-border px-3 py-2 whitespace-nowrap">
                  {run.source}
                  {run.evalCaseId && <span className="ml-1 font-mono text-label text-muted">{run.evalCaseId}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

export default function InspectorPage({ searchParams }: PageProps<"/inspector">) {
  return (
    <main className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-title-lg font-semibold tracking-tight">Agent Inspector</h1>
          <p className="text-body text-muted">Every run, step by step · newest first</p>
        </div>
        <DemoNav current="inspector" searchParams={searchParams} />
      </header>
      <Suspense fallback={<p className="text-muted">Loading runs…</p>}>
        <Runs searchParams={searchParams} />
      </Suspense>
    </main>
  );
}
