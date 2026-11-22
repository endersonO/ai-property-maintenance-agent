import type { Category, Hazard, Priority, TicketStatus } from "./enums";
import type { Policy } from "./policy";

// Port used by the tools. Implemented in memory (evals) and on PostgreSQL (app).
// Both must pass the same contract suite in repository.contract.ts.

export type TenantContext = {
  tenant: { id: string; name: string };
  property: { id: string; address: string; city: string; postcode: string };
  agency: { id: string; name: string };
};

export type ActivePolicy = { agencyId: string; version: number; policy: Policy };

export type NewTicket = {
  agencyId: string;
  propertyId: string;
  tenantId: string;
  runId: string;
  category: Category;
  hazards: Hazard[];
  location: string | null;
  description: string;
  priority: Priority;
  estimatedCostGbp: number;
  policyVersion: number;
  idempotencyKey: string;
};

export type Ticket = NewTicket & { id: string; status: TicketStatus; createdAt: Date };

export type NewReview = {
  runId: string;
  agencyId: string;
  tenantId: string;
  ticketId: string | null;
  source: "policy" | "agent";
  reason: string;
};

export type Review = NewReview & {
  id: string;
  status: "pending" | "approved" | "rejected";
  createdAt: Date;
};

export type CreateTicketResult =
  | { duplicate: false; ticket: Ticket; review: Review | null }
  // Same idempotency key: the existing ticket is returned and nothing is written.
  | { duplicate: true; ticket: Ticket; review: null };

export interface Repository {
  getTenantContext(tenantId: string): Promise<TenantContext | null>;
  getActivePolicy(agencyId: string): Promise<ActivePolicy | null>;
  // Atomic: the ticket and its review are both written, or neither is.
  createTicketWithReview(
    ticket: NewTicket,
    review: Omit<NewReview, "ticketId"> | null,
  ): Promise<CreateTicketResult>;
  createReview(review: NewReview): Promise<Review>;
  getTicket(ticketId: string): Promise<Ticket | null>;
  listTickets(tenantId: string): Promise<Ticket[]>;
  listReviews(tenantId: string): Promise<Review[]>;
}
