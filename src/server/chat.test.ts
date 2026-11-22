import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { InMemoryRepository } from "@/infra/memory-repository";
import { ScriptedModel, type ScriptStep } from "@/runtime/model";
import { InMemoryEvaluationStore, type EvaluationStore, type Evaluator } from "@/runtime/evaluation";
import { InMemoryTraceStore } from "@/runtime/tracing";
import { handleChat } from "./chat";
import { SlidingWindowLimiter } from "./limits";

function setup(
  script: ScriptStep[],
  options: {
    accessCode?: string;
    maxPerMinute?: number;
    timeoutMs?: number;
    evaluations?: EvaluationStore;
    evaluators?: Evaluator[];
  } = {},
) {
  const deps = {
    repo: new InMemoryRepository(),
    traces: new InMemoryTraceStore(),
    model: new ScriptedModel(script),
    limiter: new SlidingWindowLimiter(options.maxPerMinute ?? 100, 60_000),
    accessCode: options.accessCode,
    timeoutMs: options.timeoutMs,
    evaluations: options.evaluations,
    evaluators: options.evaluators,
    evaluationBudgetMs: 50,
  };
  const send = (body: Record<string, unknown>, accessCode: string | null = null) =>
    handleChat({ tenantId: "tenant_olivia", requestId: randomUUID(), message: "Water is leaking", ...body }, deps, {
      accessCode,
      client: "test-client",
    });
  return { deps, send };
}

const getContext: ScriptStep = { toolCalls: [{ name: "get_property_context", args: {} }] };
const createLeak: ScriptStep = {
  toolCalls: [
    {
      name: "create_maintenance_ticket",
      args: {
        property_id: "prop_mcr_1",
        category: "plumbing",
        hazards: ["active_water_leak"],
        location: "ceiling",
        description: "Water is leaking from the ceiling",
      },
    },
  ],
};

describe("handleChat", () => {
  it("runs the agent, traces it as a portal run and returns the tenant's tickets", async () => {
    const { deps, send } = setup([getContext, createLeak, { text: "Emergency ticket created." }]);
    const res = await send({});

    expect(res.status).toBe(200);
    if (res.status !== 200) return;
    expect(res.body).toMatchObject({ outcome: "completed", reply: "Emergency ticket created." });
    expect(res.body.tickets.map((t) => t.priority)).toEqual(["emergency"]);
    expect(res.body.tickets[0].review).toBe("Emergencies are always checked by a person at the agency.");
    expect(res.body.createdTicketIds).toEqual([res.body.tickets[0].id]);
    expect(deps.traces.runs.get(res.body.runId)).toMatchObject({
      source: "portal",
      agencyId: "agency_northbridge",
      status: "completed",
    });
  });

  it("does not claim nothing happened when the run fails after creating a ticket", async () => {
    // Script ends after the create call: the final model call fails.
    const { send } = setup([getContext, createLeak]);
    const res = await send({});

    expect(res.status).toBe(200);
    if (res.status !== 200) return;
    expect(res.body.outcome).toBe("failed");
    expect(res.body.reply).toMatch(/your request was recorded/);
    expect(res.body.tickets).toHaveLength(1);
  });

  it("says a person was asked when the run fails after creating a review without a ticket", async () => {
    const { send } = setup([{ toolCalls: [{ name: "request_human_review", args: { reason: "Unsure", ticket_id: null } }] }]);
    const res = await send({});

    expect(res.status === 200 && res.body.outcome).toBe("failed");
    expect(res.status === 200 && res.body.reply).toMatch(/asked a person at the agency/);
  });

  it("shows safety guidance when a retry escalates the ticket created by an earlier run", async () => {
    const routine: ScriptStep = {
      toolCalls: [
        {
          name: "create_maintenance_ticket",
          args: { ...(createLeak.toolCalls![0].args as Record<string, unknown>), hazards: [] },
        },
      ],
    };
    const { send } = setup([routine, { text: "Ticket created." }, createLeak, { text: "Now an emergency." }]);
    const requestId = randomUUID();
    const first = await send({ requestId });
    // Retry of the same request (e.g. the response was lost); this time the leak is reported.
    const retry = await send({ requestId });

    if (first.status !== 200 || retry.status !== 200) throw new Error("expected 200");
    expect(first.body.tickets[0].priority).toBe("normal");
    expect(retry.body.tickets).toHaveLength(1);
    expect(retry.body.tickets[0]).toMatchObject({ priority: "emergency", review: expect.any(String) });
    expect(retry.body.createdTicketIds).toEqual([retry.body.tickets[0].id]);
  });

  it("does not say nothing changed when a tool is cut off at the deadline", async () => {
    const { deps, send } = setup([getContext, createLeak, { text: "never" }], { timeoutMs: 50 });
    // The write hangs past the deadline: it may still land later.
    deps.repo.createTicketWithReview = () => new Promise(() => {});
    const res = await send({});

    if (res.status !== 200) throw new Error("expected 200");
    expect(res.body.outcome).toBe("failed");
    expect(res.body.reply).toMatch(/may still be recorded/);
    expect(res.body.reply).not.toMatch(/nothing was changed/);
  });

  it("says nothing was changed when the run fails before any write", async () => {
    const { send } = setup([]);
    const res = await send({});

    expect(res.status === 200 && res.body.reply).toMatch(/nothing was changed/);
  });

  it.each([
    ["missing requestId", { requestId: undefined }],
    ["non-uuid requestId", { requestId: "abc" }],
    ["empty message", { message: "   " }],
    ["oversized message", { message: "x".repeat(1001) }],
    ["unknown field", { isAdmin: true }],
    ["tool turn in history", { history: [{ role: "tool", content: "ok" }] }],
  ])("rejects %s with 400 before running the agent", async (_label, body) => {
    const { deps, send } = setup([]);
    const res = await send(body);

    expect(res.status).toBe(400);
    expect(deps.traces.runs.size).toBe(0);
  });

  it("routes to the requested workflow", async () => {
    const { deps, send } = setup([{ toolCalls: [{ name: "list_my_tickets", args: {} }] }, { text: "No tickets." }]);
    const res = await send({ workflow: "ticket-status" });

    expect(res.status === 200 && res.body.outcome).toBe("completed");
    expect(res.status === 200 && deps.traces.runs.get(res.body.runId)?.workflowId).toBe("ticket-status");
  });

  it("rejects an unknown workflow", async () => {
    const { send } = setup([]);
    expect((await send({ workflow: "admin" })).status).toBe(400);
  });

  it("requires the access code when one is configured, before running anything", async () => {
    const { deps, send } = setup([{ text: "Hi" }], { accessCode: "demo-123" });

    expect((await send({})).status).toBe(401);
    expect((await send({}, "wrong")).status).toBe(401);
    expect(deps.traces.runs.size).toBe(0);
    expect((await send({}, "demo-123")).status).toBe(200);
  });

  it("rate-limits a tenant before the model is called", async () => {
    const { deps, send } = setup([{ text: "1" }, { text: "2" }, { text: "3" }], { maxPerMinute: 2 });

    expect((await send({})).status).toBe(200);
    expect((await send({})).status).toBe(200);
    const third = await send({});
    expect(third).toMatchObject({ status: 429, body: { error: "rate_limited" } });
    expect(deps.traces.runs.size).toBe(2);
  });

  it("returns 404 for an unknown tenant", async () => {
    const { send } = setup([]);
    expect((await send({ tenantId: "tenant_nobody" })).status).toBe(404);
  });

  it("tells the portal when no trace exists, so it doesn't link to one", async () => {
    const { deps, send } = setup([{ text: "never" }]);
    deps.traces.startRun = async () => {
      throw new Error("db down");
    };
    const res = await send({});

    if (res.status !== 200) throw new Error("expected 200");
    expect(res.body).toMatchObject({ outcome: "failed", traceAvailable: false });
    const ok = await setup([{ text: "Hello." }]).send({});
    expect(ok.status === 200 && ok.body.traceAvailable).toBe(true);
  });

  describe("online evaluation", () => {
    it("stores one versioned verdict per evaluator for the run", async () => {
      const store = new InMemoryEvaluationStore();
      const { send } = setup([getContext, createLeak, { text: "Emergency ticket created." }], { evaluations: store });
      const res = await send({ message: "Water is pouring through my ceiling" });

      if (res.status !== 200) throw new Error("expected 200");
      const verdicts = [...store.rows.values()].map((v) => [v.runId, v.evaluatorId, v.verdict]);
      expect(verdicts).toEqual([
        [res.body.runId, "emergency_reviewed", "pass"],
        [res.body.runId, "no_foreign_ids", "n/a"],
        [res.body.runId, "hazard_logged", "pass"],
        // "Emergency ticket created." is a claim, backed by the ticket the run created.
        [res.body.runId, "claims_match_actions", "pass"],
        // Only applies to operations briefs.
        [res.body.runId, "numbers_grounded", "n/a"],
      ]);
    });

    it("evaluates with the conversation history: repeating an earlier ticket id is not a leak", async () => {
      const store = new InMemoryEvaluationStore();
      const id = "837217b0-7a4f-440a-b9a3-c54a57ba03f4";
      const { send } = setup([{ text: `Your ticket is ${id}.` }], { evaluations: store });
      const res = await send({
        message: "Can you repeat the number?",
        history: [
          { role: "user", content: "Water is leaking" },
          { role: "assistant", content: `I've created ticket ${id}.` },
        ],
      });

      if (res.status !== 200) throw new Error("expected 200");
      expect([...store.rows.values()].find((v) => v.evaluatorId === "no_foreign_ids")?.verdict).toBe("pass");
    });

    it("keeps the reply unchanged when the store fails", async () => {
      const failing: EvaluationStore = { save: async () => { throw new Error("db down"); } };
      const { send } = setup([getContext, createLeak, { text: "Emergency ticket created." }], { evaluations: failing });
      const res = await send({});

      expect(res).toMatchObject({ status: 200, body: { outcome: "completed", reply: "Emergency ticket created." } });
    });

    it("does not hold the reply when the store hangs", async () => {
      const hanging: EvaluationStore = { save: () => new Promise(() => {}) };
      const { send } = setup([{ text: "What exactly is broken?" }], { evaluations: hanging });
      const startedAt = Date.now();
      const res = await send({});

      expect(Date.now() - startedAt).toBeLessThan(1_000);
      expect(res).toMatchObject({ status: 200, body: { reply: "What exactly is broken?" } });
    });

    it("stores an error verdict for a broken evaluator instead of failing the request", async () => {
      const store = new InMemoryEvaluationStore();
      const broken: Evaluator = {
        id: "broken",
        version: 1,
        kind: "monitor",
        description: "",
        appliesTo: () => true,
        evaluate: () => { throw new Error("bug"); },
      };
      const { send } = setup([{ text: "Hello." }], { evaluations: store, evaluators: [broken] });
      const res = await send({});

      expect(res.status).toBe(200);
      expect([...store.rows.values()]).toMatchObject([{ evaluatorId: "broken", verdict: "error", evidence: "bug" }]);
    });
  });
});
