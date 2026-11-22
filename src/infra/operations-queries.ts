import type postgres from "postgres";
import { periodRanges, type PeriodKey, type Range } from "@/operations/periods";

// Deterministic operations metrics. SQL computes every number; the operations brief and the
// dashboard both read these functions, so they can never disagree. Each result is a list of
// facts with a readable key the brief must cite next to every figure it states.

export type Dataset = "live" | "synthetic";

export type Fact = {
  key: string;
  metric: string;
  // An agency id, or "all" for the whole scope.
  agencyId: string;
  period: string;
  unit: "tickets" | "tickets_per_100_homes_per_month" | "percent" | "hours" | "days";
  value: number;
  // Observations behind the value, when it is a statistic.
  n?: number;
};

export type MetricScope = {
  dataset: Dataset;
  asOf: Date;
  period: PeriodKey;
  // Authorised agencies, set by the server. Never empty.
  agencyIds: string[];
};

const round = (value: number, decimals: number) => Math.round(value * 10 ** decimals) / 10 ** decimals;
const fact = (f: Omit<Fact, "key">): Fact => ({
  ...f,
  key: [f.metric, f.agencyId, f.period].join("."),
});

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

// Calendar months (first day, UTC) of a range.
function monthsOf(range: Range): string[] {
  const months: string[] = [];
  for (let d = range.start; d < range.end; d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))) {
    months.push(isoDay(d));
  }
  return months;
}

// Which months each agency has data for in a dataset, so a month without data is never read as
// zero tickets: synthetic = months with a portfolio row (history start, end and gaps); live = from
// the agency's first live ticket to the last complete month.
async function coverage(sql: postgres.Sql, dataset: Dataset, agencyIds: string[], now = new Date()) {
  const covered = new Map<string, Set<string>>(agencyIds.map((id) => [id, new Set<string>()]));
  if (dataset === "synthetic") {
    const rows = await sql`
      select agency_id, to_char(month, 'YYYY-MM-DD') as month from synthetic_portfolio where agency_id = any(${agencyIds})
    `;
    for (const r of rows) covered.get(r.agency_id)?.add(r.month);
  } else {
    const rows = await sql`
      select agency_id, to_char(date_trunc('month', min(created_at) at time zone 'UTC'), 'YYYY-MM-DD') as first_month
      from tickets where agency_id = any(${agencyIds}) group by agency_id
    `;
    const lastComplete = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    for (const r of rows) {
      monthsOf({ label: "", start: new Date(`${r.first_month}T00:00:00Z`), end: lastComplete }).forEach((m) =>
        covered.get(r.agency_id)?.add(m),
      );
    }
  }
  const agencies = await sql`select id, acquired_on from agencies where id = any(${agencyIds})`;
  return {
    // Months of the range with data for the agency.
    covered: (range: Range, agencyId: string) => monthsOf(range).filter((m) => covered.get(agencyId)?.has(m)).length,
    // The recorded acquisition date, only when it falls inside the range.
    acquiredWithin: (range: Range, agencyId: string): string | null => {
      const acquired = agencies.find((a) => a.id === agencyId)?.acquired_on;
      return acquired && new Date(acquired) >= range.start && new Date(acquired) < range.end ? isoDay(new Date(acquired)) : null;
    },
  };
}

// Every report reads one snapshot: all its queries run in a single REPEATABLE READ, read-only
// transaction, so a regeneration or a write in between can't mix two versions of the data.
type Report = { facts: Fact[]; notes: string[] };
export const readSnapshot = <T>(sql: postgres.Sql, read: (tx: postgres.Sql) => Promise<T>): Promise<T> =>
  sql.begin("isolation level repeatable read read only", (tx) => read(tx as unknown as postgres.Sql)) as Promise<T>;
const snapshot = (sql: postgres.Sql, read: (tx: postgres.Sql) => Promise<Report>) => readSnapshot(sql, read);

export const volumeFacts = (sql: postgres.Sql, scope: MetricScope) => snapshot(sql, (tx) => readVolume(tx, scope));

export async function readVolume(sql: postgres.Sql, scope: MetricScope): Promise<Report> {
  const { current, previous, lastYear, months } = periodRanges(scope.period, scope.asOf);
  const { covered, acquiredWithin } = await coverage(sql, scope.dataset, scope.agencyIds);
  const rows = await sql`
    select agency_id,
           count(*) filter (where created_at >= ${current.start} and created_at < ${current.end})::int as current,
           count(*) filter (where created_at >= ${previous.start} and created_at < ${previous.end})::int as previous,
           count(*) filter (where created_at >= ${lastYear.start} and created_at < ${lastYear.end})::int as last_year
    from ops.operations_tickets
    where dataset = ${scope.dataset} and agency_id = any(${scope.agencyIds})
    group by agency_id
  `;
  // Exposure: tickets and homes of the SAME months — the months with a known portfolio. Month
  // boundaries are compared as UTC calendar dates on both sides, whatever the session time zone.
  const homes = await sql`
    select p.agency_id, sum(p.properties)::float as home_months, count(*)::int as months,
           coalesce(sum(c.n), 0)::int as tickets
    from synthetic_portfolio p
    left join (
      select agency_id, date_trunc('month', created_at at time zone 'UTC')::date as month, count(*) as n
      from ops.operations_tickets
      where dataset = 'synthetic' and agency_id = any(${scope.agencyIds})
      group by 1, 2
    ) c on c.agency_id = p.agency_id and c.month = p.month
    where p.agency_id = any(${scope.agencyIds})
      and p.month >= ${isoDay(current.start)}::date and p.month < ${isoDay(current.end)}::date
    group by p.agency_id
  `;

  const facts: Fact[] = [];
  const notes: string[] = [];
  const count = (agencyId: string, key: "current" | "previous" | "last_year") =>
    rows.find((r) => r.agency_id === agencyId)?.[key] ?? 0;
  const reported: string[] = [];

  for (const agencyId of [...scope.agencyIds].sort()) {
    const currentMonths = covered(current, agencyId);
    if (currentMonths === 0) {
      notes.push(`${agencyId}: no ${scope.dataset} data for ${current.label}; nothing reported.`);
      continue;
    }
    reported.push(agencyId);
    const now = count(agencyId, "current");
    facts.push(fact({ metric: "tickets_created", agencyId, period: current.label, unit: "tickets", value: now }));
    if (currentMonths < months) {
      // State what was observed; attribute it to an acquisition only when the recorded date says so.
      const acquired = acquiredWithin(current, agencyId);
      notes.push(
        `${agencyId}: data covers ${currentMonths} of ${months} months of ${current.label}; rates use those months only.` +
          (acquired ? ` Acquired on ${acquired}.` : ""),
      );
    }
    for (const [baseline, range, metric] of [
      ["previous", previous, "change_vs_previous_period"],
      ["last_year", lastYear, "change_vs_same_period_last_year"],
    ] as const) {
      // A change is only published when BOTH periods are fully covered: a month without data is
      // not a 100 % drop.
      const baselineMonths = covered(range, agencyId);
      if (currentMonths < months || baselineMonths < months) {
        notes.push(
          `${agencyId}: no ${metric} — data covers ${currentMonths}/${months} months of ${current.label} and ${baselineMonths}/${months} of ${range.label}.`,
        );
        continue;
      }
      const before = count(agencyId, baseline);
      // For 12 months the previous period IS last year's: state the baseline once.
      const baselineFact = fact({ metric: "tickets_created", agencyId, period: range.label, unit: "tickets", value: before });
      if (!facts.some((f) => f.key === baselineFact.key)) facts.push(baselineFact);
      if (before > 0) {
        facts.push(fact({ metric, agencyId, period: current.label, unit: "percent", value: round(((now - before) / before) * 100, 1) }));
      }
    }
    const exposure = homes.find((r) => r.agency_id === agencyId);
    if (scope.dataset === "synthetic" && exposure) {
      facts.push(
        fact({
          metric: "tickets_per_100_homes",
          agencyId,
          period: current.label,
          unit: "tickets_per_100_homes_per_month",
          value: round((exposure.tickets / exposure.home_months) * 100, 2),
        }),
      );
    }
  }
  if (reported.length > 0) {
    const total = reported.reduce((sum, id) => sum + count(id, "current"), 0);
    facts.push(fact({ metric: "tickets_created", agencyId: "all", period: current.label, unit: "tickets", value: total }));
  }
  return { facts, notes };
}

export type ResolutionScope = MetricScope & { priority?: "emergency" | "high" | "normal" | "low" | null };

export const resolutionFacts = (sql: postgres.Sql, scope: ResolutionScope) => snapshot(sql, (tx) => readResolution(tx, scope));

export async function readResolution(sql: postgres.Sql, scope: ResolutionScope): Promise<Report> {
  const { current, months } = periodRanges(scope.period, scope.asOf);
  const { covered } = await coverage(sql, scope.dataset, scope.agencyIds);
  const priority = scope.priority ?? null;
  const suffix = priority ? `_${priority}` : "";
  const facts: Fact[] = [];

  // States (resolved, open, backlog age) can't be known past the last observation: the synthetic
  // history's as_of, or now for live data. A later cut-off uses the last observed one, said so.
  // For live data "now" comes from the database, inside this report's snapshot: the same clock
  // (and microsecond precision) that recorded the changes being read.
  const observedUntil =
    scope.dataset === "synthetic"
      ? ((await sql`select as_of from synthetic_history_meta`)[0]?.as_of as Date | undefined) ?? null
      : ((await sql`select now() as now`)[0].now as Date);
  const stateAsOf = observedUntil && observedUntil < scope.asOf ? observedUntil : scope.asOf;
  const notes = [
    `Resolution: tickets created in the period, states as of ${isoDay(stateAsOf)}, calendar hours, cancelled excluded.`,
  ];
  if (stateAsOf < scope.asOf) {
    notes.push(`States use the last observed date ${isoDay(stateAsOf)}, not the requested ${isoDay(scope.asOf)}.`);
  }
  // The cut used inside SQL. For live data it is computed by the database itself: a timestamp
  // round-tripped through JavaScript loses its microseconds and could drop a change made in the
  // same millisecond.
  const cut =
    scope.dataset === "live" ? sql`least(${scope.asOf}::timestamptz, now())` : sql`${stateAsOf}::timestamptz`;

  // Coverage is decided BEFORE aggregating, so the total, shares and percentiles are computed
  // over exactly the agencies that are reported.
  const reported = [...scope.agencyIds].sort().filter((agencyId) => {
    const n = covered(current, agencyId);
    if (n === 0) notes.push(`${agencyId}: no ${scope.dataset} data for ${current.label}; nothing reported.`);
    else if (n < months) notes.push(`${agencyId}: data covers ${n} of ${months} months of ${current.label}.`);
    return n > 0;
  });
  if (reported.length === 0) return { facts, notes };
  // Cohort: tickets CREATED in the period. Calendar hours. Cancelled tickets are excluded from
  // resolution figures and counted apart; open tickets are the backlog at asOf.
  // States are evaluated AS OF the reference date, not from today's status: a ticket resolved or
  // cancelled after asOf was still open then. Tickets resolved or cancelled before those dates
  // were recorded have an unknown date and are counted apart, never as open or as a duration.
  const rows = await sql`
    with t as (
      select agency_id, created_at, resolved_at,
             -- The priority the ticket had at the cut-off: the last recorded change before it, else
             -- the priority before its first change after it, else the current one. Unknown (null)
             -- for a live ticket created before priority changes were recorded, at a cut-off before
             -- that, with no recorded change before the cut-off to explain it.
             case
               when o.dataset = 'live'
                    and ${cut} < tracked.since and o.created_at < tracked.since
                    and not exists (select 1 from ticket_priority_changes c
                                    where c.ticket_id = o.ticket_id and c.changed_at < ${cut})
                 then null
               else coalesce(
                 (select c.to_priority from ticket_priority_changes c
                   where c.ticket_id = o.ticket_id and c.changed_at < ${cut}
                   order by c.changed_at desc, c.id desc limit 1),
                 (select c.from_priority from ticket_priority_changes c
                   where c.ticket_id = o.ticket_id and c.changed_at >= ${cut}
                   order by c.changed_at asc, c.id asc limit 1),
                 o.priority)
             end as priority_then,
             case
               when cancelled_at is not null and cancelled_at < ${cut} then 'cancelled'
               when resolved_at is not null and resolved_at < ${cut} then 'resolved'
               when status = 'cancelled' and cancelled_at is null then 'cancelled_undated'
               when status = 'resolved' and resolved_at is null then 'undated'
               else 'open'
             end as state
      from ops.operations_tickets o
      cross join (select coalesce((select since from history_tracking where subject = 'ticket_priority'),
                                  '-infinity'::timestamptz) as since) tracked
      where dataset = ${scope.dataset} and agency_id = any(${reported})
        and created_at >= ${current.start} and created_at < ${current.end}
    )
    select coalesce(agency_id, 'all') as agency_id,
           count(*) filter (where in_filter and state in ('resolved', 'open'))::int as n,
           count(*) filter (where in_filter and state = 'resolved')::int as resolved,
           count(*) filter (where in_filter and state = 'open')::int as open,
           count(*) filter (where in_filter and state = 'cancelled')::int as cancelled,
           count(*) filter (where in_filter and state = 'undated')::int as undated,
           count(*) filter (where in_filter and state = 'cancelled_undated')::int as cancelled_undated,
           count(*) filter (where not in_filter and priority_then is null)::int as priority_unknown,
           percentile_cont(0.5) within group (order by extract(epoch from resolved_at - created_at) / 3600)
             filter (where in_filter and state = 'resolved') as median_hours,
           percentile_cont(0.9) within group (order by extract(epoch from resolved_at - created_at) / 3600)
             filter (where in_filter and state = 'resolved') as p90_hours,
           percentile_cont(0.5) within group (order by extract(epoch from ${cut} - created_at) / 86400)
             filter (where in_filter and state = 'open') as open_median_age_days
    -- coalesce: an unknown priority compares as null, which must mean "not in the filter".
    from (select *, coalesce(${priority}::text is null or priority_then = ${priority}::text, false) as in_filter from t) f
    -- In the filter, or excluded only because the priority at the cut-off is unknown (counted apart).
    where in_filter or priority_then is null
    group by grouping sets ((agency_id), ())
  `;

  // Every covered agency in scope gets a row: one with no tickets says "0", it is never silently
  // left out. An agency with no data for the period is a note, not a zero.
  const empty = {
    n: 0,
    resolved: 0,
    open: 0,
    cancelled: 0,
    undated: 0,
    cancelled_undated: 0,
    priority_unknown: 0,
    median_hours: null,
    p90_hours: null,
    open_median_age_days: null,
  };
  for (const agencyId of [...reported, "all"]) {
    const r = rows.find((row) => row.agency_id === agencyId) ?? empty;
    const base = { agencyId, period: current.label };
    facts.push(fact({ ...base, metric: `tickets_in_cohort${suffix}`, unit: "tickets", value: r.n }));
    if (r.n > 0) {
      facts.push(fact({ ...base, metric: `resolved_share${suffix}`, unit: "percent", value: round((r.resolved / r.n) * 100, 1), n: r.n }));
    }
    if (r.median_hours !== null) {
      facts.push(fact({ ...base, metric: `median_hours_to_resolve${suffix}`, unit: "hours", value: round(Number(r.median_hours), 1), n: r.resolved }));
      facts.push(fact({ ...base, metric: `p90_hours_to_resolve${suffix}`, unit: "hours", value: round(Number(r.p90_hours), 1), n: r.resolved }));
    }
    facts.push(fact({ ...base, metric: `open_at_as_of${suffix}`, unit: "tickets", value: r.open }));
    if (r.open_median_age_days !== null) {
      facts.push(fact({ ...base, metric: `open_median_age_days${suffix}`, unit: "days", value: round(Number(r.open_median_age_days), 1), n: r.open }));
    }
    facts.push(fact({ ...base, metric: `cancelled${suffix}`, unit: "tickets", value: r.cancelled }));
    if (r.undated > 0) {
      facts.push(fact({ ...base, metric: `resolved_without_date${suffix}`, unit: "tickets", value: r.undated }));
    }
    if (r.priority_unknown > 0) {
      facts.push(fact({ ...base, metric: `priority_unknown_at_cut_off${suffix}`, unit: "tickets", value: r.priority_unknown }));
    }
    if (r.cancelled_undated > 0) {
      facts.push(fact({ ...base, metric: `cancelled_without_date${suffix}`, unit: "tickets", value: r.cancelled_undated }));
    }
  }
  return { facts, notes };
}
