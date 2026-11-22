import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { InMemoryRepository } from "@/infra/memory-repository";
import { ScriptedModel, type ScriptStep } from "@/runtime/model";
import { InMemoryTraceStore } from "@/runtime/tracing";
import { handleChat } from "./chat";
import { SlidingWindowLimiter } from "./limits";

function setup(script: ScriptStep[], options: { accessCode?: string; maxPerMinute?: number } = {}) {
  const deps = {
    repo: new InMemoryRepository(),
    traces: new InMemoryTraceStore(),
    model: new ScriptedModel(script),
    limiter: new SlidingWindowLimiter(options.maxPerMinute ?? 100, 60_000),
    accessCode: options.accessCode,
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
});
