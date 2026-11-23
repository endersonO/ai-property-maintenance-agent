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

// Latest runs with their horizontal verdict counts for the current evaluator versions.
// `failing` narrows the list to runs that evaluator flagged (fail or error): from a metric on
// the Quality panel to the traces behind it in one click.
export type RunChecks = { flagged: number; pending: number };

// What a run left behind, in its CURRENT state: tickets it created, tickets it escalated (taken
// from the create tool's recorded result, escalated: true — an escalated ticket keeps the run id
// of the run that created it), and its reviews. A review requested for an older ticket is a
// review, not an escalation.
export type RunOutcome = {
  tickets: { id: string; priority: string; status: string; escalated: boolean }[];
  reviewsPending: number;
  reviewsTotal: number;
};

// Ticket ids a run escalated, from its recorded create_maintenance_ticket results.
const ESCALATED_BY = (sql: postgres.Sql, runId: postgres.PendingQuery<postgres.Row[]>) => sql`
  select e.payload -> 'result' -> 'data' ->> 'ticket_id'
  from run_events e
  where e.run_id = ${runId} and e.type = 'tool_call' and e.tool_name = 'create_maintenance_ticket'
    and e.status = 'ok' and (e.payload -> 'result' -> 'data' ->> 'escalated') = 'true'
`;

export async function listRuns(
  sql: postgres.Sql,
  options: { limit?: number; evaluators?: { id: string; version: number }[]; failing?: string | null } = {},
): Promise<(RunRow & { checks: RunChecks; outcome: RunOutcome })[]> {
  const { limit = 50, evaluators = [], failing = null } = options;
  const ids = evaluators.map((e) => e.id);
  const versions = evaluators.map((e) => e.version);
  const rows = await sql`
    select ${RUN_COLUMNS(sql)}, c.flagged, c.pending, o.tickets, o.reviews_pending, o.reviews_total
    from runs r
    left join tenants t on t.id = r.tenant_id
    left join agencies a on a.id = r.agency_id
    cross join lateral (
      select count(*) filter (where v.verdict in ('fail', 'error')) as flagged,
             -- A running run has no verdicts yet: pending, never "clear".
             count(*) filter (where v.verdict is null) as pending
      from unnest(${ids}::text[], ${versions}::int[]) as e(id, version)
      left join run_evaluations v
        on v.run_id = r.id and v.evaluator_id = e.id and v.evaluator_version = e.version
    ) c
    cross join lateral (
      select
        coalesce((
          select json_agg(json_build_object('id', tk.id, 'priority', tk.priority, 'status', tk.status,
                                            'escalated', tk.run_id is distinct from r.id) order by tk.created_at)
          from tickets tk
          where tk.run_id = r.id
             or tk.id::text in (${ESCALATED_BY(sql, sql`r.id`)})
        ), '[]'::json) as tickets,
        (select count(*) from review_queue q where q.run_id = r.id and q.status = 'pending') as reviews_pending,
        (select count(*) from review_queue q where q.run_id = r.id) as reviews_total
    ) o
    where ${failing}::text is null or exists (
      select 1
      from unnest(${ids}::text[], ${versions}::int[]) as e(id, version)
      join run_evaluations v
        on v.run_id = r.id and v.evaluator_id = e.id and v.evaluator_version = e.version
      where e.id = ${failing}::text and v.verdict in ('fail', 'error')
    )
    order by r.created_at desc
    limit ${limit}
  `;
  return rows.map((r) => ({
    ...toRun(r),
    checks: { flagged: Number(r.flagged), pending: Number(r.pending) },
    outcome: { tickets: r.tickets, reviewsPending: Number(r.reviews_pending), reviewsTotal: Number(r.reviews_total) },
  }));
}

// Verdicts of one run for the current evaluator versions (missing = pending).
export async function runEvaluations(sql: postgres.Sql, runId: string, evaluators: { id: string; version: number }[]) {
  if (!UUID.test(runId)) return [];
  const rows = await sql`
    select evaluator_id, evaluator_version, verdict, evidence
    from run_evaluations
    where run_id = ${runId}
  `;
  return evaluators.map((e) => {
    const row = rows.find((r) => r.evaluator_id === e.id && r.evaluator_version === e.version);
    return {
      evaluatorId: e.id,
      evaluatorVersion: e.version,
      verdict: (row?.verdict ?? "pending") as "pass" | "fail" | "n/a" | "error" | "pending",
      evidence: (row?.evidence ?? "") as string,
    };
  });
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
    sql`
      select id, priority, category, policy_version, estimated_cost_gbp, status, run_id <> ${runId} as escalated
      from tickets
      where run_id = ${runId}
         or id::text in (${ESCALATED_BY(sql, sql`${runId}::uuid`)})
    `,
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
      // Its state now, not when the run ended.
      status: t.status as string,
      escalated: t.escalated as boolean,
    })),
    reviews: reviews.map((r) => ({
      source: r.source as string,
      reason: r.reason as string,
      status: r.status as string,
      ticketId: r.ticket_id as string | null,
    })),
  };
}

// Horizontal evaluation per evaluator (current version) × agency × workflow. Every finished
// run is eligible: a run without a verdict is "pending", never counted as a pass.
export type QualityRow = {
  evaluatorId: string;
  // Grouped by id: agency names are not unique.
  agencyId: string | null;
  agency: string;
  workflowId: string;
  eligible: number;
  pass: number;
  fail: number;
  notApplicable: number;
  error: number;
  pending: number;
};

export async function qualityByEvaluator(
  sql: postgres.Sql,
  evaluators: { id: string; version: number }[],
): Promise<QualityRow[]> {
  const ids = evaluators.map((e) => e.id);
  const versions = evaluators.map((e) => e.version);
  const rows = await sql`
    select e.id as evaluator_id, r.agency_id, coalesce(min(a.name), '—') as agency, r.workflow_id,
           count(*) as eligible,
           count(*) filter (where v.verdict = 'pass') as pass,
           count(*) filter (where v.verdict = 'fail') as fail,
           count(*) filter (where v.verdict = 'n/a') as not_applicable,
           count(*) filter (where v.verdict = 'error') as error,
           count(*) filter (where v.verdict is null) as pending
    from runs r
    cross join unnest(${ids}::text[], ${versions}::int[]) as e(id, version)
    left join run_evaluations v
      on v.run_id = r.id and v.evaluator_id = e.id and v.evaluator_version = e.version
    left join agencies a on a.id = r.agency_id
    where r.status <> 'running'
    group by e.id, r.agency_id, r.workflow_id
    order by e.id, agency, r.agency_id, r.workflow_id
  `;
  return rows.map((r) => ({
    evaluatorId: r.evaluator_id,
    agencyId: r.agency_id,
    agency: r.agency,
    workflowId: r.workflow_id,
    eligible: Number(r.eligible),
    pass: Number(r.pass),
    fail: Number(r.fail),
    notApplicable: Number(r.not_applicable),
    error: Number(r.error),
    pending: Number(r.pending),
  }));
}
