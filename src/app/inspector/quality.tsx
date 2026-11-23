import Link from "next/link";
import type { QualityRow, QualitySummary } from "@/infra/inspector-queries";
import { CHECK_COPY } from "@/evaluators/check-copy";
import type { Evaluator } from "@/runtime/evaluation";
import { Icon } from "../ui";

// The platform view's first question — "is the agent behaving?" — answered in plain language:
// a status line, then one compact row per check. Per-agency detail is folded away.

const CHECKS = CHECK_COPY;

type Totals = { eligible: number; pass: number; fail: number; notApplicable: number; error: number; pending: number };

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

// Each count links to the filter that lists exactly the runs it counts.
export function StatusLine({ summary, hrefFor }: { summary: QualitySummary; hrefFor: (set: "rules" | "alarms" | "errors") => string }) {
  const { finished, checked, pending, brokenRules, flagged, checkErrors } = summary;
  const tone =
    brokenRules > 0 ? "broken" : finished === 0 || checked === 0 ? "pending" : flagged > 0 || checkErrors > 0 ? "attention" : "ok";
  const headline = {
    broken: `A rule was broken in ${brokenRules} run${brokenRules > 1 ? "s" : ""}`,
    pending: finished === 0 ? "No finished conversations yet" : `Pending evaluation: none of ${finished} runs checked yet`,
    attention: flagged > 0 ? `No broken rules · ${flagged} run${flagged > 1 ? "s" : ""} flagged for review` : "No broken rules",
    ok: `The agent is behaving: no broken rules in ${checked} checked run${checked > 1 ? "s" : ""}`,
  }[tone];

  return (
    <div
      role="status"
      className={`mb-6 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border px-4 py-3 shadow-panel ${
        tone === "broken" ? "border-error bg-error-soft" : "border-border bg-surface"
      }`}
    >
      <span className={`flex items-center gap-2 font-medium ${tone === "broken" ? "text-error" : tone === "ok" ? "text-ok" : ""}`}>
        <Icon name={tone === "ok" ? "check" : "alertFill"} className="size-4" />
        {headline}
      </span>
      {brokenRules > 0 && (
        <Link href={hrefFor("rules")} className="text-body-sm text-accent underline-offset-2 hover:underline">
          See the {brokenRules === 1 ? "run" : `${brokenRules} runs`} →
        </Link>
      )}
      {tone !== "broken" && flagged > 0 && (
        <Link href={hrefFor("alarms")} className="text-body-sm text-accent underline-offset-2 hover:underline">
          See the {flagged === 1 ? "run" : `${flagged} runs`} →
        </Link>
      )}
      {tone === "broken" && flagged > 0 && (
        <Link href={hrefFor("alarms")} className="text-body-sm text-accent underline-offset-2 hover:underline">
          {flagged} more flagged by an alarm →
        </Link>
      )}
      <span className="text-body-sm text-muted">
        {checked} of {finished} finished runs checked
        {checkErrors > 0 && (
          <>
            {" · "}
            <Link href={hrefFor("errors")} className="text-accent underline-offset-2 hover:underline">
              {checkErrors} with a check that couldn&apos;t run
            </Link>{" "}
            (unknown, not a failure)
          </>
        )}
        {pending > 0 && (
          <>
            {" "}
            · {pending} not checked yet — <code className="font-mono">pnpm evaluate</code> fills them in
          </>
        )}
      </span>
    </div>
  );
}

const rate = (t: Totals) => (t.pass + t.fail === 0 ? "—" : `${Math.round((t.pass / (t.pass + t.fail)) * 100)}%`);

export function ChecksTable({
  rows,
  evaluators,
  flaggedHref,
}: {
  rows: QualityRow[];
  evaluators: Evaluator[];
  // A filter for one evaluator and one verdict, so each count opens exactly its runs.
  flaggedHref: (filter: string) => string;
}) {
  return (
    <section aria-labelledby="checks-heading" className="mb-8 space-y-2">
      <div>
        <h2 id="checks-heading" className="text-title font-semibold">
          Checks on every run
        </h2>
        <p className="text-body-sm text-muted">
          The same checks run on real conversations and on test runs. A <strong>rule</strong> must always hold; an{" "}
          <strong>alarm</strong> is a heuristic that flags a run for someone to look at.
        </p>
      </div>
      <div tabIndex={0} role="region" aria-labelledby="checks-heading" className="overflow-x-auto rounded-lg border border-border bg-surface shadow-panel">
        <table className="w-full text-body-sm">
          <thead className="bg-subtle text-left text-label text-muted">
            <tr>
              {["Check", "Type", "Result", "Applied to", "Checked"].map((h, i) => (
                <th key={h} scope="col" className={`border-b border-border px-3 py-2 font-medium whitespace-nowrap ${i > 1 ? "text-right" : ""}`}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {evaluators.map((evaluator) => {
              const mine = rows.filter((r) => r.evaluatorId === evaluator.id);
              const t = sum(mine);
              const copy = CHECKS[evaluator.id] ?? { title: evaluator.id, protects: evaluator.description };

              return (
                <tr key={evaluator.id} className="border-b border-border align-top last:border-0">
                  <th scope="row" className="px-3 py-2 text-left font-normal">
                    <span className="font-medium">{copy.title}</span>
                    <span className="block text-label text-muted">{copy.protects}</span>
                    <details className="mt-1 text-label text-muted">
                      <summary className="cursor-pointer">
                        By agency · <span className="font-mono">{evaluator.id}</span> v{evaluator.version}
                      </summary>
                      <ul className="mt-1 space-y-0.5">
                        {mine.map((r) => (
                          <li key={`${r.agencyId ?? "none"}|${r.workflowId}`}>
                            {r.agency} · <span className="font-mono">{r.workflowId}</span>: {r.pass} passed, {r.fail} failed, {r.notApplicable} not applicable
                            {r.error > 0 && `, ${r.error} couldn't run`}
                            {r.pending > 0 && `, ${r.pending} not checked yet`}
                          </li>
                        ))}
                      </ul>
                    </details>
                  </th>
                  <td className="px-3 py-2">
                    <span
                      className={`rounded-sm px-2 py-0.5 text-label font-medium ${
                        evaluator.kind === "invariant" ? "bg-accent text-accent-text" : "border border-dashed border-border-strong text-muted"
                      }`}
                    >
                      {evaluator.kind === "invariant" ? "rule" : "alarm"}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right whitespace-nowrap">
                    {t.fail > 0 ? (
                      <Link href={flaggedHref(`${evaluator.id}:fail`)} className="font-medium text-error underline-offset-2 hover:underline">
                        {t.fail} failed →
                      </Link>
                    ) : t.pass > 0 ? (
                      <span className="text-ok">
                        {t.pass} of {t.pass} passed
                      </span>
                    ) : (
                      <span className="text-muted">nothing to check yet</span>
                    )}
                    {/* A check that threw is unknown, not a failure: shown apart and kept out of the rate. */}
                    {t.error > 0 && (
                      <Link href={flaggedHref(`${evaluator.id}:error`)} className="block text-label text-muted underline-offset-2 hover:underline">
                        {t.error} couldn&apos;t run
                      </Link>
                    )}
                    <span className="block text-label text-muted">{t.pass + t.fail > 0 && `${rate(t)} of decided`}</span>
                  </td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums">
                    {t.pass + t.fail + t.error} <span className="font-sans text-label text-muted">of {t.eligible} runs</span>
                  </td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums">
                    {t.eligible - t.pending}/{t.eligible}
                    {t.pending > 0 && <span className="block font-sans text-label text-muted">{t.pending} not yet</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
