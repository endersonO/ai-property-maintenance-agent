import type postgres from "postgres";
import type { BriefQuery, BriefReport, ManagerScope, OperationsPort } from "@/operations/port";
import { readMonthlyRates, readOpenNow, readResolution, readSnapshot, readVolume, type Fact } from "./operations-queries";

// Operations port on PostgreSQL. Briefs run on the synthetic history, cut at the date it was
// observed up to (live data has no operations history yet). The cut-off and the facts are read
// in ONE repeatable-read snapshot, so they always belong together.
export class PostgresOperations implements OperationsPort {
  constructor(private readonly sql: postgres.Sql) {}

  async agencyNames(agencyIds: string[]) {
    const rows = await this.sql`select id, name from agencies where id = any(${agencyIds})`;
    return Object.fromEntries(rows.map((r) => [r.id as string, r.name as string]));
  }

  async agencies(agencyIds: string[]) {
    const rows = await this.sql`
      select id, name, acquired_on::text as acquired_on, onboarded_on::text as onboarded_on
      from agencies where id = any(${agencyIds}) order by name
    `;
    return rows.map((r) => ({ id: r.id as string, name: r.name as string, acquiredOn: r.acquired_on, onboardedOn: r.onboarded_on }));
  }

  private report(read: (tx: postgres.Sql, asOf: Date) => ReturnType<typeof readVolume>): Promise<BriefReport> {
    return readSnapshot(this.sql, async (tx) => {
      const [meta] = await tx`select as_of from synthetic_history_meta`;
      if (!meta) throw new Error("No synthetic history: run pnpm seed:history");
      const asOf = meta.as_of as Date;
      return { ...(await read(tx, asOf)), dataset: "synthetic" as const, asOf };
    });
  }

  volume(query: BriefQuery) {
    return this.report((tx, asOf) => readVolume(tx, { ...query, dataset: "synthetic", asOf }));
  }

  resolution(query: BriefQuery & { priority: "emergency" | "high" | "normal" | "low" | null }) {
    return this.report((tx, asOf) => readResolution(tx, { ...query, dataset: "synthetic", asOf }));
  }

  // Live data, current state: no synthetic history involved.
  openNow(query: Pick<BriefQuery, "agencyIds">): Promise<BriefReport> {
    return readSnapshot(this.sql, async (tx) => {
      const { facts, notes, now } = await readOpenNow(tx, query.agencyIds);
      return { facts, notes, dataset: "live" as const, asOf: now };
    });
  }
}

// The manager's authorised agencies, from the database. Null for an unknown manager.
export async function managerScope(sql: postgres.Sql, managerId: string): Promise<ManagerScope | null> {
  const [row] = await sql`
    select m.id, m.name, coalesce(array_agg(ma.agency_id order by ma.agency_id) filter (where ma.agency_id is not null), '{}') as agency_ids
    from managers m left join manager_agencies ma on ma.manager_id = m.id
    where m.id = ${managerId}
    group by m.id, m.name
  `;
  return row ? { managerId: row.id, name: row.name, agencyIds: row.agency_ids } : null;
}

// One open ticket to attend, as a manager sees it: what, where, since when, and what's missing.
export type AttentionItem = {
  ticketId: string;
  priority: "emergency" | "high" | "normal" | "low";
  status: string;
  category: string;
  location: string | null;
  description: string;
  agencyName: string;
  address: string;
  city: string;
  tenantName: string;
  createdAt: Date;
  ageHours: number;
  // The run that reported it (the conversation), if any.
  runId: string | null;
  // Pending human review, with the system's reason; null when none is pending.
  pendingReview: string | null;
};

// A request for a person with no ticket behind it (e.g. a rent question passed to the agency).
export type PendingReviewItem = {
  reviewId: string;
  agencyName: string;
  tenantName: string;
  reason: string;
  createdAt: Date;
  ageHours: number;
  runId: string | null;
};

// Open live tickets in the manager's scope, most urgent first: emergencies, then by age.
// Read-only: approving reviews belongs to the agency review iteration.
export async function readAttentionQueue(sql: postgres.Sql, agencyIds: string[], limit = 20) {
  const rows = await sql`
    select t.id, t.priority, t.status, t.category, t.location, t.description, t.created_at, t.run_id,
           extract(epoch from now() - t.created_at) / 3600 as age_hours,
           a.name as agency_name, p.address, p.city, te.name as tenant_name,
           (select q.reason from review_queue q
             where q.ticket_id = t.id and q.status = 'pending' order by q.created_at desc limit 1) as pending_review,
           count(*) over () as total
    from tickets t
    join agencies a on a.id = t.agency_id
    join properties p on p.id = t.property_id
    join tenants te on te.id = t.tenant_id
    where t.agency_id = any(${agencyIds}) and t.status in ('open', 'in_progress')
    order by array_position(array['emergency', 'high', 'normal', 'low'], t.priority), t.created_at
    limit ${limit}
  `;
  // Reviews waiting for a person without any ticket: also something to attend, never hidden
  // behind "nothing open".
  const reviews = await sql`
    select q.id, q.reason, q.created_at, q.run_id, extract(epoch from now() - q.created_at) / 3600 as age_hours,
           a.name as agency_name, te.name as tenant_name
    from review_queue q
    join agencies a on a.id = q.agency_id
    join tenants te on te.id = q.tenant_id
    where q.agency_id = any(${agencyIds}) and q.status = 'pending' and q.ticket_id is null
    order by q.created_at
    limit ${limit}
  `;
  return {
    reviewsWithoutTicket: reviews.map(
      (r): PendingReviewItem => ({
        reviewId: r.id,
        agencyName: r.agency_name,
        tenantName: r.tenant_name,
        reason: r.reason,
        createdAt: r.created_at,
        ageHours: Number(r.age_hours),
        runId: r.run_id,
      }),
    ),
    total: rows.length > 0 ? Number(rows[0].total) : 0,
    items: rows.map(
      (r): AttentionItem => ({
        ticketId: r.id,
        priority: r.priority,
        status: r.status,
        category: r.category,
        location: r.location,
        description: r.description,
        agencyName: r.agency_name,
        address: r.address,
        city: r.city,
        tenantName: r.tenant_name,
        createdAt: r.created_at,
        ageHours: Number(r.age_hours),
        runId: r.run_id,
        pendingReview: r.pending_review,
      }),
    ),
  };
}

export type OperationsHistory = {
  dataset: "synthetic";
  asOf: Date;
  volume: { facts: Fact[]; notes: string[] };
  resolution: { facts: Fact[]; notes: string[] };
  emergencies: { facts: Fact[]; notes: string[] };
  monthly: { facts: Fact[]; notes: string[] };
};

export type OperationsDashboard = {
  agencies: { id: string; name: string; acquiredOn: string | null; onboardedOn: string | null }[];
  // Live tickets now: always available, demonstration history or not.
  openNow: { facts: Fact[]; notes: string[]; now: Date };
  // The open tickets themselves, most urgent first (live).
  attention: { total: number; items: AttentionItem[]; reviewsWithoutTicket: PendingReviewItem[] };
  // The synthetic history; null when it hasn't been generated.
  history: OperationsHistory | null;
};

// Everything the dashboard shows, from the SAME queries the brief uses, in one snapshot — so a
// figure on the page and the same figure in a brief can't disagree.
export async function operationsDashboard(sql: postgres.Sql, agencyIds: string[]): Promise<OperationsDashboard> {
  return readSnapshot(sql, async (tx) => {
    const agencies = await tx`
      select id, name, acquired_on::text as acquired_on, onboarded_on::text as onboarded_on
      from agencies where id = any(${agencyIds}) order by name
    `;
    const openNow = await readOpenNow(tx, agencyIds);
    const attention = await readAttentionQueue(tx, agencyIds);
    const [meta] = await tx`select as_of from synthetic_history_meta`;
    let history: OperationsHistory | null = null;
    if (meta) {
      const asOf = meta.as_of as Date;
      const scope = { dataset: "synthetic" as const, asOf, period: "last_closed_quarter" as const, agencyIds };
      history = {
        dataset: "synthetic",
        asOf,
        volume: await readVolume(tx, scope),
        resolution: await readResolution(tx, { ...scope, priority: null }),
        emergencies: await readResolution(tx, { ...scope, priority: "emergency" }),
        monthly: await readMonthlyRates(tx, { asOf, agencyIds }),
      };
    }
    return {
      agencies: agencies.map((a) => ({ id: a.id, name: a.name, acquiredOn: a.acquired_on, onboardedOn: a.onboarded_on })),
      openNow,
      attention,
      history,
    };
  });
}
