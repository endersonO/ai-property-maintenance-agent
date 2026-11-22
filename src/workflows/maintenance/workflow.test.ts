import { describe, expect, it } from "vitest";
import { InMemoryRepository } from "@/infra/memory-repository";
import { ScriptedModel } from "@/runtime/model";
import { runAgent } from "@/runtime/orchestrator";
import { maintenanceWorkflow } from ".";

// A full run of the maintenance workflow: scripted model → orchestrator → executor → repository.

describe("maintenance workflow run", () => {
  it("Olivia reports a ceiling leak: emergency ticket, forced review, grounded reply", async () => {
    const repo = new InMemoryRepository();
    const model = new ScriptedModel([
      { toolCalls: [{ name: "get_property_context", args: {} }] },
      {
        toolCalls: [
          {
            name: "create_maintenance_ticket",
            args: {
              property_id: "prop_mcr_1",
              category: "plumbing",
              hazards: ["active_water_leak"],
              location: "kitchen ceiling",
              description: "Water is leaking from my ceiling",
            },
          },
        ],
      },
      { text: "I've logged an emergency ticket and a member of the agency will review it." },
    ]);

    const result = await runAgent({
      workflow: maintenanceWorkflow,
      model,
      deps: { repo },
      actorId: "tenant_olivia",
      requestId: "req-1",
      userMessage: "Water is leaking from my ceiling. Please help!",
    });

    expect(result.status).toBe("completed");
    expect(result.events.map((e) => (e.type === "tool_call" ? `${e.toolName}:${e.status}` : e.type))).toEqual([
      "model_call",
      "get_property_context:ok",
      "model_call",
      "create_maintenance_ticket:ok",
      "model_call",
    ]);

    const [ticket] = await repo.listTickets("tenant_olivia");
    expect(ticket).toMatchObject({ priority: "emergency", runId: result.runId });
    expect(await repo.listReviews("tenant_olivia")).toHaveLength(1);

    // The final answer was written after seeing the real tool result.
    const lastSeen = model.seen[2].at(-1);
    expect(lastSeen).toMatchObject({ role: "tool", name: "create_maintenance_ticket" });
    expect(JSON.parse((lastSeen as { content: string }).content)).toMatchObject({
      ok: true,
      data: { priority: "emergency", sent_to_human_review: true },
    });
  });

  it("exposes the tool schemas to the model without a priority field", async () => {
    const model = new ScriptedModel([{ text: "Hello" }]);
    await runAgent({
      workflow: maintenanceWorkflow,
      model,
      deps: { repo: new InMemoryRepository() },
      actorId: "tenant_olivia",
      requestId: "req-1",
      userMessage: "hi",
    });

    const tools = model.seenTools[0];
    const create = tools.find((t) => t.name === "create_maintenance_ticket")!;
    expect(Object.keys(create.parameters.properties as object)).not.toContain("priority");
    expect(create.parameters.additionalProperties).toBe(false);
  });
});
