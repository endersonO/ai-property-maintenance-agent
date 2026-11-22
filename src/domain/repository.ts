import { Priority, type Category, type Hazard, type TicketStatus } from "./enums";
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
  // Same idempotency key: the existing ticket is returned. It is never downgraded, but a more
  // severe repeat escalates it (see planDuplicate); `review` is then the review this call added.
  | { duplicate: true; ticket: Ticket; review: Review | null; escalated: boolean };

// Lower index = more severe.
const severity = (p: Priority) => Priority.options.indexOf(p);

export type DuplicatePlan = {
  // Ticket fields to update, or null when the ticket stays as it is.
  update: Pick<Ticket, "priority" | "hazards"> | null;
  // Review to add for the existing ticket, or null.
  review: Omit<NewReview, "ticketId"> | null;
};

// Pure decision for a repeated idempotency key, shared by every Repository implementation.
// Deduplication must never swallow an escalation: if the repeat is more severe (e.g. the
// model first missed the leak, then reported it), the ticket's priority goes up and the
// review the policy now requires is added. A plain repeat writes nothing.
export function planDuplicate(
  existing: Ticket,
  incoming: NewTicket,
  review: Omit<NewReview, "ticketId"> | null,
  existingHasReview: boolean,
): DuplicatePlan {
  const raised = severity(incoming.priority) < severity(existing.priority);
  const hazards = [...new Set([...existing.hazards, ...incoming.hazards])];
  const update = raised ? { priority: incoming.priority, hazards } : null;
  const needsReview = review !== null && (raised || !existingHasReview);
  return {
    update,
    review: needsReview
      ? { ...review, reason: raised ? `escalated by a repeated report: ${review.reason}` : review.reason }
      : null,
  };
}

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
