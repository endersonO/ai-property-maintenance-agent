import Link from "next/link";
import { Suspense } from "react";
import { connection } from "next/server";
import { getSql } from "@/infra/db";
import { listRuns, runStats } from "@/infra/inspector-queries";
import { fmtDate, fmtMs, OutcomeBadge } from "./components";

async function Runs() {
  await connection();
  const sql = getSql();
  const [runs, stats] = await Promise.all([listRuns(sql), runStats(sql)]);

  return (
    <>
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
              {["Time", "Workflow", "Tenant", "Agency", "Status", "Tools", "Steps", "Duration", "Tokens", "Source"].map((h) => (
                <th key={h} scope="col" className="border-b border-border px-3 py-2 font-medium whitespace-nowrap">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {runs.length === 0 && (
              <tr>
                <td colSpan={10} className="p-8 text-center text-muted">
                  No runs yet. Send a message from the tenant portal.
                </td>
              </tr>
            )}
            {runs.map((run) => (
              <tr key={run.id} className="hover:bg-subtle">
                <th scope="row" className="border-b border-border px-3 py-2 text-left font-normal whitespace-nowrap">
                  <Link href={`/inspector/${run.id}`} className="text-accent underline-offset-2 hover:underline">
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

export default function InspectorPage() {
  return (
    <main className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-title-lg font-semibold tracking-tight">Agent Inspector</h1>
          <p className="text-body text-muted">Every run, step by step · newest first</p>
        </div>
        <Link href="/" className="text-body text-accent underline-offset-2 hover:underline">
          Tenant portal
        </Link>
      </header>
      <Suspense fallback={<p className="text-muted">Loading runs…</p>}>
        <Runs />
      </Suspense>
    </main>
  );
}
