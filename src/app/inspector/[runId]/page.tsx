import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { getSql } from "@/infra/db";
import { evaluators } from "@/evaluators";
import { getRunDetail, runEvaluations, type RunEventRow } from "@/infra/inspector-queries";
import { headers } from "next/headers";
import { clientKey } from "@/server/http";
import { checkAccess, withCode } from "@/server/access";
import { AccessForm } from "../../access-form";
import { PriorityBadge } from "../../ui";
import { fmtDate, fmtMs, JsonBlock, OutcomeBadge, PipelineStages, VerdictBadge } from "../components";
import { DemoNav } from "../../site-nav";

function TimelineEvent({ event }: { event: RunEventRow }) {
  const p = event.payload;
  const usage = p.usage as { inputTokens: number; outputTokens: number } | undefined;

  if (event.type === "model_call") {
    const requested = (p.toolCalls as string[] | undefined) ?? [];
    return (
      <li className="rounded-lg border border-border bg-surface p-3 shadow-panel">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-heading font-semibold">
            <span className="font-mono text-label text-muted">#{event.seq}</span> Model call
          </p>
          <span className="font-mono text-label text-muted tabular-nums">
            {fmtMs(event.durationMs)}
            {usage && ` · ${usage.inputTokens} / ${usage.outputTokens} tokens`}
          </span>
        </div>
        <p className="mt-1 text-body-sm">
          {event.status === "error" ? (
            <span className="text-error">Error: {String(p.error)}</span>
          ) : requested.length > 0 ? (
            <>
              Asked for <span className="font-mono">{requested.join(", ")}</span>
            </>
          ) : (
            "Final answer"
          )}
        </p>
      </li>
    );
  }

  const outline =
    event.status === "rejected" ? "border-dashed border-rejected" : event.status === "error" ? "border-error" : "border-border";
  return (
    <li className={`rounded-lg border bg-surface shadow-panel ${outline}`}>
      {/* Rejected and error events open by default: they are what an operator looks for. */}
      <details open={event.status !== "ok"} className="p-3">
        <summary className="flex cursor-pointer flex-wrap items-center justify-between gap-2">
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-label text-muted">#{event.seq}</span>
            <span className="font-mono text-heading font-semibold">{event.toolName}</span>
            <OutcomeBadge status={event.status} />
          </span>
          <span className="font-mono text-label text-muted tabular-nums">{fmtMs(event.durationMs)}</span>
        </summary>
        <div className="mt-3 space-y-3">
          <PipelineStages stoppedAt={event.stage} status={event.status} />
          {typeof p.internalError === "string" && (
            <p className="text-body-sm text-error">Internal error (not shown to the model): {p.internalError}</p>
          )}
          <div className="grid gap-3 lg:grid-cols-2">
            <JsonBlock label="Arguments from the model" value={p.args} />
            <JsonBlock label="Result returned to the model" value={p.result} />
          </div>
        </div>
      </details>
    </li>
  );
}

async function RunDetail({
  params,
  searchParams,
}: {
  params: PageProps<"/inspector/[runId]">["params"];
  searchParams: PageProps<"/inspector/[runId]">["searchParams"];
}) {
  const [{ runId }, { code }] = await Promise.all([params, searchParams]);
  const access = checkAccess(code, clientKey(await headers()));
  if (access !== "granted") return <AccessForm locked={access === "locked"} />;
  const [detail, verdicts] = await Promise.all([getRunDetail(getSql(), runId), runEvaluations(getSql(), runId, evaluators)]);
  if (!detail) notFound();
  const { run, events, tickets, reviews } = detail;

  return (
    <>
    <Link href={`/inspector${withCode(code)}`} className="mb-4 inline-block text-body text-accent underline-offset-2 hover:underline">
      ← All runs
    </Link>
    <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
      {/* min-w-0: grid items default to min-width:auto, so wide JSON would push the layout off-screen. */}
      <section aria-labelledby="timeline-heading" className="min-w-0">
        <h2 id="timeline-heading" className="mb-3 text-title font-semibold">
          Timeline
        </h2>
        <ol className="space-y-3">
          {events.map((event) => (
            <TimelineEvent key={event.seq} event={event} />
          ))}
        </ol>
      </section>

      <aside className="min-w-0 space-y-4">
        <section aria-labelledby="checks-heading" className="space-y-2 rounded-lg border border-border bg-surface p-4 shadow-panel">
          <h2 id="checks-heading" className="text-title font-semibold">
            Checks
          </h2>
          <ul className="space-y-2">
            {verdicts.map((v) => (
              <li key={v.evaluatorId} className="space-y-0.5 text-body-sm">
                <p className="flex flex-wrap items-center gap-2">
                  <span className="font-mono">{v.evaluatorId}</span>
                  <span className="font-mono text-label text-muted">v{v.evaluatorVersion}</span>
                  <VerdictBadge verdict={v.verdict} />
                </p>
                {v.evidence && <p className="break-words text-muted">{v.evidence}</p>}
              </li>
            ))}
          </ul>
        </section>

        <section className="space-y-2 rounded-lg border border-border bg-surface p-4 shadow-panel">
          <h2 className="text-title font-semibold">Run</h2>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-body-sm">
            <dt className="text-muted">Started</dt>
            <dd className="font-mono tabular-nums">{fmtDate(run.createdAt)}</dd>
            <dt className="text-muted">Status</dt>
            <dd>
              <OutcomeBadge status={run.status} /> {run.error && <span className="font-mono text-label">{run.error}</span>}
            </dd>
            <dt className="text-muted">Workflow</dt>
            <dd className="font-mono">{run.workflowId}</dd>
            <dt className="text-muted">Tenant</dt>
            <dd>{run.tenant ?? "—"}</dd>
            <dt className="text-muted">Agency</dt>
            <dd>{run.agency ?? "—"}</dd>
            <dt className="text-muted">Model</dt>
            <dd className="font-mono">{run.model}</dd>
            <dt className="text-muted">Source</dt>
            <dd>
              {run.source} {run.evalCaseId && <span className="font-mono">{run.evalCaseId}</span>}
            </dd>
            <dt className="text-muted">Duration</dt>
            <dd className="font-mono tabular-nums">{fmtMs(run.durationMs)}</dd>
            <dt className="text-muted">Tokens</dt>
            <dd className="font-mono tabular-nums">
              {run.inputTokens ?? "—"} in / {run.outputTokens ?? "—"} out
            </dd>
            <dt className="text-muted">Cost</dt>
            <dd className="font-mono tabular-nums">
              {run.costUsd === null ? "— (no price configured)" : `$${run.costUsd.toFixed(4)}`}
            </dd>
          </dl>
        </section>

        {tickets.length > 0 && (
          <section className="space-y-2 rounded-lg border border-border bg-surface p-4 shadow-panel">
            <h2 className="text-title font-semibold">Ticket</h2>
            {tickets.map((t) => (
              <div key={t.id} className="space-y-1 text-body-sm">
                <PriorityBadge priority={t.priority} />
                <p>
                  {t.category} · £{t.estimatedCostGbp.toFixed(2)} estimate · decided by policy v{t.policyVersion}
                </p>
                <p className="font-mono text-label text-muted">{t.id}</p>
              </div>
            ))}
          </section>
        )}

        {reviews.length > 0 && (
          <section className="space-y-2 rounded-lg border border-border bg-surface p-4 shadow-panel">
            <h2 className="text-title font-semibold">Human review</h2>
            {reviews.map((r, i) => (
              <p key={i} className="text-body-sm">
                <span className="font-mono">{r.source}</span> · {r.status} — {r.reason}
              </p>
            ))}
          </section>
        )}

        <JsonBlock label="Input (redacted)" value={run.input} />
        {run.output && <JsonBlock label="Reply to the tenant (redacted)" value={run.output} />}
      </aside>
    </div>
    </>
  );
}

export default function RunPage({ params, searchParams }: PageProps<"/inspector/[runId]">) {
  return (
    <main className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6">
      <header className="mb-2 flex flex-wrap items-end justify-between gap-2">
        <h1 className="text-title-lg font-semibold tracking-tight">Run detail</h1>
        <DemoNav current="inspector" searchParams={searchParams} />
      </header>
      <Suspense fallback={<p className="text-muted">Loading run…</p>}>
        <RunDetail params={params} searchParams={searchParams} />
      </Suspense>
    </main>
  );
}
