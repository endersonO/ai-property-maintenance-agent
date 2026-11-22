import type { Fact, MetricScope } from "@/infra/operations-queries";

// What the operations brief needs, behind a port: PostgreSQL in the app, canned facts in evals.
export type Report = { facts: Fact[]; notes: string[] };

// The dataset and cut-off a report was computed against.
export type OperationsContext = Pick<MetricScope, "dataset" | "asOf">;

// A report carries the context it was computed with, read in the same snapshot as its facts:
// a regeneration in between can never label figures with another cut-off.
export type BriefReport = Report & OperationsContext;

// What the caller chooses; the port decides the dataset and cut-off.
export type BriefQuery = Pick<MetricScope, "period" | "agencyIds">;

export type ManagerScope = { managerId: string; name: string; agencyIds: string[] };

export interface OperationsPort {
  agencyNames(agencyIds: string[]): Promise<Record<string, string>>;
  volume(query: BriefQuery): Promise<BriefReport>;
  resolution(query: BriefQuery & { priority: "emergency" | "high" | "normal" | "low" | null }): Promise<BriefReport>;
}

// Dependencies of the operations-brief tools. The scope is set by the server from the
// (simulated) manager session; tool arguments can narrow it, never widen it.
export type OpsDeps = { operations: OperationsPort; scope: ManagerScope };
