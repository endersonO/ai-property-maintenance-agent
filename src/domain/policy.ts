import { z } from "zod";
import { Category, Hazard, Priority } from "./enums";

// Per-agency policy, stored as JSON in `policies.rules` and validated here.
// Strict objects: a misspelled key (e.g. `hazardAny`) is rejected, not silently dropped.

const Rule = z
  .strictObject({
    if: z.strictObject({
      category: Category.optional(),
      hazardsAny: z.array(Hazard).min(1).optional(),
    }),
    priority: Priority,
    forceReview: z.boolean().default(false),
  })
  .refine((r) => r.if.category !== undefined || r.if.hazardsAny !== undefined, {
    message: "A rule needs at least one condition",
  });

export const Policy = z.strictObject({
  rules: z.array(Rule),
  defaultPriority: Priority,
  costEstimatesGbp: z.partialRecord(Category, z.number().nonnegative()),
  defaultCostEstimateGbp: z.number().nonnegative(),
  reviewAboveGbp: z.number().nonnegative(),
});
export type Policy = z.infer<typeof Policy>;

export type PolicyInput = { category: Category; hazards: Hazard[] };

export type PolicyDecision = {
  priority: Priority;
  estimatedCostGbp: number;
  forceReview: boolean;
  reviewReasons: string[];
  // Index of the rule that set the priority; null when the default applied.
  matchedRule: number | null;
};

// Pure: no database, no model. First matching rule sets the priority; review is forced
// by the rule itself, by the estimated cost exceeding the agency's threshold, or by the
// platform invariant that every emergency reaches a human, whatever the agency policy says.
export function evaluatePolicy(policy: Policy, input: PolicyInput): PolicyDecision {
  const matchedRule = policy.rules.findIndex(
    (rule) =>
      (rule.if.category === undefined || rule.if.category === input.category) &&
      (rule.if.hazardsAny === undefined ||
        rule.if.hazardsAny.some((h) => input.hazards.includes(h))),
  );
  const rule = matchedRule === -1 ? null : policy.rules[matchedRule];

  const estimatedCostGbp =
    policy.costEstimatesGbp[input.category] ?? policy.defaultCostEstimateGbp;

  const reviewReasons: string[] = [];
  if (rule?.forceReview) {
    reviewReasons.push(`rule ${matchedRule} (${rule.priority}) requires review`);
  }
  if (estimatedCostGbp > policy.reviewAboveGbp) {
    reviewReasons.push(
      `estimated cost £${estimatedCostGbp} exceeds review threshold £${policy.reviewAboveGbp}`,
    );
  }

  const priority = rule?.priority ?? policy.defaultPriority;
  if (priority === "emergency" && !rule?.forceReview) {
    reviewReasons.unshift("emergencies always require human review");
  }

  return {
    priority,
    estimatedCostGbp,
    forceReview: reviewReasons.length > 0,
    reviewReasons,
    matchedRule: rule ? matchedRule : null,
  };
}
