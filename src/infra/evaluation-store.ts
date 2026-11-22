import type postgres from "postgres";
import type { EvaluableRun, EvaluableToolCall } from "@/runtime/evaluation";

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
