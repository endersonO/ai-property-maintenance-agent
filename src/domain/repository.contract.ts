import { describe, expect, it } from "vitest";
import type { NewTicket, Repository } from "./repository";

// Shared behaviour every Repository implementation must satisfy.
// `setup` returns a fresh, seeded repository and a run id that exists in it.

export function repositoryContract(
  name: string,
  setup: () => Promise<{ repo: Repository; runId: string }>,
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
  });
}
