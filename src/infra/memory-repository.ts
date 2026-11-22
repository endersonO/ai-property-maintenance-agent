import { randomUUID } from "node:crypto";
import type {
  ActivePolicy,
  CreateTicketResult,
  NewReview,
  NewTicket,
  Repository,
  Review,
  TenantContext,
  Ticket,
} from "@/domain/repository";
import * as seed from "./seed-data";

// In-memory implementation for evals and unit tests. Same contract as PostgresRepository.
// JavaScript runs each method body without interleaving until an `await`, and these
// methods never await between check and write, so uniqueness and atomicity hold.

export type MemoryFault = "review_insert";

export class InMemoryRepository implements Repository {
  private tickets = new Map<string, Ticket>();
  private ticketsByKey = new Map<string, string>();
  private reviews = new Map<string, Review>();
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
      return { duplicate: true, ticket: this.tickets.get(existingId)!, review: null };
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
