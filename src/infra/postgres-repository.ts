import type postgres from "postgres";
import { Policy } from "@/domain/policy";
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
        // A concurrent or earlier call with the same key won; return its ticket, write nothing.
        const [existing] = await tx`select * from tickets where idempotency_key = ${t.idempotencyKey}`;
        return { duplicate: true as const, ticket: toTicket(existing), review: null };
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
