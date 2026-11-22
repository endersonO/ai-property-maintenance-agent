import { describe, expect, it } from "vitest";
import { evaluatePolicy, Policy } from "./policy";

// Same rules as db/seed.sql.
const northbridge = Policy.parse({
  rules: [
    {
      if: { hazardsAny: ["gas_smell", "active_water_leak", "electrical_hazard"] },
      priority: "emergency",
      forceReview: true,
    },
    { if: { category: "heating", hazardsAny: ["no_heating"] }, priority: "high" },
    { if: { hazardsAny: ["security_risk"] }, priority: "high" },
  ],
  defaultPriority: "normal",
  costEstimatesGbp: { plumbing: 180, electrical: 300, heating: 400, appliance: 120 },
  defaultCostEstimateGbp: 150,
  reviewAboveGbp: 250,
});

const harbourLane = Policy.parse({
  rules: [
    {
      if: { hazardsAny: ["gas_smell", "active_water_leak", "electrical_hazard"] },
      priority: "emergency",
      forceReview: true,
    },
    { if: { hazardsAny: ["no_heating", "no_hot_water", "security_risk"] }, priority: "high" },
  ],
  defaultPriority: "normal",
  costEstimatesGbp: { plumbing: 220, electrical: 350, heating: 450, appliance: 150 },
  defaultCostEstimateGbp: 180,
  reviewAboveGbp: 0,
});

describe("evaluatePolicy", () => {
  it("routine appliance fault at Northbridge: normal, no review", () => {
    expect(evaluatePolicy(northbridge, { category: "appliance", hazards: [] })).toEqual({
      priority: "normal",
      estimatedCostGbp: 120,
      forceReview: false,
      reviewReasons: [],
      matchedRule: null,
    });
  });

  it("same fault at Harbour Lane: normal, but review forced by the £0 threshold", () => {
    const d = evaluatePolicy(harbourLane, { category: "appliance", hazards: [] });
    expect(d.priority).toBe("normal");
    expect(d.forceReview).toBe(true);
    expect(d.reviewReasons).toEqual(["estimated cost £150 exceeds review threshold £0"]);
  });

  it("active water leak: emergency with forced review", () => {
    const d = evaluatePolicy(northbridge, { category: "plumbing", hazards: ["active_water_leak"] });
    expect(d.priority).toBe("emergency");
    expect(d.forceReview).toBe(true);
    expect(d.matchedRule).toBe(0);
  });

  it("forces review on cost alone when no rule requires it", () => {
    const d = evaluatePolicy(northbridge, { category: "heating", hazards: ["no_heating"] });
    expect(d.priority).toBe("high");
    expect(d.reviewReasons).toEqual(["estimated cost £400 exceeds review threshold £250"]);
  });

  it("first matching rule wins", () => {
    const d = evaluatePolicy(northbridge, {
      category: "heating",
      hazards: ["no_heating", "gas_smell"],
    });
    expect(d.priority).toBe("emergency");
    expect(d.matchedRule).toBe(0);
  });

  it("a category condition alone does not match other categories", () => {
    const d = evaluatePolicy(northbridge, { category: "plumbing", hazards: ["no_heating"] });
    expect(d.priority).toBe("normal");
    expect(d.matchedRule).toBeNull();
  });

  it("falls back to the default cost estimate for unlisted categories", () => {
    expect(evaluatePolicy(northbridge, { category: "pest", hazards: [] }).estimatedCostGbp).toBe(150);
  });
});

describe("platform invariant", () => {
  it("an emergency forces review even if the agency rule does not ask for it", () => {
    const lenient = Policy.parse({
      ...northbridge,
      rules: [{ if: { hazardsAny: ["gas_smell"] }, priority: "emergency" }],
      reviewAboveGbp: 10_000,
    });
    const d = evaluatePolicy(lenient, { category: "heating", hazards: ["gas_smell"] });
    expect(d.priority).toBe("emergency");
    expect(d.forceReview).toBe(true);
    expect(d.reviewReasons).toEqual(["emergencies always require human review"]);
  });

  it("also applies when the default priority is emergency", () => {
    const allEmergency = Policy.parse({
      ...northbridge,
      rules: [],
      defaultPriority: "emergency",
      reviewAboveGbp: 10_000,
    });
    expect(evaluatePolicy(allEmergency, { category: "pest", hazards: [] }).forceReview).toBe(true);
  });
});

describe("Policy schema", () => {
  it("rejects misspelled rule conditions instead of dropping them", () => {
    expect(() =>
      Policy.parse({
        ...northbridge,
        rules: [{ if: { category: "heating", hazardAny: ["no_heating"] }, priority: "high" }],
      }),
    ).toThrow(/hazardAny/);
  });

  it("rejects unknown top-level keys", () => {
    expect(() => Policy.parse({ ...northbridge, reviewAbove: 100 })).toThrow(/reviewAbove/);
  });

  it("rejects a rule without conditions", () => {
    expect(() =>
      Policy.parse({ ...northbridge, rules: [{ if: {}, priority: "high" }] }),
    ).toThrow(/at least one condition/);
  });

  it("rejects unknown hazards", () => {
    expect(() =>
      Policy.parse({ ...northbridge, rules: [{ if: { hazardsAny: ["fire"] }, priority: "high" }] }),
    ).toThrow();
  });
});
