import { describe, expect, it } from "vitest";
import { InMemoryRepository } from "@/infra/memory-repository";
import { executeToolCall } from "@/runtime/executor";
import type { ToolContext } from "@/runtime/types";
import type { AppDeps } from "../deps";
import { maintenanceTools } from "./tools";

// Tool-level checks through the real executor and in-memory repository (no model yet).

// Pass a repo to act as another tenant on the same data.
function setup(tenantId: string, requestId = "req-1", repo = new InMemoryRepository()) {
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
  new_problem: false,
});

const leak = {
  property_id: "prop_mcr_1",
  category: "plumbing",
  hazards: ["active_water_leak"],
  location: "kitchen ceiling",
  description: "Water is leaking from my ceiling",
  new_problem: false,
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

  it("a different problem of the same category, declared new_problem: two tickets, the second an emergency", async () => {
    const { repo, ctx, call } = setup("tenant_olivia", "req-morning");
    await call("create_maintenance_ticket", { ...leak, hazards: [], location: "bathroom", description: "Dripping tap" });
    const afternoon = await call("create_maintenance_ticket", { ...leak, new_problem: true }, { ...ctx, requestId: "req-afternoon" });
    expect(afternoon.result).toMatchObject({ ok: true, data: { duplicate: false, priority: "emergency" } });
    expect(await repo.listTickets("tenant_olivia")).toHaveLength(2);
  });

  it("the same kind of problem in a later request is added to the open ticket, escalating it: no duplicate", async () => {
    const { repo, ctx, call } = setup("tenant_olivia", "req-morning");
    const first = await call("create_maintenance_ticket", { ...leak, hazards: [], description: "Damp patch on the ceiling" });
    const firstId = first.result.ok ? (first.result.data as { ticket_id: string }).ticket_id : "";
    const later = await call("create_maintenance_ticket", leak, { ...ctx, requestId: "req-afternoon" });
    expect(later.result).toMatchObject({
      ok: true,
      data: { ticket_id: firstId, added_to_existing_ticket: true, escalated: true, priority: "emergency", sent_to_human_review: true },
    });
    expect(await repo.listTickets("tenant_olivia")).toHaveLength(1);
    expect((await repo.listTicketUpdates(firstId)).map((u) => u.details)).toEqual(["kitchen ceiling: Water is leaking from my ceiling"]);
  });

  describe("with several open tickets of the same kind", () => {
    async function twoOpenPlumbing() {
      const t = setup("tenant_olivia", "req-tap");
      await t.call("create_maintenance_ticket", { ...leak, hazards: [], location: "bathroom", description: "Dripping tap" });
      await t.call("create_maintenance_ticket", { ...leak, hazards: [], location: "kitchen ceiling", description: "Damp patch", new_problem: true }, { ...t.ctx, requestId: "req-damp" });
      return t;
    }

    it("writes nothing and asks for the ticket when it can't tell which one the tenant means", async () => {
      const { repo, ctx, call } = await twoOpenPlumbing();
      const before = await repo.listTickets("tenant_olivia");
      const out = await call("create_maintenance_ticket", { ...leak, hazards: [], location: null, description: "It's worse" }, { ...ctx, requestId: "req-3" });
      expect(out.result).toMatchObject({ ok: false, stage: "authorize", code: "choose_ticket" });
      expect(await repo.listTickets("tenant_olivia")).toEqual(before);
      for (const t of before) expect(await repo.listTicketUpdates(t.id)).toEqual([]);
    });

    it("an emergency is never held back: it gets its own ticket and a review, the others are untouched", async () => {
      const { repo, ctx, call } = await twoOpenPlumbing();
      const out = await call("create_maintenance_ticket", leak, { ...ctx, requestId: "req-3" });
      expect(out.result).toMatchObject({ ok: true, data: { duplicate: false, priority: "emergency", sent_to_human_review: true } });
      const tickets = await repo.listTickets("tenant_olivia");
      expect(tickets.map((t) => t.priority).sort()).toEqual(["emergency", "normal", "normal"]);
    });
  });

  describe("retries and repeated calls in one request", () => {
    const idOf = (out: { result: { ok: boolean; data?: unknown } }) => (out.result.ok ? (out.result.data as { ticket_id: string }).ticket_id : "");

    it("a second call in the same request that adds a missed gas smell escalates; an identical retry adds nothing", async () => {
      const { repo, ctx, call } = setup("tenant_olivia", "req-open");
      const id = idOf(await call("create_maintenance_ticket", { ...leak, hazards: [], description: "Boiler making noises", category: "heating", location: "kitchen" }));
      const same = { ...ctx, requestId: "req-follow-up" };
      const first = await call("add_details_to_ticket", { ticket_id: id, details: "It's louder", hazards: [] }, same);
      expect(first.result).toMatchObject({ ok: true, data: { escalated: false } });
      const second = await call("add_details_to_ticket", { ticket_id: id, details: "And I can smell gas", hazards: ["gas_smell"] }, same);
      expect(second.result).toMatchObject({ ok: true, data: { escalated: true, priority: "emergency", sent_to_human_review: true } });
      const reviewsBefore = (await repo.listReviews("tenant_olivia")).length;
      const retry = await call("add_details_to_ticket", { ticket_id: id, details: "And I can smell gas", hazards: ["gas_smell"] }, same);
      expect(retry.result).toMatchObject({ ok: true, data: { priority: "emergency", sent_to_human_review: false } });
      expect(await repo.listTicketUpdates(id)).toHaveLength(2);
      // The escalation's review was added once; the identical retry adds none.
      expect((await repo.listReviews("tenant_olivia")).some((r) => r.reason.startsWith("escalated by a repeated report"))).toBe(true);
      expect(await repo.listReviews("tenant_olivia")).toHaveLength(reviewsBefore);
    });

    it("the same through the duplicate guard: a second create in the request with the gas smell escalates", async () => {
      const { repo, ctx, call } = setup("tenant_olivia", "req-open");
      const heating = { ...leak, category: "heating", location: "kitchen", hazards: [] as string[] };
      const id = idOf(await call("create_maintenance_ticket", { ...heating, description: "Boiler making noises" }));
      const same = { ...ctx, requestId: "req-follow-up" };
      await call("create_maintenance_ticket", { ...heating, description: "It's louder" }, same);
      const gas = await call("create_maintenance_ticket", { ...heating, description: "I can smell gas", hazards: ["gas_smell"] }, same);
      expect(gas.result).toMatchObject({ ok: true, data: { ticket_id: id, added_to_existing_ticket: true, escalated: true, priority: "emergency" } });
      expect(await repo.listTickets("tenant_olivia")).toHaveLength(1);
    });

    it("retrying a request that created ticket A returns A, even after B (same kind) was opened", async () => {
      const { repo, ctx, call } = setup("tenant_olivia", "req-a");
      const tap = { ...leak, hazards: [], location: "bathroom", description: "Dripping tap" };
      const a = idOf(await call("create_maintenance_ticket", tap));
      const b = idOf(await call("create_maintenance_ticket", { ...leak, hazards: [], description: "Damp patch", new_problem: true }, { ...ctx, requestId: "req-b" }));
      const retry = await call("create_maintenance_ticket", tap, { ...ctx, requestId: "req-a" });
      expect(retry.result).toMatchObject({ ok: true, data: { ticket_id: a, duplicate: true } });
      expect(await repo.listTicketUpdates(b)).toEqual([]);
      expect(await repo.listTickets("tenant_olivia")).toHaveLength(2);
    });

    it("a request that added to A and then created B: retrying the first call returns A, not B", async () => {
      const { repo, ctx, call } = setup("tenant_olivia", "req-a");
      const a = idOf(await call("create_maintenance_ticket", { ...leak, hazards: [], location: "bathroom", description: "Dripping tap" }));
      const r = { ...ctx, requestId: "req-r" };
      const first = { ...leak, hazards: [], location: "bathroom", description: "Still dripping" };
      expect((await call("create_maintenance_ticket", first, r)).result).toMatchObject({ ok: true, data: { ticket_id: a, added_to_existing_ticket: true } });
      const b = idOf(await call("create_maintenance_ticket", { ...leak, hazards: [], description: "Damp patch", new_problem: true }, r));
      expect(b).not.toBe(a);
      const retry = await call("create_maintenance_ticket", first, r);
      expect(retry.result).toMatchObject({ ok: true, data: { ticket_id: a, added_to_existing_ticket: true } });
      expect(await repo.listTicketUpdates(b)).toEqual([]);
      expect(await repo.listTicketUpdates(a)).toHaveLength(1);
    });

    it("retrying a report the guard added to A returns A again, even after B (same kind) was opened", async () => {
      const { repo, ctx, call } = setup("tenant_olivia", "req-a");
      const a = idOf(await call("create_maintenance_ticket", { ...leak, hazards: [], location: "bathroom", description: "Dripping tap" }));
      const again = { ...leak, hazards: [], location: "bathroom", description: "Still dripping" };
      const redirected = await call("create_maintenance_ticket", again, { ...ctx, requestId: "req-r" });
      expect(redirected.result).toMatchObject({ ok: true, data: { ticket_id: a, added_to_existing_ticket: true } });
      const b = idOf(await call("create_maintenance_ticket", { ...leak, hazards: [], description: "Damp patch", new_problem: true }, { ...ctx, requestId: "req-b" }));
      // Two open plumbing tickets now: without the lookup this would be "choose_ticket" or go to B.
      const retry = await call("create_maintenance_ticket", again, { ...ctx, requestId: "req-r" });
      expect(retry.result).toMatchObject({ ok: true, data: { ticket_id: a, added_to_existing_ticket: true } });
      expect(await repo.listTicketUpdates(a)).toHaveLength(1);
      expect(await repo.listTicketUpdates(b)).toEqual([]);
    });
  });

  it("get_property_context lists only the tenant's own open tickets", async () => {
    const { repo, call } = setup("tenant_olivia");
    const mine = await call("create_maintenance_ticket", leak);
    const mineId = mine.result.ok ? (mine.result.data as { ticket_id: string }).ticket_id : "";
    const closed = await call("create_maintenance_ticket", dishwasher("prop_mcr_1"));
    repo.closeTicket(closed.result.ok ? (closed.result.data as { ticket_id: string }).ticket_id : "");
    await setup("tenant_james", "req-james", repo).call("create_maintenance_ticket", { ...leak, property_id: "prop_lds_1" });
    const out = await call("get_property_context", {});
    const open = out.result.ok ? (out.result.data as { open_tickets: { ticket_id: string }[] }).open_tickets : [];
    expect(open.map((t) => t.ticket_id)).toEqual([mineId]);
  });

  describe("add_details_to_ticket", () => {
    it("adds details to the tenant's open ticket; new hazards can raise it, never lower it", async () => {
      const { repo, ctx, call } = setup("tenant_olivia", "req-1");
      const created = await call("create_maintenance_ticket", { ...leak, hazards: [], description: "Damp patch" });
      const id = created.result.ok ? (created.result.data as { ticket_id: string }).ticket_id : "";
      const out = await call(
        "add_details_to_ticket",
        { ticket_id: id, details: "Now it's pouring", hazards: ["active_water_leak"] },
        { ...ctx, requestId: "req-2" },
      );
      expect(out.result).toMatchObject({ ok: true, data: { ticket_id: id, added_to_existing_ticket: true, escalated: true, priority: "emergency" } });
      const calmer = await call("add_details_to_ticket", { ticket_id: id, details: "It stopped", hazards: [] }, { ...ctx, requestId: "req-3" });
      expect(calmer.result).toMatchObject({ ok: true, data: { escalated: false, priority: "emergency" } });
      expect(await repo.listTickets("tenant_olivia")).toHaveLength(1);
    });

    it("rejects another tenant's ticket at authorize, like a missing one", async () => {
      const { repo, call } = setup("tenant_james");
      const theirs = await setup("tenant_olivia", "req-o", repo).call("create_maintenance_ticket", leak);
      const id = theirs.result.ok ? (theirs.result.data as { ticket_id: string }).ticket_id : "";
      const out = await call("add_details_to_ticket", { ticket_id: id, details: "Still leaking", hazards: [] });
      expect(out.result).toMatchObject({ ok: false, stage: "authorize", code: "ticket_not_found" });
      expect(await repo.listTicketUpdates(id)).toEqual([]);
    });

    it("rejects a closed ticket at authorize: the problem needs a new ticket", async () => {
      const { repo, call } = setup("tenant_olivia");
      const created = await call("create_maintenance_ticket", leak);
      const id = created.result.ok ? (created.result.data as { ticket_id: string }).ticket_id : "";
      repo.closeTicket(id);
      const out = await call("add_details_to_ticket", { ticket_id: id, details: "It's back", hazards: [] });
      expect(out.result).toMatchObject({ ok: false, stage: "authorize", code: "ticket_closed" });
    });
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
