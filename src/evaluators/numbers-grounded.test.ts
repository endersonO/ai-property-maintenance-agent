import { describe, expect, it } from "vitest";
import { checkGrounding } from "./numbers-grounded";

const facts = new Map(
  [
    { key: "median_hours_to_resolve.agency_northbridge.2026-Q3", agency: "Northbridge Lettings", value: 4 },
    { key: "median_hours_to_resolve.agency_harbour_lane.2026-Q3", agency: "Harbour Lane Estates", value: 8 },
    { key: "median_hours_to_resolve_emergency.agency_riverside.2026-Q3", agency: "Riverside Homes", value: 6.12 },
    { key: "tickets_created.all.2026-Q3", agency: "all your agencies", value: 147 },
  ].map((f) => [f.key, f]),
);
const problems = (reply: string) => checkGrounding(reply, facts).map((p) => p.problem);

describe("numbers_grounded", () => {
  it("passes figures that match the facts they cite, for the agency named", () => {
    expect(
      problems(
        "In 2026-Q3 Northbridge took a median of 4 hours [median_hours_to_resolve.agency_northbridge.2026-Q3] and " +
          "Harbour Lane 8 hours [median_hours_to_resolve.agency_harbour_lane.2026-Q3]. Across all agencies, 147 tickets " +
          "[tickets_created.all.2026-Q3].",
      ),
    ).toEqual([]);
  });

  it("fails swapped agencies even though both numbers are real values", () => {
    expect(
      problems(
        "Northbridge took 8 hours [median_hours_to_resolve.agency_northbridge.2026-Q3] and Harbour Lane 4 hours [median_hours_to_resolve.agency_harbour_lane.2026-Q3].",
      ),
    ).toEqual([
      "8 does not match [median_hours_to_resolve.agency_northbridge.2026-Q3] = 4",
      "4 does not match [median_hours_to_resolve.agency_harbour_lane.2026-Q3] = 8",
    ]);
  });

  it("fails a citation of another agency's fact", () => {
    expect(problems("Northbridge took 8 hours [median_hours_to_resolve.agency_harbour_lane.2026-Q3].")).toEqual([
      "[median_hours_to_resolve.agency_harbour_lane.2026-Q3] is about Harbour Lane Estates, but the sentence is talking about Northbridge Lettings",
    ]);
    expect(problems("It took 8 hours [median_hours_to_resolve.agency_harbour_lane.2026-Q3].")).toEqual([
      "[median_hours_to_resolve.agency_harbour_lane.2026-Q3] is about Harbour Lane Estates, but the sentence names no agency",
    ]);
  });

  it("attributes a figure to the agency named last before it", () => {
    expect(
      problems(
        "Harbour Lane took 8 hours [median_hours_to_resolve.agency_harbour_lane.2026-Q3] and Northbridge 8 hours [median_hours_to_resolve.agency_harbour_lane.2026-Q3].",
      ),
    ).toEqual([
      "[median_hours_to_resolve.agency_harbour_lane.2026-Q3] is about Harbour Lane Estates, but the sentence is talking about Northbridge Lettings",
    ]);
  });

  it("accepts rounding to the precision written, not beyond it", () => {
    expect(problems("Riverside: 6.1 hours [median_hours_to_resolve_emergency.agency_riverside.2026-Q3].")).toEqual([]);
    expect(problems("Riverside: 6 hours [median_hours_to_resolve_emergency.agency_riverside.2026-Q3].")).toEqual([]);
    expect(problems("Riverside: 6.2 hours [median_hours_to_resolve_emergency.agency_riverside.2026-Q3].")).toHaveLength(1);
  });

  it("fails uncited figures and citations no tool returned", () => {
    expect(problems("Riverside resolved 90% of tickets.")).toEqual(["90 is not followed by a citation"]);
    expect(problems("Riverside: 3 hours [median_hours.agency_riverside.2027-Q1].")).toEqual([
      "cites [median_hours.agency_riverside.2027-Q1], which no tool returned",
    ]);
    expect(problems("Riverside: 6 and 7 hours [median_hours_to_resolve_emergency.agency_riverside.2026-Q3].")).toEqual([
      "7 has no citation of its own",
    ]);
  });

  it("respects the direction of a change: written sign first, then words", () => {
    const change = (value: number) =>
      new Map([["change_vs_previous_period.agency_northbridge.2026-Q3", {
        key: "change_vs_previous_period.agency_northbridge.2026-Q3",
        metric: "change_vs_previous_period",
        agency: "Northbridge Lettings",
        value,
      }]]);
    const check = (reply: string, value: number) => checkGrounding(reply, change(value)).map((p) => p.problem);
    const k = "[change_vs_previous_period.agency_northbridge.2026-Q3]";
    expect(check(`Northbridge fell 5% ${k}.`, 5)).toHaveLength(1);
    expect(check(`Northbridge fell 5% ${k}.`, -5)).toEqual([]);
    expect(check(`Northbridge changed by -5% ${k}.`, -5)).toEqual([]);
    expect(check(`Northbridge changed by −5% ${k}.`, -5)).toEqual([]);
    expect(check(`Northbridge changed by -5% ${k}.`, 5)).toHaveLength(1);
    expect(check(`Northbridge rose 5% ${k}.`, -5)).toHaveLength(1);
    expect(check(`Northbridge rose 5% ${k}.`, 5)).toEqual([]);
  });

  it("never takes a direction from words for metrics that aren't changes", () => {
    expect(problems("Riverside had a lower median of 6.1 hours [median_hours_to_resolve_emergency.agency_riverside.2026-Q3].")).toEqual([]);
  });

  it("lets a statistic be written with its own n, but no other extra figure", () => {
    const share = new Map([["resolved_share.agency_riverside.2026-Q3", {
      key: "resolved_share.agency_riverside.2026-Q3",
      metric: "resolved_share",
      agency: "Riverside Homes",
      value: 100,
      n: 43,
    }]]);
    const check = (reply: string) => checkGrounding(reply, share).map((p) => p.problem);
    expect(check("Riverside Homes resolved 100% of its 43 tickets [resolved_share.agency_riverside.2026-Q3].")).toEqual([]);
    expect(check("Riverside Homes resolved 100% of its 44 tickets [resolved_share.agency_riverside.2026-Q3].")).toEqual([
      "44 has no citation of its own",
    ]);
  });

  it("ignores a bracketed label that carries no figure", () => {
    expect(problems("This is synthetic demonstration data [dataset], with states as of 2026-11-01.")).toEqual([]);
    expect(problems("Based on live data as of 2026-11-23 00:12 UTC.")).toEqual([]);
  });

  it("ignores periods, dates, years and coverage notes", () => {
    expect(
      problems("Data for 2026-Q3 and 2025-11..2026-10, as of 2026-11-01, covers 2 of 3 months; tickets per 100 homes are shown."),
    ).toEqual([]);
  });

  // A real gemini-3.5-flash-lite brief (2026-11-23): correct figures, written the way a model
  // writes them — one agency name for several figures, "down 19.5%" for -19.5, notes quoted.
  it("passes a real model brief with correct figures", () => {
    const f = (metric: string, agency: string, agencyId: string, value: number) => ({
      key: `${metric}.${agencyId}.2026-Q3`,
      agency,
      value,
    });
    const real = new Map(
      [
        f("tickets_created", "Harbour Lane Estates", "agency_harbour_lane", 39),
        f("change_vs_previous_period", "Harbour Lane Estates", "agency_harbour_lane", 14.7),
        f("change_vs_same_period_last_year", "Harbour Lane Estates", "agency_harbour_lane", 11.4),
        f("tickets_per_100_homes", "Harbour Lane Estates", "agency_harbour_lane", 5.04),
        f("tickets_created", "Northbridge Lettings", "agency_northbridge", 62),
        f("change_vs_previous_period", "Northbridge Lettings", "agency_northbridge", 5.1),
        f("change_vs_same_period_last_year", "Northbridge Lettings", "agency_northbridge", -19.5),
        f("tickets_per_100_homes", "Northbridge Lettings", "agency_northbridge", 4.52),
        f("tickets_created", "all your agencies", "all", 144),
        f("median_hours_to_resolve_emergency", "Northbridge Lettings", "agency_northbridge", 7.1),
        f("p90_hours_to_resolve_emergency", "Northbridge Lettings", "agency_northbridge", 9.5),
        f("tickets_in_cohort_emergency", "Riverside Homes", "agency_riverside", 0),
      ].map((x) => [x.key, x]),
    );
    const reply = [
      "Harbour Lane Estates created 39 tickets [tickets_created.agency_harbour_lane.2026-Q3], which is up 14.7% compared to the previous period [change_vs_previous_period.agency_harbour_lane.2026-Q3] and up 11.4% compared to the same period last year [change_vs_same_period_last_year.agency_harbour_lane.2026-Q3], at a rate of 5 tickets per 100 homes per month [tickets_per_100_homes.agency_harbour_lane.2026-Q3].",
      "Northbridge Lettings created 62 tickets [tickets_created.agency_northbridge.2026-Q3], a 5.1% increase from the previous period [change_vs_previous_period.agency_northbridge.2026-Q3] but down 19.5% from the same period last year [change_vs_same_period_last_year.agency_northbridge.2026-Q3], at a rate of 4.52 tickets per 100 homes per month [tickets_per_100_homes.agency_northbridge.2026-Q3].",
      "(Note: Riverside Homes has no comparison for the same period last year due to missing historical data coverage [agency_riverside: no change_vs_same_period_last_year — data covers 3/3 months of 2026-Q3 and 0/3 of 2025-Q3.]).",
      "Across all agencies, a total of 144 tickets were created [tickets_created.all.2026-Q3].",
      "Northbridge Lettings resolved emergency tickets in a median of 7.1 hours [median_hours_to_resolve_emergency.agency_northbridge.2026-Q3] with a P90 of 9.5 hours [p90_hours_to_resolve_emergency.agency_northbridge.2026-Q3].",
      "Riverside Homes recorded 0 emergency tickets in the cohort for this period [tickets_in_cohort_emergency.agency_riverside.2026-Q3].",
    ].join("\n");
    expect(checkGrounding(reply, real).map((p) => p.problem)).toEqual([]);
    // The same brief with a positive sign word on a negative change is caught.
    expect(checkGrounding(reply.replace("but down 19.5%", "and up 19.5%"), real).map((p) => p.problem)).toEqual([
      "19.5 does not match [change_vs_same_period_last_year.agency_northbridge.2026-Q3] = -19.5",
    ]);
  });
});
