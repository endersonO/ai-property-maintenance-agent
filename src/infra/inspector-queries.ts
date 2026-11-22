import type postgres from "postgres";

// Read-only queries for the Agent Inspector over runs, run_events, tickets and reviews.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type RunRow = {
  id: string;
  createdAt: Date;
  workflowId: string;
  tenant: string | null;
  agency: string | null;
  source: string;
  evalCaseId: string | null;
  model: string;
  status: string;
  error: string | null;
  steps: number;
  durationMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  toolCalls: number;
};

export type RunEventRow = {
  seq: number;
  type: "model_call" | "tool_call";
  toolName: string | null;
  stage: string | null;
  status: "ok" | "rejected" | "error";
  durationMs: number | null;
  payload: Record<string, unknown>;
};

export type RunStats = { total: number; failed: number; withoutToolCalls: number; avgDurationMs: number | null };

const toRun = (r: postgres.Row): RunRow => ({
  id: r.id,
  createdAt: r.created_at,
  workflowId: r.workflow_id,
  tenant: r.tenant,
  agency: r.agency,
  source: r.source,
  evalCaseId: r.eval_case_id,
  model: r.model,
  status: r.status,
  error: r.error,
  steps: r.steps,
  durationMs: r.duration_ms,
  inputTokens: r.input_tokens,
  outputTokens: r.output_tokens,
  costUsd: r.cost_usd === null ? null : Number(r.cost_usd),
  toolCalls: Number(r.tool_calls),
});

const RUN_COLUMNS = (sql: postgres.Sql) => sql`
  r.id, r.created_at, r.workflow_id, t.name as tenant, a.name as agency, r.source, r.eval_case_id,
  r.model, r.status, r.error, r.steps, r.duration_ms, r.input_tokens, r.output_tokens, r.cost_usd,
  (select count(*) from run_events e where e.run_id = r.id and e.type = 'tool_call') as tool_calls
`;

export async function listRuns(sql: postgres.Sql, limit = 50): Promise<RunRow[]> {
  const rows = await sql`
    select ${RUN_COLUMNS(sql)}
    from runs r
    left join tenants t on t.id = r.tenant_id
    left join agencies a on a.id = r.agency_id
    order by r.created_at desc
    limit ${limit}
  `;
  return rows.map(toRun);
}

// "Completed without any tool call" is a cheap signal of off-topic use or of the model
// answering instead of acting (e.g. safety advice without a ticket).
export async function runStats(sql: postgres.Sql): Promise<RunStats> {
  const [row] = await sql`
    select count(*) as total,
           count(*) filter (where status = 'failed') as failed,
           count(*) filter (where status = 'completed' and not exists (
             select 1 from run_events e where e.run_id = r.id and e.type = 'tool_call')) as without_tools,
           avg(duration_ms) as avg_ms
    from runs r
  `;
  return {
    total: Number(row.total),
    failed: Number(row.failed),
    withoutToolCalls: Number(row.without_tools),
    avgDurationMs: row.avg_ms === null ? null : Math.round(Number(row.avg_ms)),
  };
}

export async function getRunDetail(sql: postgres.Sql, runId: string) {
  if (!UUID.test(runId)) return null;
  const [run] = await sql`
    select ${RUN_COLUMNS(sql)}, r.output, r.input
    from runs r
    left join tenants t on t.id = r.tenant_id
    left join agencies a on a.id = r.agency_id
    where r.id = ${runId}
  `;
  if (!run) return null;

  const [events, tickets, reviews] = await Promise.all([
    sql`select seq, type, tool_name, stage, status, duration_ms, payload from run_events where run_id = ${runId} order by seq`,
    sql`select id, priority, category, policy_version, estimated_cost_gbp from tickets where run_id = ${runId}`,
    sql`select source, reason, status, ticket_id from review_queue where run_id = ${runId}`,
  ]);

  return {
    run: { ...toRun(run), output: run.output as string | null, input: run.input as Record<string, unknown> },
    events: events.map(
      (e): RunEventRow => ({
        seq: e.seq,
        type: e.type,
        toolName: e.tool_name,
        stage: e.stage,
        status: e.status,
        durationMs: e.duration_ms,
        payload: e.payload,
      }),
    ),
    tickets: tickets.map((t) => ({
      id: t.id as string,
      priority: t.priority as string,
      category: t.category as string,
      policyVersion: t.policy_version as number,
      estimatedCostGbp: Number(t.estimated_cost_gbp),
    })),
    reviews: reviews.map((r) => ({
      source: r.source as string,
      reason: r.reason as string,
      status: r.status as string,
      ticketId: r.ticket_id as string | null,
    })),
  };
}
