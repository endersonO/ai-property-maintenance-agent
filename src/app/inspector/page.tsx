import Link from "next/link";
import type { Metadata } from "next";
import { AppHeader } from "../app-header";
import { Suspense } from "react";
import { connection } from "next/server";
import { getSql } from "@/infra/db";
import { evaluators } from "@/evaluators";
import { listRuns, qualityByEvaluator, qualitySummary, runStats } from "@/infra/inspector-queries";
import { headers } from "next/headers";
import { clientKey } from "@/server/http";
import { checkAccess, withCode } from "@/server/access";
import { AccessForm } from "../access-form";
import { AskBox } from "../ask-box";
import { ChecksCell, fmtDate, fmtMs, RunOutcomeCell } from "./components";
import { parseFailingFilter } from "./filters";
import { ChecksTable, StatusLine } from "./quality";

async function Runs({ searchParams }: { searchParams: PageProps<"/inspector">["searchParams"] }) {
  await connection();
  const { code, failing: failingParam } = await searchParams;
  const access = checkAccess(code, clientKey(await headers()));
  if (access !== "granted") return <AccessForm locked={access === "locked"} />;
  // Only a known evaluator id filters; anything else is ignored.
  const parsed = parseFailingFilter(failingParam, evaluators.map((e) => e.id));
  const failing = parsed.failing;
  const droppedFilter = parsed.dropped;
  const sql = getSql();
  const [runs, stats, quality, summary] = await Promise.all([
    listRuns(sql, { evaluators, failing }),
    runStats(sql),
    qualityByEvaluator(sql, evaluators),
    qualitySummary(sql, evaluators),
  ]);
  const link = (extra: Record<string, string>) => {
    const query = new URLSearchParams({ ...(typeof code === "string" && code ? { code } : {}), ...extra }).toString();
    return query ? `?${query}` : "";
  };

  const flaggedHref = (id: string) => `/inspector${link({ failing: id })}#runs-heading`;
  const SET_TITLES: Record<string, string> = {
    rules: "a rule was broken",
    alarms: "an alarm flagged the run (no rule broken)",
    errors: "a check couldn't run (result unknown)",
    any: "any check failed or couldn't run",
  };
  const failingTitle = failing
    ? (SET_TITLES[failing] ??
      `${parsed.verdict === "error" ? "this check couldn't run" : parsed.verdict === "fail" ? "this check failed" : "this check failed or couldn't run"}: ${evaluators.find((e) => e.id === parsed.evaluatorId)?.description ?? parsed.evaluatorId}`)
    : null;
  const totalMatching = runs[0]?.totalMatching ?? 0;

  return (
    <>
      {/* Each headline count links to the filter that lists exactly the runs it counts. */}
      <StatusLine summary={summary} hrefFor={flaggedHref} />
      <ChecksTable rows={quality} evaluators={evaluators} flaggedHref={flaggedHref} />

      <div className="mb-8">
        <AskBox
          id="quality"
          endpoint="/api/quality-assistant"
          heading="Ask about the agent"
          description="An assistant that reads this page's runs and checks through read-only tools. Every count it gives cites its source, and what tenants wrote is treated as data, never as instructions."
          placeholder="Why was the last flagged run flagged?"
          accessCode={typeof code === "string" ? code : null}
          examples={[
            "Is the agent behaving?",
            "Why were runs flagged, and are they real problems?",
            "Show me the latest emergencies and whether a person reviewed them",
            "Did anyone try to make the agent break its rules?",
          ]}
        />
      </div>

      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="runs-heading" className="text-title font-semibold">
          Conversations
        </h2>
        <p className="text-label text-muted">
          {stats.total} runs · {stats.failed} failed · average {fmtMs(stats.avgDurationMs)} · what to attend is in{" "}
          <Link href={`/operations${link({})}`} className="text-accent underline-offset-2 hover:underline">
            Operations
          </Link>
        </p>
      </div>
      {failing && (
        <p role="status" className="mb-4 flex flex-wrap items-center gap-2 rounded-md border border-border-strong bg-surface px-3 py-2 text-body-sm">
          Showing only the runs where {failingTitle}.
          <Link href={`/inspector${link({})}`} className="text-accent underline-offset-2 hover:underline">
            Show all
          </Link>
        </p>
      )}

      {droppedFilter && (
        <p role="status" className="mb-4 rounded-md border border-dashed border-border-strong bg-surface px-3 py-2 text-body-sm">
          Unknown filter <code className="font-mono">{droppedFilter}</code> — showing all runs.
        </p>
      )}
      {totalMatching > runs.length && (
        <p className="mb-2 text-label text-muted">
          Showing the {runs.length} most recent of {totalMatching} {failing ? "matching " : ""}runs.
        </p>
      )}
      <div tabIndex={0} role="region" aria-labelledby="runs-heading" className="max-h-[75vh] overflow-auto rounded-lg border border-border bg-surface shadow-panel">
        <table className="w-full border-separate border-spacing-0 text-body-sm">
          <caption className="sr-only">Latest agent runs, newest first</caption>
          <thead className="sticky top-0 z-10 bg-subtle text-left text-label text-muted">
            <tr>
              {["When", "Who", "Asked", "What happened (now)", "Checks", "Details"].map((h) => (
                <th key={h} scope="col" className="border-b border-border px-3 py-2 font-medium whitespace-nowrap">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {runs.length === 0 && (
              <tr>
                <td colSpan={6} className="p-8 text-center text-muted">
                  {failing ? "No runs failed this check." : "No conversations yet. Send a message from the tenant portal."}
                </td>
              </tr>
            )}
            {runs.map((run) => (
              <tr key={run.id} className="align-top hover:bg-subtle">
                <th scope="row" className="border-b border-border px-3 py-2 text-left font-normal whitespace-nowrap">
                  <Link href={`/inspector/${run.id}${withCode(code)}`} className="text-accent underline-offset-2 hover:underline">
                    {fmtDate(run.createdAt)}
                  </Link>
                </th>
                <td className="border-b border-border px-3 py-2">
                  {run.actorName ?? (run.workflowId === "quality-analyst" ? "Inspector user" : "—")}
                  <span className="block text-label text-muted">
                    {run.agency ?? (run.workflowId === "operations-brief" ? "manager" : run.workflowId === "quality-analyst" ? "asked the assistant" : "")}
                  </span>
                </td>
                <td className="max-w-xs border-b border-border px-3 py-2">
                  {run.asked ? <span className="line-clamp-2">&ldquo;{run.asked}&rdquo;</span> : <span className="text-muted">—</span>}
                </td>
                <td className="border-b border-border px-3 py-2">
                  <RunOutcomeCell outcome={run.outcome} workflowId={run.workflowId} status={run.status} error={run.error} />
                </td>
                <td className="border-b border-border px-3 py-2 whitespace-nowrap">
                  <ChecksCell checks={run.checks} />
                </td>
                <td className="border-b border-border px-3 py-2 text-label whitespace-nowrap text-muted">
                  <span className="font-mono">{run.workflowId}</span>
                  <span className="block tabular-nums">
                    {fmtMs(run.durationMs)} · {run.toolCalls} tools · {run.inputTokens === null ? "—" : `${run.inputTokens + (run.outputTokens ?? 0)} tokens`}
                  </span>
                  {run.evalCaseId && <span className="block font-mono">eval {run.evalCaseId}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

export const metadata: Metadata = {
  title: "Agent Inspector",
  description: "Quality checks on every agent run, and each run step by step.",
};

export default function InspectorPage({ searchParams }: PageProps<"/inspector">) {
  return (
    <main className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6">
      <AppHeader
        title="Agent Inspector"
        subtitle="Is the agent behaving? Checks on every conversation, and each one step by step"
        current="inspector"
        searchParams={searchParams}
      />
      <Suspense fallback={<p className="text-muted">Loading runs…</p>}>
        <Runs searchParams={searchParams} />
      </Suspense>
    </main>
  );
}
