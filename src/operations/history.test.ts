import { describe, expect, it } from "vitest";
import { evaluatePolicy } from "@/domain/policy";
import { DEFAULT_HISTORY, demoHistoryAgencies, generateHistory, type HistoryTicket } from "./history";

const agencies = demoHistoryAgencies();
const history = generateHistory(agencies);
const policyOf = (id: string) => agencies.find((a) => a.id === id)!.policy;
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const hours = (t: HistoryTicket) => (t.resolvedAt!.getTime() - t.createdAt.getTime()) / 3_600_000;

describe("generateHistory", () => {
  it("is deterministic for a seed and changes with it", () => {
    expect(generateHistory(agencies)).toEqual(history);
    expect(generateHistory(agencies, { ...DEFAULT_HISTORY, seed: 1 }).tickets).not.toEqual(history.tickets);
  });

  it("covers 24 closed months before asOf, with a realistic volume", () => {
    const first = new Date("2024-11-01T00:00:00Z");
    expect(history.tickets.every((t) => t.createdAt >= first && t.createdAt < DEFAULT_HISTORY.asOf)).toBe(true);
    expect(history.tickets.length).toBeGreaterThan(800);
    expect(history.tickets.length).toBeLessThan(2000);
  });

  it("obeys each agency's real policy for priority, cost and review", () => {
    for (const t of history.tickets) {
      const decision = evaluatePolicy(policyOf(t.agencyId), { category: t.category, hazards: t.hazards });
      expect([t.priority, t.estimatedCostGbp, t.sentToReview]).toEqual([
        decision.priority,
        decision.estimatedCostGbp,
        decision.forceReview,
      ]);
    }
  });

  it("respects the resolution constraints and leaves some tickets open at asOf", () => {
    for (const t of history.tickets) {
      expect(t.status === "resolved").toBe(t.resolvedAt !== null);
      if (t.resolvedAt) {
        expect(t.resolvedAt >= t.createdAt).toBe(true);
        expect(t.resolvedAt < DEFAULT_HISTORY.asOf).toBe(true);
      }
    }
    expect(history.tickets.some((t) => t.status === "open")).toBe(true);
    expect(history.tickets.some((t) => t.status === "cancelled")).toBe(true);
  });

  it("has no Riverside history before its acquisition", () => {
    const riverside = history.tickets.filter((t) => t.agencyId === "agency_riverside");
    expect(riverside.length).toBeGreaterThan(0);
    expect(riverside.every((t) => t.createdAt >= new Date("2026-03-01T00:00:00Z"))).toBe(true);
    expect(history.portfolio.filter((p) => p.agencyId === "agency_riverside").map((p) => p.month)[0]).toBe("2026-03-01");
  });

  it("has the seasonal shape: heating peaks in winter, pests in summer", () => {
    const count = (category: string, months: number[]) =>
      history.tickets.filter((t) => t.category === category && months.includes(t.createdAt.getUTCMonth())).length;
    expect(count("heating", [11, 0, 1])).toBeGreaterThan(2 * count("heating", [5, 6, 7]));
    expect(count("pest", [5, 6, 7])).toBeGreaterThan(2 * count("pest", [11, 0, 1]));
  });

  it("simulates Riverside resolving faster after onboarding", () => {
    const onboarded = new Date("2026-06-01T00:00:00Z");
    const resolved = history.tickets.filter((t) => t.agencyId === "agency_riverside" && t.resolvedAt && t.priority === "normal");
    const before = median(resolved.filter((t) => t.createdAt < onboarded).map(hours));
    const after = median(resolved.filter((t) => t.createdAt >= onboarded).map(hours));
    expect(before).toBeGreaterThan(1.4 * after);
  });
});
