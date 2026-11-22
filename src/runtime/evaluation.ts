import type { RunResult } from "./orchestrator";
import { redact, type RunMeta } from "./tracing";
import type { ExecutorStage, ToolResult } from "./types";

// Horizontal evaluation: the same versioned checks run on every run — portal or eval — and
// their verdicts are stored. Evaluators are pure functions over a normalized snapshot of the
// run, never queries against the current database: history must not change when data does
// (a review added later must not turn a failed run into a passing one).

export type EvaluableToolCall = {
  name: string;
  stage: ExecutorStage;
  status: "ok" | "rejected" | "error";
  args: unknown;
  result: ToolResult;
};

// A run as persisted: redacted exactly like the trace, so evaluating online (from memory)
// and in a backfill (from the database) sees identical input.
export type EvaluableRun = {
  runId: string;
  workflowId: string;
  // Nullable as in the `runs` table: evaluators must handle runs without a tenant.
  tenantId: string | null;
  agencyId: string | null;
  source: RunMeta["source"];
  status: RunResult["status"];
  error: string | null;
  userMessage: string;
  output: string | null;
  toolCalls: EvaluableToolCall[];
};

export type Evaluator = {
  id: string;
  // Bump when the logic changes: verdicts are stored per version, so old ones stay comparable.
  version: number;
  // invariant = a platform rule that must always hold; monitor = a heuristic that flags runs
  // for triage, not ground truth.
  kind: "invariant" | "monitor";
  description: string;
  appliesTo: (run: EvaluableRun) => boolean;
  evaluate: (run: EvaluableRun) => { verdict: "pass" | "fail"; evidence: string };
};

// pass: criterion met · fail: criterion broken · n/a: does not apply · error: could not evaluate.
// Pass rate = pass / (pass + fail); n/a and error are reported, never counted as passes.
export type Verdict = "pass" | "fail" | "n/a" | "error";

export type Evaluation = {
  runId: string;
  evaluatorId: string;
  evaluatorVersion: number;
  verdict: Verdict;
  evidence: string;
};

export function evaluateRun(run: EvaluableRun, evaluators: Evaluator[]): Evaluation[] {
  return evaluators.map((evaluator) => {
    const base = { runId: run.runId, evaluatorId: evaluator.id, evaluatorVersion: evaluator.version };
    try {
      if (!evaluator.appliesTo(run)) return { ...base, verdict: "n/a", evidence: "" };
      return { ...base, ...evaluator.evaluate(run) };
    } catch (error) {
      // A broken evaluator is visible and retried by the backfill; it never breaks the caller.
      return { ...base, verdict: "error", evidence: error instanceof Error ? error.message : String(error) };
    }
  });
}

export type SnapshotMeta = {
  workflowId: string;
  tenantId: string | null;
  agencyId: string | null;
  source: RunMeta["source"];
  userMessage: string;
};

// From an in-memory run (online hook, evals). Applies the same redaction as the trace store
// and the same JSON serialization as the database (e.g. `undefined` properties disappear),
// so an evaluator can't tell whether its input came from memory or from Postgres.
export function snapshotFromResult(result: RunResult, meta: SnapshotMeta): EvaluableRun {
  return asStored({
    runId: result.runId,
    ...meta,
    userMessage: redact(meta.userMessage),
    status: result.status,
    error: result.error,
    output: redact(result.output),
    toolCalls: result.events.flatMap((e) =>
      e.type === "tool_call"
        ? [redact({ name: e.toolName, stage: e.stage, status: e.status, args: e.args, result: e.result })]
        : [],
    ),
  });
}

const asStored = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
