import { evaluators } from "@/evaluators";
import { createModelFromEnv } from "@/infra/model-config";
import type { Evaluation } from "@/runtime/evaluation";
import { runAgentEval, runExecutorEval, type EvalOutcome } from "@/runtime/evals";
import type { RunResult } from "@/runtime/orchestrator";
import { maintenanceWorkflow } from "@/workflows/maintenance";
import { maintenanceAgentEvals } from "@/workflows/maintenance/agent-evals";
import { maintenanceEvals, makeEvalDeps } from "@/workflows/maintenance/evals";
import { ticketStatusWorkflow } from "@/workflows/ticket-status";
import { ticketStatusAgentEvals, ticketStatusEvals } from "@/workflows/ticket-status/evals";
import { operationsBriefWorkflow } from "@/workflows/operations-brief";
import { makeOpsDeps, operationsBriefEvals } from "@/workflows/operations-brief/evals";
import { qualityAnalystWorkflow } from "@/workflows/quality-analyst";
import { makeQualityDeps, qualityAnalystEvals } from "@/workflows/quality-analyst/evals";

// `pnpm evals`                 executor evals (scripted model). Non-zero exit on failure: gates CI.
// `pnpm evals --layer agent`   agent evals (real model, pass rates). Reported, never gating.

const suites = [
  {
    workflow: maintenanceWorkflow,
    cases: maintenanceEvals,
    agentCases: maintenanceAgentEvals,
    makeDeps: makeEvalDeps,
  },
  {
    workflow: ticketStatusWorkflow,
    cases: ticketStatusEvals,
    agentCases: ticketStatusAgentEvals,
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

// Horizontal verdicts across every run of the layer: the same table the Inspector shows.
function printHorizontal(all: Evaluation[]) {
  console.log("Horizontal evaluators (every run)\n");
  for (const evaluator of evaluators) {
    const mine = all.filter((v) => v.evaluatorId === evaluator.id);
    const count = (verdict: Evaluation["verdict"]) => mine.filter((v) => v.verdict === verdict).length;
    const [pass, fail] = [count("pass"), count("fail")];
    const rate = pass + fail === 0 ? "—" : `${Math.round((pass / (pass + fail)) * 100)}%`;
    console.log(
      `  ${evaluator.id.padEnd(20)} ${evaluator.kind.padEnd(9)} pass ${pass} · fail ${fail} · n/a ${count("n/a")} · error ${count("error")}  →  ${rate}`,
    );
    for (const v of mine.filter((v) => v.verdict === "fail" || v.verdict === "error")) {
      console.log(`      ✗ run ${v.runId}: ${v.evidence}`);
    }
  }
  console.log("");
}

async function runExecutorLayer() {
  const horizontal: Evaluation[] = [];
  let failed = 0;
  let total = 0;
  for (const suite of suites) {
    console.log(`\nExecutor evals — ${suite.workflow.id}\n`);
    for (const evalCase of suite.cases) {
      const outcome: EvalOutcome = await runExecutorEval(suite.workflow, evalCase, suite.makeDeps, evaluators);
      horizontal.push(...outcome.evaluations);
      total++;
      console.log(`  ${outcome.pass ? "PASS" : "FAIL"}  ${outcome.id.padEnd(4)} ${outcome.title}`);
      if (!outcome.pass) {
        failed++;
        for (const failure of outcome.failures) console.log(`      ✗ ${failure}`);
        outcome.results.forEach(printTrace);
      }
    }
  }
  // The operations brief has its own dependencies (a manager's scope), so its own loop.
  console.log(`\nExecutor evals — ${operationsBriefWorkflow.id}\n`);
  for (const evalCase of operationsBriefEvals) {
    const outcome = await runExecutorEval(operationsBriefWorkflow, evalCase, makeOpsDeps, evaluators);
    horizontal.push(...outcome.evaluations);
    total++;
    console.log(`  ${outcome.pass ? "PASS" : "FAIL"}  ${outcome.id.padEnd(4)} ${outcome.title}`);
    if (!outcome.pass) {
      failed++;
      for (const failure of outcome.failures) console.log(`      ✗ ${failure}`);
      outcome.results.forEach(printTrace);
    }
  }
  // The Inspector's assistant too: its deps are the Inspector's data, read-only.
  console.log(`\nExecutor evals — ${qualityAnalystWorkflow.id}\n`);
  for (const evalCase of qualityAnalystEvals) {
    const outcome = await runExecutorEval(qualityAnalystWorkflow, evalCase, makeQualityDeps, evaluators);
    horizontal.push(...outcome.evaluations);
    total++;
    console.log(`  ${outcome.pass ? "PASS" : "FAIL"}  ${outcome.id.padEnd(4)} ${outcome.title}`);
    if (!outcome.pass) {
      failed++;
      for (const failure of outcome.failures) console.log(`      ✗ ${failure}`);
      outcome.results.forEach(printTrace);
    }
  }
  console.log(`\n${total - failed}/${total} passed\n`);
  printHorizontal(horizontal);
  process.exitCode = failed > 0 ? 1 : 0;
}

async function runAgentLayer(repeats: number) {
  try {
    process.loadEnvFile(".env.local");
  } catch {}
  const model = createModelFromEnv();
  const horizontal: Evaluation[] = [];
  let passes = 0;
  let scored = 0;
  let infraErrors = 0;

  for (const suite of suites) {
    console.log(`\nAgent evals — ${suite.workflow.id} (${model.id}, ${repeats} runs each)\n`);
    for (const evalCase of suite.agentCases.filter((c) => only.length === 0 || only.includes(c.id))) {
      const outcome = await runAgentEval(suite.workflow, evalCase, suite.makeDeps, model, repeats, evaluators);
      horizontal.push(...outcome.attempts.flatMap((a) => a.evaluations));
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
  printHorizontal(horizontal);
}

const args = process.argv.slice(2);
const layer = args.includes("--layer") ? args[args.indexOf("--layer") + 1] : "executor";
const repeats = args.includes("--repeats") ? Number(args[args.indexOf("--repeats") + 1]) : 3;
// --case A5,A8 limits agent evals to some cases (saves API quota while iterating).
const only = args.includes("--case") ? args[args.indexOf("--case") + 1].split(",") : [];

(layer === "agent" ? runAgentLayer(repeats) : runExecutorLayer()).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
