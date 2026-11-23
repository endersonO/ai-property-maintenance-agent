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

// Details a tenant adds to one of their open tickets.
export type NewTicketUpdate = {
  ticketId: string;
  runId: string;
  tenantId: string;
  details: string;
  hazards: Hazard[];
  // Retries of the same request add the details once.
  idempotencyKey: string;
};

export type TicketUpdate = NewTicketUpdate & { id: string; raisedPriority: boolean; createdAt: Date };

export type AddUpdateResult =
  // duplicate: a retry of the same request; nothing was written again.
  { duplicate: boolean; ticket: Ticket; update: TicketUpdate; review: Review | null; escalated: boolean };

// Lower index = more severe.
const severity = (p: Priority) => Priority.options.indexOf(p);

export type DuplicatePlan = {
  // Ticket fields to update, or null when the ticket stays as it is.
  update: Pick<Ticket, "priority" | "hazards"> | null;
  // The priority went up (an escalation). New hazards alone update the ticket without raising it.
  raised: boolean;
  // Review to add for the existing ticket, or null.
  review: Omit<NewReview, "ticketId"> | null;
};

// Pure decision for a repeated report on an existing ticket — the same request retried, or
// details added to an open ticket — shared by every Repository implementation. It must never
// swallow an escalation: if the repeat is more severe (e.g. the model first missed the leak,
// then reported it), the ticket's priority goes up and the review the policy now requires is
// added. It never downgrades. A plain repeat changes nothing.
export function planDuplicate(
  existing: Ticket,
  incoming: Pick<NewTicket, "priority" | "hazards">,
  review: Omit<NewReview, "ticketId"> | null,
  existingHasReview: boolean,
): DuplicatePlan {
  const raised = severity(incoming.priority) < severity(existing.priority);
  const hazards = [...new Set([...existing.hazards, ...incoming.hazards])];
  // A new hazard is always kept on the ticket, even when the priority is already at its highest
  // (a gas smell reported on an emergency leak ticket).
  const newHazards = hazards.length > existing.hazards.length;
  const update = raised || newHazards ? { priority: raised ? incoming.priority : existing.priority, hazards } : null;
  const needsReview = review !== null && (raised || !existingHasReview);
  return {
    update,
    raised,
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
  // Atomic: the details, any escalation (planDuplicate) and its review, or nothing. `incoming`
  // is the policy's decision for the ticket with the new hazards. Throws if the ticket is closed.
  addTicketUpdate(
    update: NewTicketUpdate,
    incoming: Pick<NewTicket, "priority" | "hazards">,
    review: Omit<NewReview, "ticketId"> | null,
  ): Promise<AddUpdateResult>;
  listTicketUpdates(ticketId: string): Promise<TicketUpdate[]>;
  // What a request already did, so a retry returns it instead of choosing again.
  findTicketUpdateByKey(idempotencyKey: string): Promise<TicketUpdate | null>;
  getTicket(ticketId: string): Promise<Ticket | null>;
  listTickets(tenantId: string): Promise<Ticket[]>;
  listReviews(tenantId: string): Promise<Review[]>;
}
