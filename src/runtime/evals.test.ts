import { describe, expect, it } from "vitest";
import type { Evaluator } from "./evaluation";
import { runExecutorEval, type EvalCase } from "./evals";
import type { WorkflowDefinition } from "./types";

// How horizontal verdicts affect an executor eval: invariants and errors gate, monitors don't.

const workflow: WorkflowDefinition<object> = { id: "toy", systemPrompt: "", tools: [] };
const evalCase: EvalCase<object> = {
  id: "T1",
  title: "toy",
  tenantId: "t1",
  runs: [{ requestId: "r1", userMessage: "hi", script: [{ text: "hello" }] }],
  check: async () => [],
};
const failing = (kind: Evaluator["kind"]): Evaluator => ({
  id: `always_fails_${kind}`,
  version: 1,
  kind,
  description: "",
  appliesTo: () => true,
  evaluate: () => ({ verdict: "fail", evidence: "nope" }),
});

describe("runExecutorEval with horizontal evaluators", () => {
  it("fails the case when an invariant fails", async () => {
    const outcome = await runExecutorEval(workflow, evalCase, () => ({}), [failing("invariant")]);
    expect(outcome.pass).toBe(false);
    expect(outcome.failures).toEqual(["horizontal always_fails_invariant fail: nope"]);
  });

  it("reports a failing monitor without failing the case", async () => {
    const outcome = await runExecutorEval(workflow, evalCase, () => ({}), [failing("monitor")]);
    expect(outcome.pass).toBe(true);
    expect(outcome.evaluations.map((v) => v.verdict)).toEqual(["fail"]);
  });

  it("fails the case when an evaluator errors", async () => {
    const broken: Evaluator = { ...failing("monitor"), evaluate: () => { throw new Error("bug"); } };
    const outcome = await runExecutorEval(workflow, evalCase, () => ({}), [broken]);
    expect(outcome.failures).toEqual(["horizontal always_fails_monitor error: bug"]);
  });
});
