import type { Fact } from "@/infra/operations-queries";

// A statistic and the sample it was computed on. For a median, n is the number of RESOLVED
// tickets (the only ones in it), not the cohort — "median of 1 resolution" must not read n = 5.
export function statistic(facts: Map<string, Fact>, metric: string, agencyId: string, period: string) {
  const f = facts.get(`${metric}.${agencyId}.${period}`);
  return f ? { value: f.value, n: f.n ?? null } : null;
}
