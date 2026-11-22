import { describe, expect, it } from "vitest";
import { lastTwelveMonthKeys, periodRanges } from "./periods";

const asOf = new Date("2026-11-01T00:00:00Z");
const labels = (p: ReturnType<typeof periodRanges>) => [p.current.label, p.previous.label, p.lastYear.label, p.months];

describe("periodRanges", () => {
  it("last closed month, the one before, and the same month last year", () => {
    expect(labels(periodRanges("last_closed_month", asOf))).toEqual(["2026-10", "2026-09", "2025-10", 1]);
  });

  it("last closed quarter never includes the quarter asOf falls in", () => {
    expect(labels(periodRanges("last_closed_quarter", asOf))).toEqual(["2026-Q3", "2026-Q2", "2025-Q3", 3]);
    expect(periodRanges("last_closed_quarter", new Date("2026-10-01T00:00:00Z")).current.label).toBe("2026-Q3");
    expect(periodRanges("last_closed_quarter", new Date("2026-07-01T00:00:00Z")).current.label).toBe("2026-Q2");
    const q3 = periodRanges("last_closed_quarter", asOf).current;
    expect([q3.start.toISOString(), q3.end.toISOString()]).toEqual(["2026-07-01T00:00:00.000Z", "2026-10-01T00:00:00.000Z"]);
  });

  it("last 12 closed months against the 12 before", () => {
    expect(labels(periodRanges("last_12_closed_months", asOf))).toEqual([
      "2025-11..2026-10",
      "2024-11..2025-10",
      "2024-11..2025-10",
      12,
    ]);
  });

  it("lists all 12 closed months before the cut-off, with or without data", () => {
    const months = lastTwelveMonthKeys(asOf);
    expect(months).toHaveLength(12);
    expect([months[0], months[1], months[11]]).toEqual(["2025-11", "2025-12", "2026-10"]);
  });
});
