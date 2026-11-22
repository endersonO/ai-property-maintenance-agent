import { randomUUID } from "node:crypto";
import { InMemoryRepository } from "@/infra/memory-repository";
import { createModelFromEnv } from "@/infra/model-config";
import { runAgent } from "@/runtime/orchestrator";
import { maintenanceWorkflow } from "@/workflows/maintenance";

// Usage: pnpm try "Water is leaking from my ceiling" [tenant_olivia]
// One real-model run against the in-memory repository, printing its trace.

async function main() {
  try {
    process.loadEnvFile(".env.local");
  } catch {}

  const [message = "Water is leaking from my ceiling. Please help!", tenantId = "tenant_olivia"] =
    process.argv.slice(2);
  const repo = new InMemoryRepository();
  const model = createModelFromEnv();

  console.log(`\n${tenantId} (${model.id}): "${message}"\n`);
  const result = await runAgent({
    workflow: maintenanceWorkflow,
    model,
    deps: { repo },
    tenantId,
    requestId: randomUUID(),
    userMessage: message,
    timeoutMs: 120_000,
  });

  for (const e of result.events) {
    if (e.type === "model_call") {
      const what = e.status === "error" ? `ERROR ${e.error}` : e.toolCalls.join(", ") || "final answer";
      console.log(`#${e.seq} model_call  ${e.durationMs}ms  → ${what}`);
    } else {
      console.log(`#${e.seq} ${e.toolName}  ${e.stage} ${e.status}`);
      console.log(`     args:   ${JSON.stringify(e.args)}`);
      console.log(`     result: ${JSON.stringify(e.result).slice(0, 160)}`);
    }
  }
  console.log(`\nstatus=${result.status}${result.error ? ` (${result.error})` : ""} steps=${result.steps} ` +
    `tokens=${result.usage.inputTokens}+${result.usage.outputTokens} ${result.durationMs}ms`);
  console.log(`\nreply: ${result.output}\n`);
  console.log("tickets:", (await repo.listTickets(tenantId)).map((t) => `${t.category}/${t.priority} [${t.hazards}]`));
  console.log("reviews:", (await repo.listReviews(tenantId)).map((r) => `${r.source}: ${r.reason}`));
}

main();
