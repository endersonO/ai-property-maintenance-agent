import { runExecutorEval, type EvalOutcome } from "@/runtime/evals";
import { maintenanceWorkflow } from "@/workflows/maintenance";
import { maintenanceEvals, makeEvalDeps } from "@/workflows/maintenance/evals";

// `pnpm evals`: executor evals (scripted model). Exits non-zero on any failure, so CI blocks.

const suites = [{ workflow: maintenanceWorkflow, cases: maintenanceEvals, makeDeps: makeEvalDeps }];

function printTrace(outcome: EvalOutcome) {
  for (const result of outcome.results) {
    console.log(`      run ${result.runId} → ${result.status}${result.error ? ` (${result.error})` : ""}`);
    for (const event of result.events) {
      console.log(
        event.type === "model_call"
          ? `        #${event.seq} model_call ${event.status} → ${event.toolCalls.join(", ") || "final answer"}`
          : `        #${event.seq} ${event.toolName} ${event.stage} ${event.status}`,
      );
    }
  }
}

async function main() {
  let failed = 0;
  let total = 0;

  for (const suite of suites) {
    console.log(`\nExecutor evals — ${suite.workflow.id}\n`);
    for (const evalCase of suite.cases) {
      const outcome = await runExecutorEval(suite.workflow, evalCase, suite.makeDeps);
      total++;
      console.log(`  ${outcome.pass ? "PASS" : "FAIL"}  ${outcome.id.padEnd(4)} ${outcome.title}`);
      if (!outcome.pass) {
        failed++;
        for (const failure of outcome.failures) console.log(`      ✗ ${failure}`);
        printTrace(outcome);
      }
    }
  }

  console.log(`\n${total - failed}/${total} passed\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main();
