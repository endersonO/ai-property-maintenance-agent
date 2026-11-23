import { describe, expect, it } from "vitest";
import type { NewTicket, Repository } from "./repository";

// Shared behaviour every Repository implementation must satisfy.
// `setup` returns a fresh, seeded repository and a run id that exists in it.

export function repositoryContract(
  name: string,
  // `close` resolves a ticket the way the agency would (outside the agent's tools).
  setup: () => Promise<{ repo: Repository; runId: string; close: (ticketId: string) => Promise<void> }>,
) {
  const ticket = (runId: string, overrides: Partial<NewTicket> = {}): NewTicket => ({
    agencyId: "agency_northbridge",
    propertyId: "prop_mcr_1",
    tenantId: "tenant_olivia",
    runId,
    category: "plumbing",
    hazards: ["active_water_leak"],
    location: "kitchen ceiling",
    description: "Water leaking from the ceiling",
    priority: "emergency",
    estimatedCostGbp: 180,
    policyVersion: 1,
    idempotencyKey: "key-1",
    ...overrides,
  });

  describe(`${name}: Repository contract`, () => {
    it("returns tenant context with property and agency", async () => {
      const { repo } = await setup();
      const ctx = await repo.getTenantContext("tenant_olivia");
      expect(ctx?.property.id).toBe("prop_mcr_1");
      expect(ctx?.agency.id).toBe("agency_northbridge");
      expect(await repo.getTenantContext("tenant_nobody")).toBeNull();
    });

    it("returns the active policy for an agency", async () => {
      const { repo } = await setup();
      const active = await repo.getActivePolicy("agency_harbour_lane");
      expect(active?.version).toBe(1);
      expect(active?.policy.reviewAboveGbp).toBe(0);
    });

    it("creates a ticket together with its review", async () => {
      const { repo, runId } = await setup();
      const result = await repo.createTicketWithReview(ticket(runId), {
        runId,
        agencyId: "agency_northbridge",
        tenantId: "tenant_olivia",
        source: "policy",
        reason: "emergency",
      });
      expect(result.duplicate).toBe(false);
      expect(result.review?.ticketId).toBe(result.ticket.id);
      expect(await repo.listTickets("tenant_olivia")).toHaveLength(1);
      expect(await repo.listReviews("tenant_olivia")).toHaveLength(1);
    });

    it("returns the existing ticket for a repeated idempotency key and writes nothing", async () => {
      const { repo, runId } = await setup();
      const review = {
        runId,
        agencyId: "agency_northbridge",
        tenantId: "tenant_olivia",
        source: "policy" as const,
        reason: "emergency",
      };
      const first = await repo.createTicketWithReview(ticket(runId), review);
      const second = await repo.createTicketWithReview(ticket(runId), review);
      expect(second.duplicate).toBe(true);
      expect(second.ticket.id).toBe(first.ticket.id);
      expect(await repo.listTickets("tenant_olivia")).toHaveLength(1);
      expect(await repo.listReviews("tenant_olivia")).toHaveLength(1);
    });

    it("escalates the existing ticket when a repeat is more severe, atomically with its review", async () => {
      const { repo, runId } = await setup();
      const review = {
        runId,
        agencyId: "agency_northbridge",
        tenantId: "tenant_olivia",
        source: "policy" as const,
        reason: "emergencies always require human review",
      };
      const first = await repo.createTicketWithReview(ticket(runId, { priority: "normal", hazards: [] }), null);
      const second = await repo.createTicketWithReview(ticket(runId), review);
      expect(second).toMatchObject({ duplicate: true, escalated: true });
      expect(second.ticket).toMatchObject({ id: first.ticket.id, priority: "emergency", hazards: ["active_water_leak"] });
      expect(second.review?.ticketId).toBe(first.ticket.id);
      expect(await repo.listTickets("tenant_olivia")).toHaveLength(1);
      expect(await repo.listReviews("tenant_olivia")).toHaveLength(1);
    });

    it("keeps separate requests as separate tickets", async () => {
      const { repo, runId } = await setup();
      await repo.createTicketWithReview(ticket(runId, { idempotencyKey: "key-1" }), null);
      await repo.createTicketWithReview(
        ticket(runId, { idempotencyKey: "key-2", category: "appliance", hazards: [] }),
        null,
      );
      const tickets = await repo.listTickets("tenant_olivia");
      expect(tickets.map((t) => t.hazards).sort()).toEqual([[], ["active_water_leak"]]);
    });

    it("creates a review without a ticket", async () => {
      const { repo, runId } = await setup();
      const review = await repo.createReview({
        runId,
        agencyId: "agency_northbridge",
        tenantId: "tenant_olivia",
        ticketId: null,
        source: "agent",
        reason: "unsure whether this is an emergency",
      });
      expect(review.status).toBe("pending");
      expect(await repo.listReviews("tenant_olivia")).toHaveLength(1);
    });

    it("returns null for an unknown or malformed ticket id", async () => {
      const { repo } = await setup();
      expect(await repo.getTicket("00000000-0000-0000-0000-000000000000")).toBeNull();
      expect(await repo.getTicket("not-a-uuid")).toBeNull();
    });
  
    describe("details added to an open ticket", () => {
      const reviewFor = (runId: string) => ({
        runId,
        agencyId: "agency_northbridge",
        tenantId: "tenant_olivia",
        source: "policy" as const,
        reason: "emergency",
      });
      const update = (runId: string, ticketId: string, key = "u-1") => ({
        ticketId,
        runId,
        tenantId: "tenant_olivia",
        details: "It's still leaking",
        hazards: [] as NewTicket["hazards"],
        idempotencyKey: key,
      });
      const open = async (repo: Repository, runId: string) =>
        (await repo.createTicketWithReview(ticket(runId, { priority: "normal", hazards: [] }), null)).ticket;

      it("records the details on the same ticket: no new ticket, no change when not more severe", async () => {
        const { repo, runId } = await setup();
        const t = await open(repo, runId);
        const result = await repo.addTicketUpdate(update(runId, t.id), { priority: "low", hazards: [] }, null);
        expect([result.duplicate, result.escalated, result.ticket.priority, result.review]).toEqual([false, false, "normal", null]);
        expect(await repo.listTickets("tenant_olivia")).toHaveLength(1);
        expect((await repo.listTicketUpdates(t.id)).map((u) => [u.details, u.raisedPriority])).toEqual([["It's still leaking", false]]);
      });

      it("a more severe update escalates the ticket and adds the review the policy requires", async () => {
        const { repo, runId } = await setup();
        const t = await open(repo, runId);
        const result = await repo.addTicketUpdate(
          { ...update(runId, t.id), hazards: ["active_water_leak"] },
          { priority: "emergency", hazards: ["active_water_leak"] },
          reviewFor(runId),
        );
        expect([result.escalated, result.ticket.priority, result.ticket.hazards]).toEqual([true, "emergency", ["active_water_leak"]]);
        expect(result.review?.ticketId).toBe(t.id);
        expect(result.review?.reason).toMatch(/^escalated by a repeated report/);
        expect((await repo.getTicket(t.id))?.priority).toBe("emergency");
        expect((await repo.listTicketUpdates(t.id))[0].raisedPriority).toBe(true);
      });

      it("a retry of the same request adds the details once", async () => {
        const { repo, runId } = await setup();
        const t = await open(repo, runId);
        const escalate = { priority: "emergency" as const, hazards: ["active_water_leak" as const] };
        await repo.addTicketUpdate(update(runId, t.id), escalate, reviewFor(runId));
        const again = await repo.addTicketUpdate(update(runId, t.id), escalate, reviewFor(runId));
        expect([again.duplicate, again.escalated, again.review]).toEqual([true, false, null]);
        expect(await repo.listTicketUpdates(t.id)).toHaveLength(1);
        expect(await repo.listReviews("tenant_olivia")).toHaveLength(1);
      });

      it("a new hazard is kept on the ticket even when the priority is already the highest", async () => {
        const { repo, runId } = await setup();
        const { ticket: t } = await repo.createTicketWithReview(ticket(runId), null); // emergency, active_water_leak
        const result = await repo.addTicketUpdate(
          { ...update(runId, t.id), details: "I can smell gas too", hazards: ["gas_smell"] },
          { priority: "emergency", hazards: ["active_water_leak", "gas_smell"] },
          null,
        );
        expect([result.escalated, result.ticket.priority]).toEqual([false, "emergency"]);
        expect((await repo.getTicket(t.id))?.hazards.sort()).toEqual(["active_water_leak", "gas_smell"]);
        expect((await repo.listTicketUpdates(t.id))[0].raisedPriority).toBe(false);
      });

      it("a repeated create with a new hazard keeps it too, without counting as an escalation", async () => {
        const { repo, runId } = await setup();
        await repo.createTicketWithReview(ticket(runId), null);
        const again = await repo.createTicketWithReview(ticket(runId, { hazards: ["gas_smell"] }), null);
        expect([again.duplicate, again.duplicate && again.escalated]).toEqual([true, false]);
        expect(again.ticket.hazards.sort()).toEqual(["active_water_leak", "gas_smell"]);
      });

      it("never records an update for a tenant who doesn't own the ticket", async () => {
        const { repo, runId } = await setup();
        const t = await open(repo, runId);
        await expect(
          repo.addTicketUpdate(
            { ...update(runId, t.id), tenantId: "tenant_james" },
            { priority: "emergency", hazards: ["active_water_leak"] },
            null,
          ),
        ).rejects.toThrow(/does not belong/);
        expect(await repo.listTicketUpdates(t.id)).toEqual([]);
        expect((await repo.getTicket(t.id))?.priority).toBe("normal");
      });

      it("an idempotency key reused for another ticket is a conflict, not a duplicate", async () => {
        const { repo, runId } = await setup();
        const a = await open(repo, runId);
        const { ticket: b } = await repo.createTicketWithReview(
          ticket(runId, { idempotencyKey: "key-2", category: "appliance", hazards: [], priority: "normal" }),
          null,
        );
        await repo.addTicketUpdate(update(runId, a.id, "same-key"), { priority: "normal", hazards: [] }, null);
        await expect(repo.addTicketUpdate(update(runId, b.id, "same-key"), { priority: "normal", hazards: [] }, null)).rejects.toThrow(
          /another ticket update/,
        );
        expect(await repo.listTicketUpdates(b.id)).toEqual([]);
      });

      it("accepts the longest details the tools can send (a 200-character location and a 2000-character description)", async () => {
        const { repo, runId } = await setup();
        const t = await open(repo, runId);
        const details = `${"l".repeat(200)}: ${"d".repeat(2000)}`;
        await repo.addTicketUpdate({ ...update(runId, t.id), details }, { priority: "normal", hazards: [] }, null);
        expect((await repo.listTicketUpdates(t.id))[0].details).toHaveLength(2202);
      });

      it("finds an update by its idempotency key, and null for an unknown key", async () => {
        const { repo, runId } = await setup();
        const t = await open(repo, runId);
        await repo.addTicketUpdate(update(runId, t.id, "find-me"), { priority: "normal", hazards: [] }, null);
        expect((await repo.findTicketUpdateByKey("find-me"))?.ticketId).toBe(t.id);
        expect(await repo.findTicketUpdateByKey("nope")).toBeNull();
      });

      it("refuses a closed ticket and writes nothing", async () => {
        const { repo, runId, close } = await setup();
        const t = await open(repo, runId);
        await close(t.id);
        await expect(
          repo.addTicketUpdate(update(runId, t.id), { priority: "emergency", hazards: ["active_water_leak"] }, reviewFor(runId)),
        ).rejects.toThrow(/resolved/);
        expect(await repo.listTicketUpdates(t.id)).toEqual([]);
        expect(await repo.listReviews("tenant_olivia")).toEqual([]);
        expect((await repo.getTicket(t.id))?.priority).toBe("normal");
      });
    });
  });
}
