import { describe, expect, it } from "vitest";
import { parseFailingFilter } from "./filters";

const ids = ["hazard_logged", "emergency_reviewed"];

describe("parseFailingFilter", () => {
  it("keeps links saved in the old format (a bare evaluator id = failed or couldn't run)", () => {
    expect(parseFailingFilter("hazard_logged", ids)).toEqual({ failing: "hazard_logged", evaluatorId: "hazard_logged", verdict: null, dropped: null });
  });

  it("accepts the headline sets and one evaluator with one verdict", () => {
    expect(parseFailingFilter("alarms", ids).failing).toBe("alarms");
    expect(parseFailingFilter("hazard_logged:error", ids)).toMatchObject({ failing: "hazard_logged:error", verdict: "error" });
  });

  it("reports an unknown filter instead of silently dropping it", () => {
    for (const bad of ["nope", "hazard_logged:maybe", "hazard_logged:fail:x", "other:fail"]) {
      expect(parseFailingFilter(bad, ids)).toMatchObject({ failing: null, dropped: bad });
    }
    expect(parseFailingFilter(undefined, ids)).toMatchObject({ failing: null, dropped: null });
    // A repeated parameter is reported too, not treated as "no filter".
    expect(parseFailingFilter(["rules", "errors"], ids)).toMatchObject({ failing: null, dropped: "rules, errors" });
  });
});
