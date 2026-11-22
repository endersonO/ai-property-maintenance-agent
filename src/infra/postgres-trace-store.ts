import type postgres from "postgres";
import type { RunFinish, RunStart, TraceStore } from "@/runtime/tracing";

// Persists runs and run_events. Payloads arrive already redacted by the orchestrator.

export class PostgresTraceStore implements TraceStore {
  constructor(private readonly sql: postgres.Sql) {}

  async startRun(run: RunStart): Promise<void> {
    await this.sql`
      insert into runs (id, workflow_id, agency_id, tenant_id, request_id, source, eval_case_id, model, input)
      values (${run.runId}, ${run.workflowId}, ${run.agencyId ?? null}, ${run.tenantId}, ${run.requestId},
              ${run.source}, ${run.evalCaseId ?? null}, ${run.model}, ${this.sql.json(run.input as postgres.JSONValue)})
    `;
  }

  async finishRun(run: RunFinish): Promise<void> {
    await this.sql.begin(async (tx) => {
      await tx`
        update runs set
          status = ${run.status}, output = ${run.output}, error = ${run.error}, steps = ${run.steps},
          input_tokens = ${run.usage.inputTokens}, output_tokens = ${run.usage.outputTokens},
          cost_usd = ${run.costUsd}, duration_ms = ${run.durationMs}
        where id = ${run.runId}
      `;
      for (const event of run.events) {
        const { seq, type, status, durationMs, ...rest } = event;
        const toolName = event.type === "tool_call" ? event.toolName : null;
        const stage = event.type === "tool_call" ? event.stage : null;
        await tx`
          insert into run_events (run_id, seq, type, tool_name, stage, status, payload, duration_ms)
          values (${run.runId}, ${seq}, ${type}, ${toolName}, ${stage}, ${status},
                  ${tx.json(rest as postgres.JSONValue)}, ${durationMs})
        `;
      }
    });
  }
}
