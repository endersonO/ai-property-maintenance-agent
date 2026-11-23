import { randomUUID } from "node:crypto";
import type {
  ActivePolicy,
  AddUpdateResult,
  CreateTicketResult,
  NewTicketUpdate,
  TicketUpdate,
  NewReview,
  NewTicket,
  Repository,
  Review,
  TenantContext,
  Ticket,
} from "@/domain/repository";
import { planDuplicate } from "@/domain/repository";
import * as seed from "./seed-data";

// In-memory implementation for evals and unit tests. Same contract as PostgresRepository.
// JavaScript runs each method body without interleaving until an `await`, and these
// methods never await between check and write, so uniqueness and atomicity hold.

export type MemoryFault = "review_insert";

export class InMemoryRepository implements Repository {
  private tickets = new Map<string, Ticket>();
  private ticketsByKey = new Map<string, string>();
  private reviews = new Map<string, Review>();
  private updates = new Map<string, TicketUpdate>(); // by idempotency key
  private faults = new Set<MemoryFault>();

  // Make the next writes fail at a given point, to test that nothing partial persists.
  injectFault(fault: MemoryFault) {
    this.faults.add(fault);
  }

  async getTenantContext(tenantId: string): Promise<TenantContext | null> {
    const tenant = seed.tenants.find((t) => t.id === tenantId);
    if (!tenant) return null;
    const property = seed.properties.find((p) => p.id === tenant.propertyId)!;
    const agency = seed.agencies.find((a) => a.id === property.agencyId)!;
    return {
      tenant: { id: tenant.id, name: tenant.name },
      property: {
        id: property.id,
        address: property.address,
        city: property.city,
        postcode: property.postcode,
      },
      agency: { id: agency.id, name: agency.name },
    };
  }

  async getActivePolicy(agencyId: string): Promise<ActivePolicy | null> {
    return seed.policies.find((p) => p.agencyId === agencyId) ?? null;
  }

  async createTicketWithReview(
    newTicket: NewTicket,
    newReview: Omit<NewReview, "ticketId"> | null,
  ): Promise<CreateTicketResult> {
    const existingId = this.ticketsByKey.get(newTicket.idempotencyKey);
    if (existingId) {
      const existing = this.tickets.get(existingId)!;
      const hasReview = [...this.reviews.values()].some((r) => r.ticketId === existingId);
      const plan = planDuplicate(existing, newTicket, newReview, hasReview);
      const added: Review | null = plan.review && {
        ...plan.review,
        ticketId: existingId,
        id: randomUUID(),
        status: "pending",
        createdAt: new Date(),
      };
      if (added && this.faults.has("review_insert")) {
        throw new Error("Injected fault: review insert failed");
      }
      const ticket = plan.update ? { ...existing, ...plan.update } : existing;
      this.tickets.set(existingId, ticket);
      if (added) this.reviews.set(added.id, added);
      return { duplicate: true, ticket, review: added, escalated: plan.raised };
    }

    // Build everything first, commit at the end: a fault leaves no partial state.
    const ticket: Ticket = { ...newTicket, id: randomUUID(), status: "open", createdAt: new Date() };
    const review: Review | null = newReview && {
      ...newReview,
      ticketId: ticket.id,
      id: randomUUID(),
      status: "pending",
      createdAt: new Date(),
    };
    if (review && this.faults.has("review_insert")) {
      throw new Error("Injected fault: review insert failed");
    }

    this.tickets.set(ticket.id, ticket);
    this.ticketsByKey.set(ticket.idempotencyKey, ticket.id);
    if (review) this.reviews.set(review.id, review);
    return { duplicate: false, ticket, review };
  }

  async addTicketUpdate(
    newUpdate: NewTicketUpdate,
    incoming: Pick<NewTicket, "priority" | "hazards">,
    newReview: Omit<NewReview, "ticketId"> | null,
  ): Promise<AddUpdateResult> {
    const existing = this.tickets.get(newUpdate.ticketId);
    if (!existing) throw new Error(`Ticket ${newUpdate.ticketId} not found`);
    // The caller's tenant must own the ticket: an update is never recorded on someone else's.
    if (existing.tenantId !== newUpdate.tenantId) throw new Error(`Ticket ${existing.id} does not belong to ${newUpdate.tenantId}`);
    const repeated = this.updates.get(newUpdate.idempotencyKey);
    if (repeated) {
      // A key reused for a different ticket or tenant is a conflict, never a confirmation.
      if (repeated.ticketId !== newUpdate.ticketId || repeated.tenantId !== newUpdate.tenantId) {
        throw new Error(`Idempotency key already used for another ticket update`);
      }
      return { duplicate: true, ticket: existing, update: repeated, review: null, escalated: false };
    }
    if (existing.status === "resolved" || existing.status === "cancelled") {
      throw new Error(`Ticket ${existing.id} is ${existing.status}`);
    }
    const hasReview = [...this.reviews.values()].some((r) => r.ticketId === existing.id);
    const plan = planDuplicate(existing, incoming, newReview, hasReview);
    // Build everything first, commit at the end: a fault leaves no partial state.
    const review: Review | null = plan.review && {
      ...plan.review,
      ticketId: existing.id,
      id: randomUUID(),
      status: "pending",
      createdAt: new Date(),
    };
    if (review && this.faults.has("review_insert")) {
      throw new Error("Injected fault: review insert failed");
    }
    const update: TicketUpdate = { ...newUpdate, id: randomUUID(), raisedPriority: plan.raised, createdAt: new Date() };
    const ticket = plan.update ? { ...existing, ...plan.update } : existing;
    this.tickets.set(existing.id, ticket);
    this.updates.set(update.idempotencyKey, update);
    if (review) this.reviews.set(review.id, review);
    return { duplicate: false, ticket, update, review, escalated: plan.raised };
  }

  async listTicketUpdates(ticketId: string): Promise<TicketUpdate[]> {
    return [...this.updates.values()]
      .filter((u) => u.ticketId === ticketId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  async findTicketUpdateByKey(idempotencyKey: string): Promise<TicketUpdate | null> {
    return this.updates.get(idempotencyKey) ?? null;
  }

  // Test hook: a ticket resolved by the agency.
  closeTicket(ticketId: string, status: "resolved" | "cancelled" = "resolved") {
    const ticket = this.tickets.get(ticketId);
    if (ticket) this.tickets.set(ticketId, { ...ticket, status });
  }

  async createReview(newReview: NewReview): Promise<Review> {
    if (this.faults.has("review_insert")) {
      throw new Error("Injected fault: review insert failed");
    }
    const review: Review = { ...newReview, id: randomUUID(), status: "pending", createdAt: new Date() };
    this.reviews.set(review.id, review);
    return review;
  }

  async getTicket(ticketId: string): Promise<Ticket | null> {
    return this.tickets.get(ticketId) ?? null;
  }

  async listTickets(tenantId: string): Promise<Ticket[]> {
    return [...this.tickets.values()]
      .filter((t) => t.tenantId === tenantId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  async listReviews(tenantId: string): Promise<Review[]> {
    return [...this.reviews.values()].filter((r) => r.tenantId === tenantId);
  }
}
