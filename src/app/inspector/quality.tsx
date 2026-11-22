import type { Evaluator } from "@/runtime/evaluation";
import type { QualityRow } from "@/infra/inspector-queries";

// Horizontal evaluation panel: pass rate AND coverage per evaluator, then per agency × workflow.
// Pass rate = pass / (pass + fail); n/a, error and pending are shown, never counted as passes.

type Totals = Omit<QualityRow, "evaluatorId" | "agencyId" | "agency" | "workflowId">;

const sum = (rows: QualityRow[]): Totals =>
  rows.reduce(
    (t, r) => ({
      eligible: t.eligible + r.eligible,
      pass: t.pass + r.pass,
      fail: t.fail + r.fail,
      notApplicable: t.notApplicable + r.notApplicable,
      error: t.error + r.error,
      pending: t.pending + r.pending,
    }),
    { eligible: 0, pass: 0, fail: 0, notApplicable: 0, error: 0, pending: 0 },
  );

const passRate = (t: Totals) => (t.pass + t.fail === 0 ? "—" : `${Math.round((t.pass / (t.pass + t.fail)) * 100)}%`);

function Coverage({ t }: { t: Totals }) {
  const evaluated = t.eligible - t.pending;
  const pct = t.eligible === 0 ? 0 : Math.round((evaluated / t.eligible) * 100);
  return (
    <div className="space-y-1">
      <div
        role="meter"
        aria-label="Runs evaluated"
        aria-valuemin={0}
        aria-valuemax={t.eligible}
        aria-valuenow={evaluated}
        className="h-1.5 overflow-hidden rounded-full bg-subtle"
      >
        <div className="h-full bg-accent" style={{ width: `${pct}%` }} />
      </div>
      <p className="text-label text-muted">
        Coverage {evaluated}/{t.eligible} runs
        {t.pending > 0 && <> · <span className="text-foreground">{t.pending} pending</span></>}
        {t.error > 0 && <> · <span className="text-error">{t.error} error</span></>}
      </p>
    </div>
  );
}

const Counts = ({ t }: { t: Totals }) => (
  <span className="font-mono tabular-nums">
    <span className={t.pass ? "text-ok" : ""}>{t.pass} pass</span> · <span className={t.fail ? "text-error" : ""}>{t.fail} fail</span> ·{" "}
    {t.notApplicable} n/a
  </span>
);

export function QualityPanel({ rows, evaluators }: { rows: QualityRow[]; evaluators: Evaluator[] }) {
  return (
    <section aria-labelledby="quality-heading" className="mb-8 space-y-3">
      <div>
        <h2 id="quality-heading" className="text-title font-semibold">
          Quality
        </h2>
        <p className="text-body-sm text-muted">
          The same versioned checks run on portal and eval runs. Invariants must always hold; monitors flag runs for
          triage.
        </p>
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        {evaluators.map((evaluator) => {
          const mine = rows.filter((r) => r.evaluatorId === evaluator.id);
          const t = sum(mine);
          return (
            <article key={evaluator.id} className="space-y-3 rounded-lg border border-border bg-surface p-4 shadow-panel">
              <header className="flex flex-wrap items-baseline justify-between gap-2">
                <div>
                  <h3 className="font-mono text-body font-medium">
                    {evaluator.id} <span className="text-label text-muted">v{evaluator.version}</span>
                  </h3>
                  <p className="text-body-sm text-muted">{evaluator.description}</p>
                </div>
                <span
                  className={`rounded-sm px-2 py-0.5 text-label font-medium ${
                    evaluator.kind === "invariant" ? "bg-accent text-accent-text" : "border border-dashed border-border-strong text-muted"
                  }`}
                >
                  {evaluator.kind}
                </span>
              </header>
              <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                <p className="font-mono text-title-lg tabular-nums" aria-label="Pass rate">
                  {passRate(t)}
                </p>
                <p className="text-body-sm">
                  <Counts t={t} />
                </p>
              </div>
              <Coverage t={t} />
              {mine.length > 0 && (
                <div tabIndex={0} role="region" aria-label={`${evaluator.id} by agency and workflow`} className="overflow-x-auto">
                  <table className="w-full text-body-sm">
                    <caption className="sr-only">{evaluator.id} by agency and workflow</caption>
                    <thead className="text-left text-label text-muted">
                      <tr>
                        {["Agency", "Workflow", "Pass rate", "Verdicts", "Pending", "Errors"].map((h) => (
                          <th key={h} scope="col" className="border-b border-border py-1 pr-3 font-medium whitespace-nowrap">
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {mine.map((r) => (
                        <tr key={`${r.agencyId ?? "none"}|${r.workflowId}`}>
                          <th scope="row" className="py-1 pr-3 text-left font-normal whitespace-nowrap">
                            {r.agency}
                          </th>
                          <td className="py-1 pr-3 font-mono">{r.workflowId}</td>
                          <td className="py-1 pr-3 font-mono tabular-nums">{passRate(r)}</td>
                          <td className="py-1 pr-3 whitespace-nowrap">
                            <Counts t={r} />
                          </td>
                          <td className="py-1 pr-3 font-mono tabular-nums">{r.pending}</td>
                          <td className={`py-1 pr-3 font-mono tabular-nums ${r.error ? "text-error" : ""}`}>{r.error}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}
