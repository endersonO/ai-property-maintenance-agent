import { headers } from "next/headers";
import { connection } from "next/server";
import { Suspense } from "react";
import { getSql } from "@/infra/db";
import type { Fact } from "@/infra/operations-queries";
import { managerScope, operationsDashboard, type AttentionItem, type PendingReviewItem } from "@/infra/postgres-operations";
import { checkAccess } from "@/server/access";
import { clientKey } from "@/server/http";
import { AccessForm } from "../access-form";
import { Icon, PriorityBadge } from "../ui";
import { DemoNav } from "../site-nav";
import { BriefBox } from "./brief-box";
import { lastTwelveMonthKeys } from "@/operations/periods";
import { statistic } from "./figures";
import { TrendChart, type TrendSeries } from "./trend-chart";

// The operations manager's view. Every figure comes from the same queries the operations brief
// uses, read in one snapshot. Synthetic history, labelled as such.

const MANAGERS = ["manager_ops", "manager_north"];
// Color follows the entity, never its rank: a fixed slot per agency.
const AGENCY_COLOR: Record<string, string> = {
  agency_northbridge: "var(--series-1)",
  agency_harbour_lane: "var(--series-2)",
  agency_riverside: "var(--series-3)",
};

const fmt = (v: number | undefined, digits = 1) => (v === undefined ? "—" : v.toFixed(digits).replace(/\.0+$/, ""));
const signed = (v: number | undefined) => (v === undefined ? "—" : `${v > 0 ? "+" : ""}${fmt(v)}%`);
const day = (d: string | Date) =>
  new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(d));

function Tile({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="rounded-lg border border-border bg-surface p-3 shadow-panel">
      <dt className="text-label text-muted">{label}</dt>
      <dd className="font-mono text-title tabular-nums">{value}</dd>
      {detail && <dd className="text-label text-muted">{detail}</dd>}
    </div>
  );
}

const age = (hours: number) =>
  hours < 1 ? `${Math.max(1, Math.round(hours * 60))} min` : hours < 48 ? `${Math.round(hours)} h` : `${Math.round(hours / 24)} days`;

// One incident to attend. Read-only: it shows what, where, since when and what's missing, and
// links to the conversation that reported it. Approving reviews is the agency-review iteration.
function AttentionCard({ item, codeSuffix }: { item: AttentionItem; codeSuffix: string }) {
  const urgent = item.priority === "emergency";
  return (
    <li
      className={`space-y-2 rounded-lg border bg-surface p-4 shadow-panel ${urgent ? "border-emergency border-t-4" : "border-border"}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex flex-wrap items-center gap-2">
          <PriorityBadge priority={item.priority} />
          <span className="text-body-sm font-medium">{item.agencyName}</span>
        </span>
        <span className={`text-label tabular-nums ${urgent ? "font-medium text-emergency" : "text-muted"}`}>
          open {age(item.ageHours)}
        </span>
      </div>
      <p className="text-body-sm text-muted">
        {item.address}, {item.city}
      </p>
      <div>
        <p className="font-medium">
          {item.category.charAt(0).toUpperCase() + item.category.slice(1)}
          {item.location && ` · ${item.location}`}
        </p>
        <p className="text-body-sm">&ldquo;{item.description}&rdquo;</p>
      </div>
      <p className="text-label text-muted">
        Reported by {item.tenantName} via the assistant · <span className="font-mono">#{item.ticketId.slice(0, 8)}</span>
      </p>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-2">
        {item.pendingReview ? (
          <span className="flex items-start gap-1.5 text-label text-review">
            <Icon name="person" className="mt-0.5 size-3.5 shrink-0" />
            <span>
              Waiting for human review — <span className="text-muted">{item.pendingReview}</span>
            </span>
          </span>
        ) : (
          <span className="text-label text-muted">{item.status === "in_progress" ? "In progress" : "Open, no review needed"}</span>
        )}
        {item.runId && (
          <a href={`/inspector/${item.runId}${codeSuffix}`} className="text-label text-accent underline-offset-2 hover:underline">
            View conversation →
          </a>
        )}
      </div>
    </li>
  );
}

// A request for a person with no ticket (e.g. a rent question). Read-only, like the tickets.
function ReviewCard({ item, codeSuffix }: { item: PendingReviewItem; codeSuffix: string }) {
  return (
    <li className="space-y-2 rounded-lg border border-border bg-surface p-4 shadow-panel">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1 rounded-sm bg-review-soft px-2 py-0.5 text-label font-medium text-review">
            <Icon name="person" className="size-3.5" />
            Person requested
          </span>
          <span className="text-body-sm font-medium">{item.agencyName}</span>
        </span>
        <span className="text-label tabular-nums text-muted">waiting {age(item.ageHours)}</span>
      </div>
      <p className="text-body-sm">{item.reason}</p>
      <p className="text-label text-muted">From {item.tenantName} via the assistant · no ticket</p>
      {item.runId && (
        <div className="border-t border-border pt-2 text-right">
          <a href={`/inspector/${item.runId}${codeSuffix}`} className="text-label text-accent underline-offset-2 hover:underline">
            View conversation →
          </a>
        </div>
      )}
    </li>
  );
}

async function Dashboard({ searchParams }: { searchParams: PageProps<"/operations">["searchParams"] }) {
  await connection();
  const { code, manager: requested } = await searchParams;
  const access = checkAccess(code, clientKey(await headers()));
  if (access !== "granted") return <AccessForm locked={access === "locked"} />;

  const sql = getSql();
  const managerId = MANAGERS.find((m) => m === requested) ?? MANAGERS[0];
  const scope = await managerScope(sql, managerId);
  if (!scope) return <p className="text-muted">Unknown manager.</p>;
  const data = await operationsDashboard(sql, scope.agencyIds);
  // Live state is always shown; the history sections only when the demonstration data exists.
  const h = data.history;
  const all = [...(h ? [h.volume, h.resolution, h.emergencies, h.monthly] : []), data.openNow].flatMap((r) => r.facts);
  const byKey = new Map(all.map((f) => [f.key, f]));
  const period = h?.volume.facts.find((f) => f.metric === "tickets_created" && f.agencyId === "all")?.period ?? "";
  const v = (metric: string, agencyId: string, p = period): Fact | undefined => byKey.get(`${metric}.${agencyId}.${p}`);
  // Notes name agencies by id; show their names.
  const named = (note: string) => data.agencies.reduce((text, a) => text.replaceAll(a.id, a.name), note);
  const notes = h ? [...new Set([...h.volume.notes, ...h.resolution.notes, ...h.emergencies.notes].map(named))] : [];

  // Every month of the window, from the cut-off — not just the months that returned figures.
  const months = h ? lastTwelveMonthKeys(h.asOf) : [];
  const emergencyMedian = (agencyId: string) => statistic(byKey, "median_hours_to_resolve_emergency", agencyId, period);
  const series: TrendSeries[] = data.agencies.map((a) => ({
    id: a.id,
    name: a.name,
    color: AGENCY_COLOR[a.id] ?? "var(--series-1)",
    points: (h?.monthly.facts ?? []).filter((f) => f.agencyId === a.id).map((f) => ({ month: f.period, value: f.value })),
  }));

  return (
    <div className="space-y-6">
      <form method="get" className="flex flex-wrap items-end gap-2">
        {typeof code === "string" && <input type="hidden" name="code" value={code} />}
        <div className="flex flex-col gap-1">
          <label htmlFor="manager" className="text-label text-muted">
            Signed in as (simulated)
          </label>
          <select id="manager" name="manager" defaultValue={managerId} className="rounded-md border border-border-strong bg-surface px-3 py-2 text-body">
            {MANAGERS.map((m) => (
              <option key={m} value={m}>
                {m === "manager_ops" ? "Sam Taylor — Operations director" : "Alex Morgan — North region"}
              </option>
            ))}
          </select>
        </div>
        <button type="submit" className="rounded-md border border-border-strong bg-surface px-3 py-2 text-body hover:bg-subtle">
          Switch
        </button>
      </form>

      <section aria-labelledby="now-heading" className="space-y-2 rounded-lg border border-border bg-surface p-4 shadow-panel">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="now-heading" className="text-title font-semibold">
            Open right now
          </h2>
          <p className="text-label text-muted">
            Live tickets · {new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(data.openNow.now)} UTC
          </p>
        </div>
        <div tabIndex={0} role="region" aria-labelledby="now-heading" className="overflow-x-auto">
          <table className="w-full text-body-sm">
            <thead className="text-left text-label text-muted">
              <tr>
                {["Agency", "Open", "Open emergencies", "Oldest emergency", "Reviews pending"].map((h, i) => (
                  <th key={h} scope="col" className={`border-b border-border py-1 pr-3 font-medium whitespace-nowrap ${i > 0 ? "text-right" : ""}`}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[...data.agencies.map((a) => ({ id: a.id, name: a.name })), { id: "all", name: "All your agencies" }].map((a) => {
                const emergencies = v("open_now_emergency", a.id, "now")?.value ?? 0;
                return (
                  <tr key={a.id} className={a.id === "all" ? "font-medium" : ""}>
                    <th scope="row" className="py-1 pr-3 text-left font-normal">{a.name}</th>
                    <td className="py-1 pr-3 text-right font-mono tabular-nums">{fmt(v("open_now", a.id, "now")?.value, 0)}</td>
                    <td className={`py-1 pr-3 text-right font-mono tabular-nums ${emergencies > 0 ? "text-emergency" : ""}`}>{emergencies}</td>
                    <td className="py-1 pr-3 text-right font-mono tabular-nums">
                      {v("oldest_open_emergency_hours", a.id, "now") ? `${fmt(v("oldest_open_emergency_hours", a.id, "now")?.value)} h` : "—"}
                    </td>
                    <td className="py-1 pr-3 text-right font-mono tabular-nums">{fmt(v("reviews_pending", a.id, "now")?.value, 0)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section aria-labelledby="attention-heading" className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="attention-heading" className="text-title font-semibold">
            Needs attention
          </h2>
          <p className="text-body-sm text-muted">
            {[
              data.attention.total === 0
                ? "No open tickets"
                : `${data.attention.total} open · ${v("open_now_emergency", "all", "now")?.value ?? 0} emergencies`,
              data.attention.reviewsWithoutTicket.length > 0 &&
                `${data.attention.reviewsWithoutTicket.length} ${data.attention.reviewsWithoutTicket.length === 1 ? "person requested" : "people requested"} without a ticket`,
              (data.attention.total > 0 || data.attention.reviewsWithoutTicket.length > 0) && "most urgent first",
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>
        {(data.attention.items.length > 0 || data.attention.reviewsWithoutTicket.length > 0) && (
          <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {data.attention.items.map((item) => (
              <AttentionCard key={item.ticketId} item={item} codeSuffix={typeof code === "string" && code ? `?code=${encodeURIComponent(code)}` : ""} />
            ))}
            {data.attention.reviewsWithoutTicket.map((item) => (
              <ReviewCard key={item.reviewId} item={item} codeSuffix={typeof code === "string" && code ? `?code=${encodeURIComponent(code)}` : ""} />
            ))}
          </ul>
        )}
        {data.attention.total > data.attention.items.length && (
          <p className="text-label text-muted">
            Showing the {data.attention.items.length} most urgent of {data.attention.total}.
          </p>
        )}
      </section>

      {h ? (
      <>
      <p role="note" className="rounded-md border border-dashed border-border-strong bg-surface px-3 py-2 text-body-sm">
        Below: <strong>synthetic history</strong> for demonstration, observed up to {day(h.asOf)}. Figures for {period}, the
        last closed quarter. Scope: {data.agencies.map((a) => a.name).join(", ")}.
      </p>

      <section aria-labelledby="kpi-heading">
        <h2 id="kpi-heading" className="mb-2 text-title font-semibold">
          {period} at a glance
        </h2>
        <dl className="grid grid-cols-2 gap-3 md:grid-cols-5">
          <Tile label="Tickets created" value={fmt(v("tickets_created", "all")?.value, 0)} />
          <Tile label="Resolved" value={`${fmt(v("resolved_share", "all")?.value)}%`} detail={`of ${fmt(v("tickets_in_cohort", "all")?.value, 0)} tickets`} />
          <Tile label="Median time to resolve" value={`${fmt(v("median_hours_to_resolve", "all")?.value)} h`} detail={`p90 ${fmt(v("p90_hours_to_resolve", "all")?.value)} h`} />
          <Tile
            label="Emergencies, median"
            value={emergencyMedian("all") ? `${fmt(emergencyMedian("all")?.value)} h` : "—"}
            detail={emergencyMedian("all") ? `over ${emergencyMedian("all")?.n} resolved` : "none resolved"}
          />
          <Tile
            label="Still open"
            value={fmt(v("open_at_as_of", "all")?.value, 0)}
            detail={
              v("open_median_age_days", "all")
                ? `median age ${fmt(v("open_median_age_days", "all")?.value)} days`
                : `at ${day(h.asOf)}`
            }
          />
        </dl>
      </section>

      <section aria-labelledby="trend-heading" className="space-y-2 rounded-lg border border-border bg-surface p-4 shadow-panel">
        <h2 id="trend-heading" className="text-title font-semibold">
          Tickets per 100 homes, by month
        </h2>
        <p className="text-body-sm text-muted">Normalised by homes managed, so agencies of different size compare fairly. Last 12 closed months.</p>
        <TrendChart series={series} months={months} />
        <details className="text-body-sm">
          <summary className="cursor-pointer text-muted">Show as a table</summary>
          <div tabIndex={0} role="region" aria-label="Monthly tickets per 100 homes" className="mt-2 overflow-x-auto">
            <table className="w-full text-body-sm">
              <thead className="text-left text-label text-muted">
                <tr>
                  <th scope="col" className="py-1 pr-3 font-medium">Month</th>
                  {series.map((s) => (
                    <th key={s.id} scope="col" className="py-1 pr-3 text-right font-medium">{s.name}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {months.map((m) => (
                  <tr key={m} className="border-t border-border">
                    <th scope="row" className="py-1 pr-3 text-left font-normal">{m}</th>
                    {series.map((s) => (
                      <td key={s.id} className="py-1 pr-3 text-right font-mono tabular-nums">
                        {fmt(s.points.find((p) => p.month === m)?.value, 2)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      </section>

      <section aria-labelledby="agencies-heading" className="space-y-2">
        <h2 id="agencies-heading" className="text-title font-semibold">
          Agencies, {period}
        </h2>
        <div tabIndex={0} role="region" aria-labelledby="agencies-heading" className="overflow-x-auto rounded-lg border border-border bg-surface shadow-panel">
          <table className="w-full text-body-sm">
            <thead className="bg-subtle text-left text-label text-muted">
              <tr>
                {["Agency", "Tickets", "vs prev.", "vs last year", "Per 100 homes / month", "Median to resolve", "p90", "Emergencies, median", "Open now"].map((h, i) => (
                  <th key={h} scope="col" className={`border-b border-border px-3 py-2 font-medium whitespace-nowrap ${i > 0 ? "text-right" : ""}`}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.agencies.map((a) => (
                <tr key={a.id} className="border-b border-border last:border-0">
                  <th scope="row" className="px-3 py-2 text-left font-normal">
                    <span className="flex items-center gap-2">
                      <span className="inline-block h-0.5 w-3 rounded" style={{ background: AGENCY_COLOR[a.id] }} aria-hidden="true" />
                      {a.name}
                    </span>
                    {a.acquiredOn && (
                      <span className="block text-label text-muted">
                        Acquired {day(a.acquiredOn)}
                        {a.onboardedOn && ` · onboarded ${day(a.onboardedOn)}`}
                      </span>
                    )}
                  </th>
                  <td className="px-3 py-2 text-right font-mono tabular-nums">{fmt(v("tickets_created", a.id)?.value, 0)}</td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums">{signed(v("change_vs_previous_period", a.id)?.value)}</td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums">{signed(v("change_vs_same_period_last_year", a.id)?.value)}</td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums">{fmt(v("tickets_per_100_homes", a.id)?.value, 2)}</td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums">
                    {fmt(v("median_hours_to_resolve", a.id)?.value)} h
                    <span className="block text-label text-muted">n = {fmt(v("median_hours_to_resolve", a.id)?.n, 0)}</span>
                  </td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums">{fmt(v("p90_hours_to_resolve", a.id)?.value)} h</td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums">
                    {emergencyMedian(a.id) ? `${fmt(emergencyMedian(a.id)?.value)} h` : "—"}
                    <span className="block text-label text-muted">n = {emergencyMedian(a.id)?.n ?? 0}</span>
                  </td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums">{fmt(v("open_at_as_of", a.id)?.value, 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {notes.length > 0 && (
          <ul className="list-disc space-y-0.5 pl-5 text-label text-muted">
            {notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        )}
        <p className="text-label text-muted">
          Riverside&apos;s faster resolution after onboarding is a simulated scenario in the generated data, not a measured
          effect.
        </p>
      </section>

      </>
      ) : (
        <p role="note" className="rounded-md border border-dashed border-border-strong bg-surface px-3 py-2 text-body-sm text-muted">
          No demonstration history yet, so trends aren&apos;t shown. Generate it with <code>pnpm seed:history</code>.
        </p>
      )}

      <BriefBox
        key={managerId}
        managerId={managerId}
        accessCode={typeof code === "string" ? code : null}
        examples={["How many emergencies are open?", "How did reports trend last quarter?", "Which agency is slowest on emergencies?"]}
      />
    </div>
  );
}

export default function OperationsPage({ searchParams }: PageProps<"/operations">) {
  return (
    <main className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-title-lg font-semibold tracking-tight">Operations</h1>
          <p className="text-body text-muted">How maintenance is going across your agencies</p>
        </div>
        <DemoNav current="operations" searchParams={searchParams} />
      </header>
      <Suspense fallback={<p className="text-muted">Loading…</p>}>
        <Dashboard searchParams={searchParams} />
      </Suspense>
    </main>
  );
}
