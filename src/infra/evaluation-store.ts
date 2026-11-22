import type postgres from "postgres";
import {
  evaluateRun,
  type EvaluableRun,
  type EvaluableToolCall,
  type Evaluation,
  type EvaluationStore,
  type Evaluator,
} from "@/runtime/evaluation";

// Builds the evaluable snapshot of a finished run from `runs` + `run_events`. Payloads are
// already redacted by the orchestrator, so this matches snapshotFromResult for the same run.

export async function loadEvaluableRun(sql: postgres.Sql, runId: string): Promise<EvaluableRun | null> {
  const [run] = await sql`
    select id, workflow_id, tenant_id, agency_id, source, status, error, input, output
    from runs where id = ${runId} and status <> 'running'
  `;
  if (!run) return null;
  const events = await sql`
    select tool_name, stage, status, payload
    from run_events where run_id = ${runId} and type = 'tool_call'
    order by seq
  `;
  return {
    runId: run.id,
    workflowId: run.workflow_id,
    tenantId: run.tenant_id,
    agencyId: run.agency_id,
    source: run.source,
    status: run.status,
    error: run.error,
    userMessage: (run.input as { userMessage?: string }).userMessage ?? "",
    output: run.output,
    toolCalls: events.map(
      (e): EvaluableToolCall => ({
        name: e.tool_name,
        stage: e.stage,
        status: e.status,
        args: e.payload.args,
        result: e.payload.result,
      }),
    ),
  };
}

export class PostgresEvaluationStore implements EvaluationStore {
  // timeoutMs bounds the write inside PostgreSQL (statement and lock timeouts), so a slow or
  // blocked write is cancelled by the server and its pooled connection freed — not merely
  // abandoned by the caller while it keeps holding a connection the chat needs.
  constructor(
    private readonly sql: postgres.Sql,
    private readonly options: { timeoutMs?: number } = {},
  ) {}

  // Upsert: a retry replaces an earlier `error` (or an identical verdict) for the same version.
  async save(evaluations: Evaluation[]): Promise<void> {
    if (evaluations.length === 0) return;
    await this.sql.begin(async (tx) => {
      const timeoutMs = this.options.timeoutMs;
      if (timeoutMs !== undefined) {
        const ms = Math.max(1, Math.floor(timeoutMs));
        // SET does not take bind parameters; ms is a validated integer.
        await tx.unsafe(`set local statement_timeout = ${ms}; set local lock_timeout = ${ms}`);
      }
      await this.insert(tx, evaluations);
    });
  }

  private async insert(tx: postgres.TransactionSql, evaluations: Evaluation[]) {
    await tx`
      insert into run_evaluations ${tx(
        evaluations.map((e) => ({
          run_id: e.runId,
          evaluator_id: e.evaluatorId,
          evaluator_version: e.evaluatorVersion,
          verdict: e.verdict,
          evidence: e.evidence,
        })),
      )}
      on conflict (run_id, evaluator_id, evaluator_version)
      do update set verdict = excluded.verdict, evidence = excluded.evidence, evaluated_at = now()
    `;
  }
}

// Finished runs still missing a usable verdict for some current evaluator version: never
// evaluated (online hook skipped or failed), evaluated by an older version, or `error`.
export async function runsPendingEvaluation(
  sql: postgres.Sql,
  evaluators: Pick<Evaluator, "id" | "version">[],
  since: Date | null,
): Promise<string[]> {
  const ids = evaluators.map((e) => e.id);
  const versions = evaluators.map((e) => e.version);
  const rows = await sql`
    select r.id
    from runs r
    where r.status <> 'running'
      and (${since}::timestamptz is null or r.created_at >= ${since}::timestamptz)
      and exists (
        select 1 from unnest(${ids}::text[], ${versions}::int[]) as e(id, version)
        where not exists (
          select 1 from run_evaluations v
          where v.run_id = r.id and v.evaluator_id = e.id and v.evaluator_version = e.version
            and v.verdict <> 'error'
        )
      )
    order by r.created_at
  `;
  return rows.map((r) => r.id as string);
}

export type BackfillReport = { runs: number; verdicts: Record<Evaluation["verdict"], number> };

// Evaluates every pending run from its stored snapshot. Same evaluators, same input as the
// online hook, so a run gets the verdict it would have got online.
export async function backfillEvaluations(
  sql: postgres.Sql,
  evaluators: Evaluator[],
  since: Date | null,
): Promise<BackfillReport> {
  const store = new PostgresEvaluationStore(sql);
  const report: BackfillReport = { runs: 0, verdicts: { pass: 0, fail: 0, "n/a": 0, error: 0 } };
  for (const runId of await runsPendingEvaluation(sql, evaluators, since)) {
    const run = await loadEvaluableRun(sql, runId);
    if (!run) continue;
    const verdicts = evaluateRun(run, evaluators);
    await store.save(verdicts);
    report.runs++;
    for (const v of verdicts) report.verdicts[v.verdict]++;
  }
  return report;
}
