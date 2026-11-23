import type postgres from "postgres";
import type { Evaluator } from "@/runtime/evaluation";
import type { QualityOverview, QualityPort, RunDetail, RunFilter, RunListing, RunLookup } from "@/workflows/quality-analyst/port";
import { getRunDetail, listRuns, qualityByEvaluator, qualitySummary, runEvaluations } from "./inspector-queries";

// The quality analyst's port over the Inspector's own queries: the assistant and the page count
// runs the same way, for the same (current) evaluator versions.

const HEX_PREFIX = /^[0-9a-f]{8,32}$/;

export class PostgresQuality implements QualityPort {
  constructor(
    private readonly sql: postgres.Sql,
    private readonly evaluators: Pick<Evaluator, "id" | "version" | "kind">[],
  ) {}

  async overview(): Promise<QualityOverview> {
    const [summary, rows, workflows] = await Promise.all([
      qualitySummary(this.sql, this.evaluators),
      qualityByEvaluator(this.sql, this.evaluators),
      this.sql`
        select workflow_id, count(*)::int as runs from runs where status <> 'running' group by workflow_id order by workflow_id
      `,
    ]);
    return {
      finished: summary.finished,
      checked: summary.checked,
      notCheckedYet: summary.pending,
      ruleBroken: summary.brokenRules,
      flaggedByAlarm: summary.flagged,
      checkCouldNotRun: summary.checkErrors,
      checks: this.evaluators.map((e) => {
        const mine = rows.filter((r) => r.evaluatorId === e.id);
        const total = (k: "pass" | "fail" | "error" | "notApplicable" | "pending") => mine.reduce((n, r) => n + r[k], 0);
        return {
          checkId: e.id,
          kind: e.kind,
          passed: total("pass"),
          failed: total("fail"),
          couldNotRun: total("error"),
          notApplicable: total("notApplicable"),
          notCheckedYet: total("pending"),
        };
      }),
      runsByWorkflow: workflows.map((w) => ({ workflowId: w.workflow_id as string, runs: w.runs as number })),
    };
  }

  async runs(filter: RunFilter): Promise<{ total: number; runs: RunListing[] }> {
    const failing = filter.checkId ? (filter.verdict ? `${filter.checkId}:${filter.verdict}` : filter.checkId) : filter.problems;
    const rows = await listRuns(this.sql, {
      limit: filter.limit,
      evaluators: this.evaluators,
      failing,
      workflowId: filter.workflowId,
    });
    const runs = await Promise.all(
      rows.map(async (r): Promise<RunListing> => ({
        id: r.id,
        createdAt: r.createdAt,
        workflowId: r.workflowId,
        who: r.actorName,
        agency: r.agency,
        asked: r.asked,
        status: r.status,
        error: r.error,
        tickets: r.outcome.tickets,
        reviewsPending: r.outcome.reviewsPending,
        reviewsTotal: r.outcome.reviewsTotal,
        checks: await this.checksOf(r.id),
      })),
    );
    return { total: rows[0]?.totalMatching ?? 0, runs };
  }

  async run(ref: string): Promise<RunLookup> {
    const prefix = ref.replace(/-/g, "").toLowerCase();
    // Validated here too: the prefix goes into a LIKE pattern.
    if (!HEX_PREFIX.test(prefix)) return { kind: "not_found" };
    const matches = await this.sql`
      select r.id, coalesce(t.name, m.name) as who
      from runs r
      left join tenants t on t.id = r.tenant_id
      left join managers m on m.id = r.actor_id
      where replace(r.id::text, '-', '') like ${prefix + "%"}
      limit 2
    `;
    if (matches.length === 0) return { kind: "not_found" };
    if (matches.length > 1) return { kind: "ambiguous" };
    const [match] = matches;
    const detail = await getRunDetail(this.sql, match.id);
    if (!detail) return { kind: "not_found" };
    const { run, events, tickets, reviews } = detail;
    const found: RunDetail = {
      id: run.id,
      createdAt: run.createdAt,
      workflowId: run.workflowId,
      who: match.who as string | null,
      agency: run.agency,
      asked: (run.input?.userMessage as string | undefined) ?? null,
      status: run.status,
      error: run.error,
      tickets: tickets.map((t) => ({ id: t.id, priority: t.priority, status: t.status, escalated: t.escalated })),
      reviewsPending: reviews.filter((r) => r.status === "pending").length,
      reviewsTotal: reviews.length,
      checks: await this.checksOf(run.id),
      reply: run.output,
      toolCalls: events
        .filter((e) => e.type === "tool_call")
        .map((e) => {
          const result = e.payload.result as { ok?: boolean; code?: string } | undefined;
          return { tool: e.toolName ?? "unknown", stage: e.stage, status: e.status, code: result?.ok === false ? (result.code ?? null) : null };
        }),
      ticketDetails: tickets,
      reviews: reviews.map((r) => ({ source: r.source, reason: r.reason, status: r.status })),
    };
    return { kind: "found", run: found };
  }

  private async checksOf(runId: string) {
    return (await runEvaluations(this.sql, runId, this.evaluators)).map((v) => ({
      checkId: v.evaluatorId,
      verdict: v.verdict,
      evidence: v.evidence,
    }));
  }
}
