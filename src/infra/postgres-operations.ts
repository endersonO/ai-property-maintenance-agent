import type postgres from "postgres";
import type { BriefQuery, BriefReport, ManagerScope, OperationsPort } from "@/operations/port";
import { readMonthlyRates, readResolution, readSnapshot, readVolume, type Fact } from "./operations-queries";

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

export type OperationsDashboard = {
  dataset: "synthetic";
  asOf: Date;
  volume: { facts: Fact[]; notes: string[] };
  resolution: { facts: Fact[]; notes: string[] };
  emergencies: { facts: Fact[]; notes: string[] };
  monthly: { facts: Fact[]; notes: string[] };
  agencies: { id: string; name: string; acquiredOn: string | null; onboardedOn: string | null }[];
};

// Everything the dashboard shows, from the SAME queries the brief uses, in one snapshot — so a
// figure on the page and the same figure in a brief can't disagree.
export async function operationsDashboard(sql: postgres.Sql, agencyIds: string[]): Promise<OperationsDashboard | null> {
  return readSnapshot(sql, async (tx) => {
    const [meta] = await tx`select as_of from synthetic_history_meta`;
    if (!meta) return null;
    const asOf = meta.as_of as Date;
    const scope = { dataset: "synthetic" as const, asOf, period: "last_closed_quarter" as const, agencyIds };
    const agencies = await tx`
      select id, name, acquired_on::text as acquired_on, onboarded_on::text as onboarded_on
      from agencies where id = any(${agencyIds}) order by name
    `;
    return {
      dataset: "synthetic" as const,
      asOf,
      volume: await readVolume(tx, scope),
      resolution: await readResolution(tx, { ...scope, priority: null }),
      emergencies: await readResolution(tx, { ...scope, priority: "emergency" }),
      monthly: await readMonthlyRates(tx, { asOf, agencyIds }),
      agencies: agencies.map((a) => ({ id: a.id, name: a.name, acquiredOn: a.acquired_on, onboardedOn: a.onboarded_on })),
    };
  });
}
