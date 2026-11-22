import { describe, expect, it } from "vitest";
import { runExecutorEval } from "@/runtime/evals";
import { ticketStatusWorkflow } from "../ticket-status";
import { ticketStatusEvals } from "../ticket-status/evals";
import { maintenanceWorkflow } from ".";
import { maintenanceEvals, makeEvalDeps } from "./evals";

// Runs the executor evals inside `pnpm test` too, so a regression fails the normal test run.
const suites = [
  { workflow: maintenanceWorkflow, cases: maintenanceEvals },
  { workflow: ticketStatusWorkflow, cases: ticketStatusEvals },
];

for (const suite of suites) {
  describe(`${suite.workflow.id} executor evals`, () => {
    it.each(suite.cases.map((c) => [c.id, c] as const))("%s", async (_id, evalCase) => {
      const outcome = await runExecutorEval(suite.workflow, evalCase, makeEvalDeps);
      expect(outcome.failures).toEqual([]);
    });
  });
}
