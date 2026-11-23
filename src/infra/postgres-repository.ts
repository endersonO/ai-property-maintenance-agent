import type postgres from "postgres";
import { Policy } from "@/domain/policy";
import {
  planDuplicate,
  type ActivePolicy,
  type AddUpdateResult,
  type CreateTicketResult,
  type NewTicketUpdate,
  type TicketUpdate,
  type NewReview,
  type NewTicket,
  type Repository,
  type Review,
  type TenantContext,
  type Ticket,
} from "@/domain/repository";

// PostgreSQL implementation. Atomicity and idempotency are enforced by the database:
// one transaction per ticket + review, and a UNIQUE idempotency key with ON CONFLICT.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Row = Record<string, unknown>;

const toTicket = (r: Row): Ticket => ({
  id: r.id as string,
  agencyId: r.agency_id as string,
  propertyId: r.property_id as string,
  tenantId: r.tenant_id as string,
  runId: r.run_id as string,
  category: r.category as Ticket["category"],
  hazards: r.hazards as Ticket["hazards"],
  location: r.location as string | null,
  description: r.description as string,
  priority: r.priority as Ticket["priority"],
  status: r.status as Ticket["status"],
  // numeric comes back as a string to avoid precision loss.
  estimatedCostGbp: Number(r.estimated_cost_gbp),
  policyVersion: r.policy_version as number,
  idempotencyKey: r.idempotency_key as string,
  createdAt: r.created_at as Date,
});

const toUpdate = (r: Row): TicketUpdate => ({
  id: r.id as string,
  ticketId: r.ticket_id as string,
  runId: r.run_id as string,
  tenantId: r.tenant_id as string,
  details: r.details as string,
  hazards: r.hazards as TicketUpdate["hazards"],
  idempotencyKey: r.idempotency_key as string,
  raisedPriority: r.raised_priority as boolean,
  createdAt: r.created_at as Date,
});

const toReview = (r: Row): Review => ({
  id: r.id as string,
  runId: r.run_id as string,
  agencyId: r.agency_id as string,
  tenantId: r.tenant_id as string,
  ticketId: r.ticket_id as string | null,
  source: r.source as Review["source"],
  reason: r.reason as string,
  status: r.status as Review["status"],
  createdAt: r.created_at as Date,
});

export class PostgresRepository implements Repository {
  constructor(private readonly sql: postgres.Sql) {}

  async getTenantContext(tenantId: string): Promise<TenantContext | null> {
    const [row] = await this.sql`
      select t.id as tenant_id, t.name as tenant_name,
             p.id as property_id, p.address, p.city, p.postcode,
             a.id as agency_id, a.name as agency_name
      from tenants t
      join properties p on p.id = t.property_id
      join agencies a on a.id = p.agency_id
      where t.id = ${tenantId}
    `;
    if (!row) return null;
    return {
      tenant: { id: row.tenant_id, name: row.tenant_name },
      property: { id: row.property_id, address: row.address, city: row.city, postcode: row.postcode },
      agency: { id: row.agency_id, name: row.agency_name },
    };
  }

  async getActivePolicy(agencyId: string): Promise<ActivePolicy | null> {
    const [row] = await this.sql`
      select version, rules from policies where agency_id = ${agencyId} and active
    `;
    if (!row) return null;
    // Stored JSON is validated on every read: a bad policy fails loudly, never silently.
    return { agencyId, version: row.version, policy: Policy.parse(row.rules) };
  }

  async createTicketWithReview(
    t: NewTicket,
    review: Omit<NewReview, "ticketId"> | null,
  ): Promise<CreateTicketResult> {
    return this.sql.begin(async (tx) => {
      const [inserted] = await tx`
        insert into tickets (agency_id, property_id, tenant_id, run_id, category, hazards, location,
                             description, priority, estimated_cost_gbp, policy_version, idempotency_key)
        values (${t.agencyId}, ${t.propertyId}, ${t.tenantId}, ${t.runId}, ${t.category},
                ${t.hazards}::text[], ${t.location}, ${t.description}, ${t.priority},
                ${t.estimatedCostGbp}, ${t.policyVersion}, ${t.idempotencyKey})
        on conflict (idempotency_key) do nothing
        returning *
      `;
      if (!inserted) {
        // A concurrent or earlier call with the same key won. Lock its ticket so concurrent
        // repeats escalate it one at a time; a plain repeat writes nothing.
        const [row] = await tx`select * from tickets where idempotency_key = ${t.idempotencyKey} for update`;
        const existing = toTicket(row);
        const [{ has_review }] = await tx`
          select exists (select 1 from review_queue where ticket_id = ${existing.id} and status = 'pending') as has_review
        `;
        const plan = planDuplicate(existing, t, review, has_review);
        let ticket = existing;
        if (plan.update) {
          const [updated] = await tx`
            update tickets set priority = ${plan.update.priority}, hazards = ${plan.update.hazards}::text[]
            where id = ${existing.id}
            returning *
          `;
          ticket = toTicket(updated);
        }
        let added: Review | null = null;
        if (plan.review) {
          const [reviewRow] = await tx`
            insert into review_queue (run_id, agency_id, tenant_id, ticket_id, source, reason)
            values (${plan.review.runId}, ${plan.review.agencyId}, ${plan.review.tenantId}, ${existing.id},
                    ${plan.review.source}, ${plan.review.reason})
            returning *
          `;
          added = toReview(reviewRow);
        }
        return { duplicate: true as const, ticket, review: added, escalated: plan.raised };
      }

      const ticket = toTicket(inserted);
      if (!review) return { duplicate: false as const, ticket, review: null };

      const [reviewRow] = await tx`
        insert into review_queue (run_id, agency_id, tenant_id, ticket_id, source, reason)
        values (${review.runId}, ${review.agencyId}, ${review.tenantId}, ${ticket.id},
                ${review.source}, ${review.reason})
        returning *
      `;
      return { duplicate: false as const, ticket, review: toReview(reviewRow) };
    }) as Promise<CreateTicketResult>;
  }

  async addTicketUpdate(
    u: NewTicketUpdate,
    incoming: Pick<NewTicket, "priority" | "hazards">,
    review: Omit<NewReview, "ticketId"> | null,
  ): Promise<AddUpdateResult> {
    return this.sql.begin(async (tx) => {
      // Lock the ticket first: concurrent updates apply one at a time, and a retry that waited
      // sees the update its first attempt committed.
      const [row] = await tx`select * from tickets where id = ${u.ticketId} for update`;
      if (!row) throw new Error(`Ticket ${u.ticketId} not found`);
      const existing = toTicket(row);
      // The caller's tenant must own the ticket: an update is never recorded on someone else's.
      if (existing.tenantId !== u.tenantId) throw new Error(`Ticket ${existing.id} does not belong to ${u.tenantId}`);
      const [repeated] = await tx`select * from ticket_updates where idempotency_key = ${u.idempotencyKey}`;
      if (repeated) {
        // A key reused for a different ticket or tenant is a conflict, never a confirmation.
        if (repeated.ticket_id !== u.ticketId || repeated.tenant_id !== u.tenantId) {
          throw new Error("Idempotency key already used for another ticket update");
        }
        return { duplicate: true, ticket: existing, update: toUpdate(repeated), review: null, escalated: false };
      }
      if (existing.status === "resolved" || existing.status === "cancelled") {
        throw new Error(`Ticket ${existing.id} is ${existing.status}`);
      }
      const [{ has_review }] = await tx`
        select exists (select 1 from review_queue where ticket_id = ${existing.id} and status = 'pending') as has_review
      `;
      const plan = planDuplicate(existing, incoming, review, has_review);
      let ticket = existing;
      if (plan.update) {
        const [updated] = await tx`
          update tickets set priority = ${plan.update.priority}, hazards = ${plan.update.hazards}::text[]
          where id = ${existing.id}
          returning *
        `;
        ticket = toTicket(updated);
      }
      const [updateRow] = await tx`
        insert into ticket_updates (ticket_id, run_id, tenant_id, details, hazards, raised_priority, idempotency_key)
        values (${u.ticketId}, ${u.runId}, ${u.tenantId}, ${u.details}, ${u.hazards}::text[], ${plan.raised}, ${u.idempotencyKey})
        returning *
      `;
      let added: Review | null = null;
      if (plan.review) {
        const [reviewRow] = await tx`
          insert into review_queue (run_id, agency_id, tenant_id, ticket_id, source, reason)
          values (${plan.review.runId}, ${plan.review.agencyId}, ${plan.review.tenantId}, ${existing.id},
                  ${plan.review.source}, ${plan.review.reason})
          returning *
        `;
        added = toReview(reviewRow);
      }
      return { duplicate: false, ticket, update: toUpdate(updateRow), review: added, escalated: plan.raised };
    }) as Promise<AddUpdateResult>;
  }

  async listTicketUpdates(ticketId: string): Promise<TicketUpdate[]> {
    if (!UUID.test(ticketId)) return [];
    const rows = await this.sql`select * from ticket_updates where ticket_id = ${ticketId} order by created_at, id`;
    return rows.map(toUpdate);
  }

  async findTicketUpdateByKey(idempotencyKey: string): Promise<TicketUpdate | null> {
    const [row] = await this.sql`select * from ticket_updates where idempotency_key = ${idempotencyKey}`;
    return row ? toUpdate(row) : null;
  }

  async createReview(r: NewReview): Promise<Review> {
    const [row] = await this.sql`
      insert into review_queue (run_id, agency_id, tenant_id, ticket_id, source, reason)
      values (${r.runId}, ${r.agencyId}, ${r.tenantId}, ${r.ticketId}, ${r.source}, ${r.reason})
      returning *
    `;
    return toReview(row);
  }

  async getTicket(ticketId: string): Promise<Ticket | null> {
    // Ids come from the model: a malformed one is "not found", not a database error.
    if (!UUID.test(ticketId)) return null;
    const [row] = await this.sql`select * from tickets where id = ${ticketId}`;
    return row ? toTicket(row) : null;
  }

  async listTickets(tenantId: string): Promise<Ticket[]> {
    const rows = await this.sql`
      select * from tickets where tenant_id = ${tenantId} order by created_at desc
    `;
    return rows.map(toTicket);
  }

  async listReviews(tenantId: string): Promise<Review[]> {
    const rows = await this.sql`
      select * from review_queue where tenant_id = ${tenantId} order by created_at
    `;
    return rows.map(toReview);
  }
}
