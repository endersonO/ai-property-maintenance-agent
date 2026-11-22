import { describe, expect, it } from "vitest";
import { evaluators } from "@/evaluators";
import { runExecutorEval } from "@/runtime/evals";
import { ticketStatusWorkflow } from "../ticket-status";
import { ticketStatusEvals } from "../ticket-status/evals";
import { maintenanceWorkflow } from ".";
import { maintenanceEvals, makeEvalDeps } from "./evals";
import { operationsBriefWorkflow } from "../operations-brief";
import { makeOpsDeps, operationsBriefEvals } from "../operations-brief/evals";

// Runs the executor evals inside `pnpm test` too, so a regression fails the normal test run.
// The horizontal evaluators run on every eval run: a broken invariant fails the case.
const suites = [
  { workflow: maintenanceWorkflow, cases: maintenanceEvals },
  { workflow: ticketStatusWorkflow, cases: ticketStatusEvals },
];

for (const suite of suites) {
  describe(`${suite.workflow.id} executor evals`, () => {
    it.each(suite.cases.map((c) => [c.id, c] as const))("%s", async (_id, evalCase) => {
      const outcome = await runExecutorEval(suite.workflow, evalCase, makeEvalDeps, evaluators);
      expect(outcome.failures).toEqual([]);
      expect(outcome.evaluations).toHaveLength(outcome.results.length * evaluators.length);
    });
  });
}

describe("operations-brief executor evals", () => {
  it.each(operationsBriefEvals.map((c) => [c.id, c] as const))("%s", async (_id, evalCase) => {
    const outcome = await runExecutorEval(operationsBriefWorkflow, evalCase, makeOpsDeps, evaluators);
    expect(outcome.failures).toEqual([]);
  });
});
