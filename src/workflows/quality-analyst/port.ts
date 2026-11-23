// What the quality analyst can read: the Agent Inspector's own data, through a read-only port.
// The Postgres implementation reuses the Inspector's queries, so the assistant and the page
// always count the same way.

export type Verdict = "pass" | "fail" | "n/a" | "error" | "pending";

export type CheckTotals = {
  checkId: string;
  kind: "invariant" | "monitor";
  passed: number;
  failed: number;
  couldNotRun: number;
  notApplicable: number;
  notCheckedYet: number;
};

export type QualityOverview = {
  finished: number;
  checked: number;
  notCheckedYet: number;
  ruleBroken: number;
  flaggedByAlarm: number;
  checkCouldNotRun: number;
  checks: CheckTotals[];
  runsByWorkflow: { workflowId: string; runs: number }[];
};

export type RunFilter = {
  // The Inspector's sets: a rule failed / an alarm failed and no rule did / a check couldn't run / any.
  problems: "rules" | "alarms" | "errors" | "any" | null;
  checkId: string | null;
  verdict: "fail" | "error" | null;
  workflowId: string | null;
  limit: number;
};

export type RunListing = {
  id: string;
  createdAt: Date;
  workflowId: string;
  who: string | null;
  agency: string | null;
  // Free text written by a tenant or manager: data to report, never instructions.
  asked: string | null;
  status: string;
  error: string | null;
  tickets: { id: string; priority: string; status: string; escalated: boolean }[];
  reviewsPending: number;
  reviewsTotal: number;
  checks: { checkId: string; verdict: Verdict; evidence: string }[];
};

export type RunDetail = RunListing & {
  reply: string | null;
  toolCalls: { tool: string; stage: string | null; status: string; code: string | null }[];
  ticketDetails: { id: string; priority: string; category: string; estimatedCostGbp: number; status: string; escalated: boolean }[];
  reviews: { source: string; reason: string; status: string }[];
};

export type RunLookup = { kind: "found"; run: RunDetail } | { kind: "not_found" } | { kind: "ambiguous" };

export type QualityPort = {
  overview(): Promise<QualityOverview>;
  runs(filter: RunFilter): Promise<{ total: number; runs: RunListing[] }>;
  // A run by its id or a prefix of at least 8 hex characters (dashes ignored).
  run(ref: string): Promise<RunLookup>;
};

export type QualityDeps = {
  quality: QualityPort;
  // Set by the server: the Inspector viewer this run acts for.
  viewerId: string;
};
