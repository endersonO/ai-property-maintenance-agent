import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { InMemoryEvaluationStore } from "@/runtime/evaluation";
import { ScriptedModel, type ScriptStep } from "@/runtime/model";
import { InMemoryTraceStore } from "@/runtime/tracing";
import { InMemoryQuality } from "@/workflows/quality-analyst/evals";
import { SlidingWindowLimiter } from "./limits";
import { handleQualityAssistant, INSPECTOR_VIEWER } from "./quality-assistant";

function setup(script: ScriptStep[], accessCode?: string) {
  const deps = {
    traces: new InMemoryTraceStore(),
    model: new ScriptedModel(script),
    limiter: new SlidingWindowLimiter(100, 60_000),
    quality: new InMemoryQuality(),
    evaluations: new InMemoryEvaluationStore(),
    evaluationBudgetMs: 50,
    accessCode,
  };
  const send = (body: Record<string, unknown>, code: string | null = null) =>
    handleQualityAssistant({ requestId: randomUUID(), message: "Is the agent behaving?", ...body }, deps, { accessCode: code, client: "test" });
  return { deps, send };
}

describe("handleQualityAssistant", () => {
  it("runs as the server's viewer, traced without a tenant, and checks its figures online", async () => {
    const reply = "2 runs were flagged by an alarm [runs_flagged_by_alarm].";
    const { deps, send } = setup([{ toolCalls: [{ name: "get_quality_summary", args: {} }] }, { text: reply }]);
    const res = await send({});

    expect(res).toMatchObject({ status: 200, body: { outcome: "completed", reply } });
    if (res.status !== 200) return;
    expect(deps.traces.runs.get(res.body.runId)).toMatchObject({ actorId: INSPECTOR_VIEWER, tenantId: null, workflowId: "quality-analyst" });
    const grounded = [...deps.evaluations.rows.values()].find((v) => v.evaluatorId === "numbers_grounded");
    expect(grounded).toMatchObject({ verdict: "pass" });
  });

  it("flags an answer whose count doesn't match the fact it cites", async () => {
    const { deps, send } = setup([
      { toolCalls: [{ name: "get_quality_summary", args: {} }] },
      { text: "5 runs were flagged by an alarm [runs_flagged_by_alarm]." },
    ]);
    await send({});
    const grounded = [...deps.evaluations.rows.values()].find((v) => v.evaluatorId === "numbers_grounded");
    expect(grounded).toMatchObject({ verdict: "fail", evidence: expect.stringContaining("5 does not match") });
  });

  it("takes no identity from the request: an extra field is rejected", async () => {
    const { deps, send } = setup([]);
    expect(await send({ viewerId: "someone_else" })).toMatchObject({ status: 400 });
    expect(deps.quality.calls).toEqual([]);
  });

  it("requires the demo access code when one is set", async () => {
    const { deps, send } = setup([], "secret");
    expect(await send({})).toEqual({ status: 401, body: { error: "access_code_required" } });
    expect(deps.quality.calls).toEqual([]);
  });
});
