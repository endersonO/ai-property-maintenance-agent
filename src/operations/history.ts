import type { Category, Hazard } from "@/domain/enums";
import { evaluatePolicy, type Policy } from "@/domain/policy";
import * as seed from "@/infra/seed-data";

// Deterministic synthetic history for the operations view: same seed and asOf, same rows.
// Priority, estimated cost and "sent to review" come from each agency's real policy, so the
// history obeys the same rules as live tickets. Everything here is simulated and labelled so.

export type HistoryAgency = {
  id: string;
  policy: Policy;
  // Homes managed: at the start of the window and growth per month.
  properties: number;
  monthlyGrowth: number;
  // Acquired agencies only have history from this date (ISO), and resolve more slowly
  // before onboarding — a simulated scenario, not a measured effect.
  historyStartsOn?: string | null;
  onboardedOn?: string | null;
  // Multiplier on resolution times (1 = baseline).
  speed: number;
};

export type HistoryTicket = {
  agencyId: string;
  category: Category;
  hazards: Hazard[];
  priority: "emergency" | "high" | "normal" | "low";
  estimatedCostGbp: number;
  sentToReview: boolean;
  status: "open" | "resolved" | "cancelled";
  createdAt: Date;
  resolvedAt: Date | null;
  cancelledAt: Date | null;
};

export type PortfolioMonth = { agencyId: string; month: string; properties: number };

// asOf: the instant the history is observed up to; seed: how to regenerate it.
export type History = { tickets: HistoryTicket[]; portfolio: PortfolioMonth[]; asOf: Date; seed: number };

export type HistoryOptions = {
  seed: number;
  // First day of the month after the last closed month (e.g. 2026-11-01).
  asOf: Date;
  months: number;
  // Tickets per 100 homes per month, before seasonality.
  baseRate: number;
};

export const DEFAULT_HISTORY: HistoryOptions = {
  seed: 20261101,
  asOf: new Date("2026-11-01T00:00:00Z"),
  months: 24,
  baseRate: 5,
};

// mulberry32: tiny, fast and reproducible.
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Share of each category in a month (0 = January). Heating peaks in winter, pests in summer.
function categoryWeights(month: number): Record<Category, number> {
  const winter = [11, 0, 1].includes(month) ? 1 : [10, 2].includes(month) ? 0.5 : 0;
  const summer = [5, 6, 7].includes(month) ? 1 : [4, 8].includes(month) ? 0.5 : 0;
  return {
    plumbing: 30,
    electrical: 12,
    heating: 12 + 28 * winter,
    appliance: 16,
    structural: 8,
    pest: 4 + 10 * summer,
    other: 8,
  };
}

const HAZARD_ODDS: Partial<Record<Category, [Hazard, number][]>> = {
  plumbing: [["active_water_leak", 0.18]],
  heating: [
    ["no_heating", 0.35],
    ["no_hot_water", 0.2],
    ["gas_smell", 0.03],
  ],
  electrical: [["electrical_hazard", 0.12]],
  structural: [["security_risk", 0.1]],
};

// Median calendar hours to resolve, by priority.
const MEDIAN_HOURS = { emergency: 6, high: 30, normal: 96, low: 168 } as const;
const CANCELLED_SHARE = 0.03;
const HOUR = 3_600_000;

const monthStart = (asOf: Date, monthsBack: number) =>
  new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth() - monthsBack, 1));

export function generateHistory(agencies: HistoryAgency[], options: HistoryOptions = DEFAULT_HISTORY): History {
  const random = rng(options.seed);
  const normal = () => {
    // Box–Muller.
    const u = 1 - random();
    const v = random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  const pick = <K extends string>(weights: Record<K, number>): K => {
    const entries = Object.entries(weights) as [K, number][];
    let r = random() * entries.reduce((sum, [, w]) => sum + w, 0);
    for (const [key, w] of entries) if ((r -= w) < 0) return key;
    return entries[entries.length - 1][0];
  };

  const tickets: HistoryTicket[] = [];
  const portfolio: PortfolioMonth[] = [];

  for (let back = options.months; back >= 1; back--) {
    const start = monthStart(options.asOf, back);
    const end = monthStart(options.asOf, back - 1);
    const monthIndex = options.months - back;

    for (const agency of agencies) {
      if (agency.historyStartsOn && start < new Date(`${agency.historyStartsOn}T00:00:00Z`)) continue;
      const properties = Math.round(agency.properties * (1 + agency.monthlyGrowth) ** monthIndex);
      portfolio.push({ agencyId: agency.id, month: start.toISOString().slice(0, 10), properties });

      const expected = (properties / 100) * options.baseRate;
      const count = Math.max(0, Math.round(expected * (1 + 0.15 * normal())));
      for (let i = 0; i < count; i++) {
        const category = pick(categoryWeights(start.getUTCMonth()));
        const hazards = (HAZARD_ODDS[category] ?? []).filter(([, odds]) => random() < odds).map(([h]) => h);
        const decision = evaluatePolicy(agency.policy, { category, hazards });
        const createdAt = new Date(start.getTime() + random() * (end.getTime() - start.getTime()));

        const onboarded = agency.onboardedOn ? new Date(`${agency.onboardedOn}T00:00:00Z`) : null;
        const slowdown = onboarded && createdAt < onboarded ? 2 : 1;
        const hours = MEDIAN_HOURS[decision.priority] * agency.speed * slowdown * Math.exp(0.5 * normal());
        const resolvedAt = new Date(createdAt.getTime() + Math.max(0.25, hours) * HOUR);

        // A cancellation happens within three days; one after asOf hasn't happened yet.
        const cancelledAt = random() < CANCELLED_SHARE ? new Date(createdAt.getTime() + random() * 72 * HOUR) : null;
        const status =
          cancelledAt && cancelledAt < options.asOf ? "cancelled" : !cancelledAt && resolvedAt < options.asOf ? "resolved" : "open";
        tickets.push({
          agencyId: agency.id,
          category,
          hazards,
          priority: decision.priority,
          estimatedCostGbp: decision.estimatedCostGbp,
          sentToReview: decision.forceReview,
          status,
          createdAt,
          resolvedAt: status === "resolved" ? resolvedAt : null,
          cancelledAt: status === "cancelled" ? cancelledAt : null,
        });
      }
    }
  }
  return { tickets, portfolio, asOf: options.asOf, seed: options.seed };
}

// The demo's agencies: their real policies and lifecycle from the seed, plus simulated size
// and speed. Northbridge is the baseline; Harbour Lane a bit slower; Riverside joined by
// acquisition and resolves slowly until onboarding (the scenario the data illustrates).
export function demoHistoryAgencies(): HistoryAgency[] {
  const policy = (id: string) => seed.policies.find((p) => p.agencyId === id)!.policy;
  const agency = (id: string) => seed.agencies.find((a) => a.id === id)!;
  return [
    { id: "agency_northbridge", policy: policy("agency_northbridge"), properties: 420, monthlyGrowth: 0.004, speed: 1 },
    { id: "agency_harbour_lane", policy: policy("agency_harbour_lane"), properties: 260, monthlyGrowth: 0, speed: 1.15 },
    {
      id: "agency_riverside",
      policy: policy("agency_riverside"),
      properties: 300,
      monthlyGrowth: 0,
      speed: 1.1,
      historyStartsOn: agency("agency_riverside").historyStartsOn,
      onboardedOn: agency("agency_riverside").onboardedOn,
    },
  ];
}
