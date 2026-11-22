import { describe, expect, it } from "vitest";
import { InMemoryRepository } from "@/infra/memory-repository";
import { executeToolCall } from "@/runtime/executor";
import type { ToolContext } from "@/runtime/types";
import type { AppDeps } from "../deps";
import { maintenanceTools } from "./tools";

// Tool-level checks through the real executor and in-memory repository (no model yet).

function setup(tenantId: string, requestId = "req-1") {
  const repo = new InMemoryRepository();
  const ctx: ToolContext<AppDeps> = { runId: "run-1", requestId, actorId: tenantId, deps: { repo } };
  const call = (name: string, args: unknown, c = ctx) => executeToolCall(maintenanceTools, { name, args }, c);
  return { repo, ctx, call };
}

const dishwasher = (propertyId: string) => ({
  property_id: propertyId,
  category: "appliance",
  hazards: [],
  location: "kitchen",
  description: "My dishwasher stopped working",
});

const leak = {
  property_id: "prop_mcr_1",
  category: "plumbing",
  hazards: ["active_water_leak"],
  location: "kitchen ceiling",
  description: "Water is leaking from my ceiling",
};

describe("create_maintenance_ticket", () => {
  it("routine fault at Northbridge: normal priority, no review", async () => {
    const { repo, call } = setup("tenant_olivia");
    const out = await call("create_maintenance_ticket", dishwasher("prop_mcr_1"));
    expect(out.result).toMatchObject({
      ok: true,
      data: { priority: "normal", estimated_cost_gbp: 120, sent_to_human_review: false },
    });
    expect(await repo.listReviews("tenant_olivia")).toHaveLength(0);
  });

  it("same fault at Harbour Lane: routed to human review", async () => {
    const { repo, call } = setup("tenant_priya");
    const out = await call("create_maintenance_ticket", dishwasher("prop_bri_1"));
    expect(out.result).toMatchObject({ ok: true, data: { priority: "normal", sent_to_human_review: true } });
    const [review] = await repo.listReviews("tenant_priya");
    expect(review).toMatchObject({ source: "policy", agencyId: "agency_harbour_lane" });
  });

  it("leak: emergency, review forced by policy, linked to the ticket", async () => {
    const { repo, call } = setup("tenant_olivia");
    const out = await call("create_maintenance_ticket", leak);
    expect(out.result).toMatchObject({ ok: true, data: { priority: "emergency", sent_to_human_review: true } });
    const [ticket] = await repo.listTickets("tenant_olivia");
    const [review] = await repo.listReviews("tenant_olivia");
    expect(review).toMatchObject({ source: "policy", ticketId: ticket.id, runId: "run-1" });
    expect(ticket.policyVersion).toBe(1);
  });

  it("rejects a ticket on another tenant's property at authorize", async () => {
    const { repo, call } = setup("tenant_olivia");
    const out = await call("create_maintenance_ticket", dishwasher("prop_lds_1"));
    expect(out.result).toMatchObject({ ok: false, stage: "authorize", code: "property_not_authorized" });
    expect(await repo.listTickets("tenant_olivia")).toHaveLength(0);
    expect(await repo.listTickets("tenant_james")).toHaveLength(0);
  });

  it("the same request twice creates one ticket", async () => {
    const { repo, call } = setup("tenant_olivia");
    await call("create_maintenance_ticket", leak);
    const second = await call("create_maintenance_ticket", leak);
    expect(second.result).toMatchObject({ ok: true, data: { duplicate: true } });
    expect(await repo.listTickets("tenant_olivia")).toHaveLength(1);
    expect(await repo.listReviews("tenant_olivia")).toHaveLength(1);
  });

  it("a more severe repeat of the same request escalates the ticket instead of being swallowed", async () => {
    const { repo, call } = setup("tenant_olivia");
    // The model first misses the leak, then reports it within the same request.
    const routine = await call("create_maintenance_ticket", { ...leak, hazards: [] });
    expect(routine.result).toMatchObject({ ok: true, data: { priority: "normal", sent_to_human_review: false } });
    const escalated = await call("create_maintenance_ticket", leak);
    expect(escalated.result).toMatchObject({
      ok: true,
      data: { duplicate: true, escalated: true, priority: "emergency", sent_to_human_review: true },
    });

    const [ticket] = await repo.listTickets("tenant_olivia");
    expect(ticket).toMatchObject({ priority: "emergency", hazards: ["active_water_leak"] });
    expect(await repo.listTickets("tenant_olivia")).toHaveLength(1);
    const [review] = await repo.listReviews("tenant_olivia");
    expect(review).toMatchObject({ ticketId: ticket.id, reason: expect.stringContaining("escalated") });
  });

  it("a less severe repeat never downgrades the ticket", async () => {
    const { repo, call } = setup("tenant_olivia");
    await call("create_maintenance_ticket", leak);
    const repeat = await call("create_maintenance_ticket", { ...leak, hazards: [] });
    expect(repeat.result).toMatchObject({ ok: true, data: { duplicate: true, escalated: false, priority: "emergency" } });
    expect(await repo.listReviews("tenant_olivia")).toHaveLength(1);
  });

  it("separate requests, same category, same day: two tickets, the second an emergency", async () => {
    const { repo, ctx, call } = setup("tenant_olivia", "req-morning");
    await call("create_maintenance_ticket", {
      ...leak,
      hazards: [],
      location: "bathroom",
      description: "Dripping tap",
    });
    const afternoon = await call("create_maintenance_ticket", leak, { ...ctx, requestId: "req-afternoon" });
    expect(afternoon.result).toMatchObject({ ok: true, data: { duplicate: false, priority: "emergency" } });
    expect(await repo.listTickets("tenant_olivia")).toHaveLength(2);
  });

  it.each([
    ["unknown hazard", { ...leak, hazards: ["fire"] }],
    ["missing description", { ...leak, description: "" }],
    ["invented priority", { ...leak, priority: "low" }],
  ])("rejects %s at validate", async (_label, args) => {
    const { repo, call } = setup("tenant_olivia");
    const out = await call("create_maintenance_ticket", args);
    expect(out.result).toMatchObject({ ok: false, stage: "validate" });
    expect(await repo.listTickets("tenant_olivia")).toHaveLength(0);
  });

  it("a failing review insert leaves no ticket and reports a generic error", async () => {
    const { repo, call } = setup("tenant_olivia");
    repo.injectFault("review_insert");
    const out = await call("create_maintenance_ticket", leak);
    expect(out.status).toBe("error");
    expect(out.result).toMatchObject({ ok: false, stage: "execute", code: "internal_error" });
    expect(await repo.listTickets("tenant_olivia")).toHaveLength(0);
  });
});

describe("request_human_review", () => {
  it("creates an agent review owned by the tenant and agency, without a ticket", async () => {
    const { repo, call } = setup("tenant_olivia");
    const out = await call("request_human_review", { reason: "Unsure if urgent", ticket_id: null });
    expect(out.result).toMatchObject({ ok: true });
    const [review] = await repo.listReviews("tenant_olivia");
    expect(review).toMatchObject({ source: "agent", agencyId: "agency_northbridge", ticketId: null });
  });

  it("does not reveal another tenant's ticket", async () => {
    const james = setup("tenant_james");
    const created = await james.call("create_maintenance_ticket", dishwasher("prop_lds_1"));
    const ticketId = (created.result as { data: { ticket_id: string } }).data.ticket_id;

    const olivia = { ...james.ctx, actorId: "tenant_olivia" };
    const out = await james.call("request_human_review", { reason: "x", ticket_id: ticketId }, olivia);
    expect(out.result).toMatchObject({ ok: false, stage: "authorize", code: "ticket_not_found" });
  });
});

describe("read-only tools", () => {
  it("get_property_context returns the session tenant's property", async () => {
    const { call } = setup("tenant_priya");
    const out = await call("get_property_context", {});
    expect(out.result).toMatchObject({ ok: true, data: { property: { id: "prop_bri_1" } } });
  });

  it("get_maintenance_policy returns the agency's active policy", async () => {
    const { call } = setup("tenant_priya");
    const out = await call("get_maintenance_policy", {});
    expect(out.result).toMatchObject({ ok: true, data: { agency: "Harbour Lane Estates", version: 1 } });
  });
});
