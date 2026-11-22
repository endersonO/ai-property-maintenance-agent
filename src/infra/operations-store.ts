import type postgres from "postgres";
import type { History } from "@/operations/history";

// Writes the synthetic history. One transaction: either the old history is fully replaced or
// nothing changes. Only synthetic tables are touched — live tickets, reviews and runs never.

const BATCH = 500;

// Any fixed key shared by every writer of the synthetic history.
const HISTORY_LOCK = 4_202_611;

export async function replaceSyntheticHistory(sql: postgres.Sql, history: History): Promise<{ tickets: number }> {
  await sql.begin(async (tx) => {
    // Serialise concurrent regenerations: without it, two runs can both delete before either
    // commits its inserts, leaving both histories behind. Released at commit or rollback.
    await tx`select pg_advisory_xact_lock(${HISTORY_LOCK})`;
    await tx`delete from synthetic_tickets`;
    await tx`delete from synthetic_portfolio`;
    await tx`
      insert into synthetic_history_meta (id, seed, as_of) values (true, ${history.seed}, ${history.asOf})
      on conflict (id) do update set seed = excluded.seed, as_of = excluded.as_of, generated_at = now()
    `;
    for (let i = 0; i < history.portfolio.length; i += BATCH) {
      await tx`
        insert into synthetic_portfolio ${tx(
          history.portfolio.slice(i, i + BATCH).map((p) => ({ agency_id: p.agencyId, month: p.month, properties: p.properties })),
        )}
      `;
    }
    for (let i = 0; i < history.tickets.length; i += BATCH) {
      await tx`
        insert into synthetic_tickets ${tx(
          history.tickets.slice(i, i + BATCH).map((t) => ({
            agency_id: t.agencyId,
            category: t.category,
            hazards: t.hazards,
            priority: t.priority,
            estimated_cost_gbp: t.estimatedCostGbp,
            sent_to_review: t.sentToReview,
            status: t.status,
            created_at: t.createdAt,
            resolved_at: t.resolvedAt,
            cancelled_at: t.cancelledAt,
          })),
        )}
      `;
    }
  });
  return { tickets: history.tickets.length };
}
