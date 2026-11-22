import { ScriptedModel, type ScriptStep } from "./model";
import { runAgent, type RunResult } from "./orchestrator";
import { InMemoryTraceStore } from "./tracing";
import type { WorkflowDefinition } from "./types";

// Executor evals: the model is scripted, so every case is deterministic and tests what the
// system does — including when the model misbehaves. They gate CI.
// Agent evals (real model, pass rates) are a separate layer.

export type EvalRun = { requestId: string; userMessage: string; script: ScriptStep[] };

export type EvalCase<Deps> = {
  id: string;
  title: string;
  tenantId: string;
  setup?: (deps: Deps) => void | Promise<void>;
  // Several runs model separate tenant messages (e.g. a retry, or a later request).
  runs: EvalRun[];
  // Returns the failed expectations; empty means the case passed.
  check: (input: { deps: Deps; results: RunResult[] }) => Promise<string[]>;
};

export type EvalOutcome = {
  id: string;
  title: string;
  pass: boolean;
  failures: string[];
  results: RunResult[];
};

export async function runExecutorEval<Deps>(
  workflow: WorkflowDefinition<Deps>,
  evalCase: EvalCase<Deps>,
  makeDeps: () => Deps,
): Promise<EvalOutcome> {
  const deps = makeDeps();
  await evalCase.setup?.(deps);
  const traces = new InMemoryTraceStore();

  const results: RunResult[] = [];
  for (const run of evalCase.runs) {
    results.push(
      await runAgent({
        workflow,
        model: new ScriptedModel(run.script),
        deps,
        tenantId: evalCase.tenantId,
        requestId: run.requestId,
        userMessage: run.userMessage,
        trace: { store: traces, meta: { source: "eval", evalCaseId: evalCase.id } },
      }),
    );
  }

  const failures: string[] = [];
  for (const result of results) {
    if (traces.runs.get(result.runId)?.status !== result.status) {
      failures.push(`run ${result.runId} has no finished trace`);
    }
  }
  try {
    failures.push(...(await evalCase.check({ deps, results })));
  } catch (error) {
    failures.push(`check threw: ${error instanceof Error ? error.message : String(error)}`);
  }

  return { id: evalCase.id, title: evalCase.title, pass: failures.length === 0, failures, results };
}

// Tiny expectation helper for eval checks: collects messages instead of throwing.
export function expectations() {
  const failures: string[] = [];
  return {
    failures,
    equal(label: string, actual: unknown, expected: unknown) {
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        failures.push(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
      }
    },
  };
}
