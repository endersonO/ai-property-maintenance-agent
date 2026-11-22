import { describe, expect, it } from "vitest";
import { runExecutorEval } from "@/runtime/evals";
import { maintenanceWorkflow } from ".";
import { maintenanceEvals, makeEvalDeps } from "./evals";

// Runs the executor evals inside `pnpm test` too, so a regression fails the normal test run.
describe("maintenance executor evals", () => {
  it.each(maintenanceEvals.map((c) => [c.id, c] as const))("%s", async (_id, evalCase) => {
    const outcome = await runExecutorEval(maintenanceWorkflow, evalCase, makeEvalDeps);
    expect(outcome.failures).toEqual([]);
  });
});
