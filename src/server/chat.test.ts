import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { InMemoryRepository } from "@/infra/memory-repository";
import { ScriptedModel, type ScriptStep } from "@/runtime/model";
import { InMemoryTraceStore } from "@/runtime/tracing";
import { handleChat } from "./chat";

function setup(script: ScriptStep[]) {
  const deps = { repo: new InMemoryRepository(), traces: new InMemoryTraceStore(), model: new ScriptedModel(script) };
  const send = (body: Record<string, unknown>) =>
    handleChat({ tenantId: "tenant_olivia", requestId: randomUUID(), message: "Water is leaking", ...body }, deps);
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

  it("returns 404 for an unknown tenant", async () => {
    const { send } = setup([]);
    expect((await send({ tenantId: "tenant_nobody" })).status).toBe(404);
  });
});
