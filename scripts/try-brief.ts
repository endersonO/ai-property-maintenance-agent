import { randomUUID } from "node:crypto";
import { evaluators } from "@/evaluators";
import { getSql } from "@/infra/db";
import { createModelFromEnv } from "@/infra/model-config";
import { managerScope, PostgresOperations } from "@/infra/postgres-operations";
import { evaluateRun, snapshotFromResult } from "@/runtime/evaluation";
import { runAgent } from "@/runtime/orchestrator";
import { operationsBriefWorkflow } from "@/workflows/operations-brief";

// `pnpm try:brief "<question>" [manager_id]` — one real-model operations brief, with its tool
// calls and horizontal verdicts. Spends API quota.

async function main() {
  try {
    process.loadEnvFile(".env.local");
  } catch {}
  const [question = "How did maintenance reports trend last quarter?", managerId = "manager_ops"] = process.argv.slice(2);
  const sql = getSql();
  try {
    const scope = await managerScope(sql, managerId);
    if (!scope) throw new Error(`Unknown manager ${managerId}`);
    const model = createModelFromEnv();
    console.log(`\n${scope.name} (${scope.agencyIds.join(", ")}) · ${model.id}\n> ${question}\n`);
    const result = await runAgent({
      workflow: operationsBriefWorkflow,
      model,
      deps: { operations: new PostgresOperations(sql), scope },
      actorId: managerId,
      requestId: randomUUID(),
      userMessage: question,
      timeoutMs: 120_000,
    });
    for (const e of result.events) {
      if (e.type === "tool_call") console.log(`  ${e.toolName} ${e.stage} ${e.status} ${JSON.stringify(e.args)}`);
    }
    console.log(`\n${result.output ?? `(failed: ${result.error})`}\n`);
    const snapshot = snapshotFromResult(result, {
      workflowId: operationsBriefWorkflow.id,
      tenantId: null,
      agencyId: null,
      source: "eval",
      userMessage: question,
    });
    for (const v of evaluateRun(snapshot, evaluators).filter((v) => v.verdict !== "n/a")) {
      console.log(`  ${v.evaluatorId}: ${v.verdict} — ${v.evidence}`);
    }
  } finally {
    await sql.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
