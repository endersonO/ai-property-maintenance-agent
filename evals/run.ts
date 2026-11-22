import { createModelFromEnv } from "@/infra/model-config";
import { runAgentEval, runExecutorEval, type EvalOutcome } from "@/runtime/evals";
import type { RunResult } from "@/runtime/orchestrator";
import { maintenanceWorkflow } from "@/workflows/maintenance";
import { maintenanceAgentEvals } from "@/workflows/maintenance/agent-evals";
import { maintenanceEvals, makeEvalDeps } from "@/workflows/maintenance/evals";

// `pnpm evals`                 executor evals (scripted model). Non-zero exit on failure: gates CI.
// `pnpm evals --layer agent`   agent evals (real model, pass rates). Reported, never gating.

const suites = [
  {
    workflow: maintenanceWorkflow,
    cases: maintenanceEvals,
    agentCases: maintenanceAgentEvals,
    makeDeps: makeEvalDeps,
  },
];

function printTrace(result: RunResult) {
  console.log(`      run ${result.runId} → ${result.status}${result.error ? ` (${result.error})` : ""}`);
  for (const event of result.events) {
    console.log(
      event.type === "model_call"
        ? `        #${event.seq} model_call ${event.status} → ${event.error ?? (event.toolCalls.join(", ") || "final answer")}`
        : `        #${event.seq} ${event.toolName} ${event.stage} ${event.status} ${JSON.stringify(event.args)}`,
    );
  }
  if (result.output) console.log(`        reply: ${result.output.replace(/\s+/g, " ").slice(0, 200)}`);
}

async function runExecutorLayer() {
  let failed = 0;
  let total = 0;
  for (const suite of suites) {
    console.log(`\nExecutor evals — ${suite.workflow.id}\n`);
    for (const evalCase of suite.cases) {
      const outcome: EvalOutcome = await runExecutorEval(suite.workflow, evalCase, suite.makeDeps);
      total++;
      console.log(`  ${outcome.pass ? "PASS" : "FAIL"}  ${outcome.id.padEnd(4)} ${outcome.title}`);
      if (!outcome.pass) {
        failed++;
        for (const failure of outcome.failures) console.log(`      ✗ ${failure}`);
        outcome.results.forEach(printTrace);
      }
    }
  }
  console.log(`\n${total - failed}/${total} passed\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

async function runAgentLayer(repeats: number) {
  try {
    process.loadEnvFile(".env.local");
  } catch {}
  const model = createModelFromEnv();
  let passes = 0;
  let scored = 0;
  let infraErrors = 0;

  for (const suite of suites) {
    console.log(`\nAgent evals — ${suite.workflow.id} (${model.id}, ${repeats} runs each)\n`);
    for (const evalCase of suite.agentCases) {
      const outcome = await runAgentEval(suite.workflow, evalCase, suite.makeDeps, model, repeats);
      const errored = outcome.attempts.filter((a) => a.infraError).length;
      const caseScored = outcome.attempts.length - errored;
      passes += outcome.passes;
      scored += caseScored;
      infraErrors += errored;
      const note = errored ? `  (+${errored} infra error${errored > 1 ? "s" : ""}, not scored)` : "";
      console.log(`  ${outcome.passes}/${caseScored}  ${outcome.id.padEnd(4)} ${outcome.title}${note}`);
      for (const attempt of outcome.attempts.filter((a) => !a.pass)) {
        for (const failure of attempt.failures) console.log(`      ✗ ${failure}`);
        printTrace(attempt.result);
      }
    }
  }
  const rate = scored === 0 ? 0 : Math.round((passes / scored) * 100);
  console.log(`\nPass rate: ${passes}/${scored} (${rate}%)  ·  infra errors: ${infraErrors}  ·  reported, not gating\n`);
}

const args = process.argv.slice(2);
const layer = args.includes("--layer") ? args[args.indexOf("--layer") + 1] : "executor";
const repeats = args.includes("--repeats") ? Number(args[args.indexOf("--repeats") + 1]) : 3;

(layer === "agent" ? runAgentLayer(repeats) : runExecutorLayer()).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
