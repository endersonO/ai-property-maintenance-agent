import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Fact } from "@/infra/operations-queries";
import { statistic } from "./figures";
import { TrendChart } from "./trend-chart";

describe("operations view", () => {
  it("the emergency median reports the resolved tickets it was computed on, not the cohort", () => {
    const facts = new Map<string, Fact>(
      [
        { key: "median_hours_to_resolve_emergency.all.2026-Q3", metric: "median_hours_to_resolve_emergency", agencyId: "all", period: "2026-Q3", unit: "hours", value: 6, n: 1 },
        { key: "tickets_in_cohort_emergency.all.2026-Q3", metric: "tickets_in_cohort_emergency", agencyId: "all", period: "2026-Q3", unit: "tickets", value: 5 },
      ].map((f) => [f.key, f as Fact]),
    );
    expect(statistic(facts, "median_hours_to_resolve_emergency", "all", "2026-Q3")).toEqual({ value: 6, n: 1 });
    expect(statistic(facts, "median_hours_to_resolve_emergency", "agency_riverside", "2026-Q3")).toBeNull();
  });

  it("the trend chart says 'no data' instead of mounting an empty interactive chart", () => {
    const html = renderToString(createElement(TrendChart, { series: [], months: [] }));
    expect(html).toContain("No data for this period.");
    expect(html).not.toContain("<svg");
  });

  it("a month without data breaks the line instead of joining its neighbours", () => {
    const html = renderToString(
      createElement(TrendChart, {
        months: ["2026-01", "2026-02", "2026-03"],
        series: [{ id: "a", name: "A", color: "red", points: [{ month: "2026-01", value: 2 }, { month: "2026-03", value: 3 }] }],
      }),
    );
    const d = /<path d="([^"]+)"/.exec(html)?.[1] ?? "";
    // Two separate moves (M…M), no line segment (L) bridging February.
    expect(d.match(/M/g)).toHaveLength(2);
    expect(d).not.toContain("L");
  });
});
