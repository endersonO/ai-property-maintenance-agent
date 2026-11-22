import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { InMemoryOperations } from "@/operations/memory-operations";
import { InMemoryEvaluationStore } from "@/runtime/evaluation";
import { ScriptedModel, type ScriptStep } from "@/runtime/model";
import { InMemoryTraceStore } from "@/runtime/tracing";
import * as seed from "@/infra/seed-data";
import { CANNED } from "@/workflows/operations-brief/evals";
import { SlidingWindowLimiter } from "./limits";
import { handleOperationsBrief } from "./operations-brief";

function setup(script: ScriptStep[]) {
  const deps = {
    traces: new InMemoryTraceStore(),
    model: new ScriptedModel(script),
    limiter: new SlidingWindowLimiter(100, 60_000),
    operations: new InMemoryOperations(CANNED),
    evaluations: new InMemoryEvaluationStore(),
    evaluationBudgetMs: 50,
    loadScope: async (id: string) => {
      const m = seed.managers.find((x) => x.id === id);
      return m ? { managerId: m.id, name: m.name, agencyIds: m.agencyIds } : null;
    },
  };
  const send = (body: Record<string, unknown>) =>
    handleOperationsBrief({ managerId: "manager_north", requestId: randomUUID(), message: "How did last quarter go?", ...body }, deps);
  return { deps, send };
}

const cited =
  "Northbridge Lettings received 71 tickets [tickets_created.agency_northbridge.2026-Q3] and Riverside Homes 43 [tickets_created.agency_riverside.2026-Q3] in 2026-Q3 (synthetic data).";

describe("handleOperationsBrief", () => {
  it("runs the brief as the manager, traced without a tenant, and evaluates it online", async () => {
    const { deps, send } = setup([
      { toolCalls: [{ name: "get_volume", args: { period: "last_closed_quarter", agency_id: null } }] },
      { text: cited },
    ]);
    const res = await send({});

    expect(res).toMatchObject({ status: 200, body: { outcome: "completed", reply: cited, traceAvailable: true } });
    if (res.status !== 200) return;
    expect(deps.traces.runs.get(res.body.runId)).toMatchObject({ actorId: "manager_north", tenantId: null, workflowId: "operations-brief" });
    const grounded = [...deps.evaluations.rows.values()].find((v) => v.evaluatorId === "numbers_grounded");
    expect(grounded).toMatchObject({ verdict: "pass" });
  });

  it("flags a brief whose figures don't match what it cites", async () => {
    const { deps, send } = setup([
      { toolCalls: [{ name: "get_volume", args: { period: "last_closed_quarter", agency_id: null } }] },
      { text: "Riverside Homes received 71 tickets [tickets_created.agency_riverside.2026-Q3]." },
    ]);
    await send({});
    const grounded = [...deps.evaluations.rows.values()].find((v) => v.evaluatorId === "numbers_grounded");
    expect(grounded).toMatchObject({ verdict: "fail", evidence: expect.stringContaining("71 does not match") });
  });

  it("rejects an unknown manager before running anything", async () => {
    const { deps, send } = setup([]);
    expect(await send({ managerId: "manager_nobody" })).toEqual({ status: 404, body: { error: "unknown_manager" } });
    expect(deps.traces.runs.size).toBe(0);
  });

  it("is not reachable through the tenant chat", async () => {
    const { ChatRequest } = await import("./chat");
    expect(ChatRequest.safeParse({ tenantId: "tenant_olivia", workflow: "operations-brief", requestId: randomUUID(), message: "hi" }).success).toBe(false);
  });
});
