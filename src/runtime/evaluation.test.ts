import { describe, expect, it } from "vitest";
import { evaluateRun, snapshotFromResult, type EvaluableRun, type Evaluator } from "./evaluation";
import type { RunResult } from "./orchestrator";

const run = (overrides: Partial<EvaluableRun> = {}): EvaluableRun => ({
  runId: "run-1",
  workflowId: "toy",
  tenantId: "t1",
  agencyId: "a1",
  source: "portal",
  status: "completed",
  error: null,
  userMessage: "hello",
  output: "hi",
  toolCalls: [],
  ...overrides,
});

const repliesHi: Evaluator = {
  id: "replies_hi",
  version: 2,
  kind: "monitor",
  description: "Completed runs say hi",
  appliesTo: (r) => r.status === "completed",
  evaluate: (r) => (r.output === "hi" ? { verdict: "pass", evidence: "said hi" } : { verdict: "fail", evidence: `said ${r.output}` }),
};

describe("evaluateRun", () => {
  it("returns one versioned verdict per evaluator, with evidence", () => {
    expect(evaluateRun(run(), [repliesHi])).toEqual([
      { runId: "run-1", evaluatorId: "replies_hi", evaluatorVersion: 2, verdict: "pass", evidence: "said hi" },
    ]);
    expect(evaluateRun(run({ output: "bye" }), [repliesHi])[0]).toMatchObject({ verdict: "fail", evidence: "said bye" });
  });

  it("records n/a when the evaluator does not apply, never a pass", () => {
    expect(evaluateRun(run({ status: "failed", output: null }), [repliesHi])[0].verdict).toBe("n/a");
  });

  it("turns a throwing evaluator into an error verdict without stopping the others", () => {
    const broken: Evaluator = { ...repliesHi, id: "broken", evaluate: () => { throw new Error("boom"); } };
    const verdicts = evaluateRun(run(), [broken, repliesHi]);
    expect(verdicts.map((v) => [v.evaluatorId, v.verdict, v.evidence])).toEqual([
      ["broken", "error", "boom"],
      ["replies_hi", "pass", "said hi"],
    ]);
  });
});

describe("snapshotFromResult", () => {
  const result: RunResult = {
    runId: "run-1",
    status: "completed",
    output: "I emailed olivia@example.com",
    error: null,
    steps: 2,
    usage: { inputTokens: 0, outputTokens: 0 },
    durationMs: 5,
    messages: [],
    events: [
      { seq: 1, type: "model_call", status: "ok", durationMs: 1, usage: { inputTokens: 0, outputTokens: 0 }, toolCalls: ["ping"] },
      {
        seq: 2,
        type: "tool_call",
        toolName: "ping",
        stage: "execute",
        status: "ok",
        durationMs: 1,
        args: { note: "call 07700 900123", ticket_id: "6d1b7450-b660-4899-a4de-47565e081d31" },
        result: { ok: true, data: { pong: 1 } },
      },
    ],
  };
  const meta = { workflowId: "toy", tenantId: "t1", agencyId: "a1", source: "portal" as const, userMessage: "I'm olivia@example.com" };

  it("serializes like the database: undefined properties are dropped", () => {
    const withUndefined: RunResult = {
      ...result,
      events: [{ ...result.events[1], result: { ok: true, data: { ticket_id: "t-1", escalated: undefined } } } as RunResult["events"][number]],
    };
    const [call] = snapshotFromResult(withUndefined, meta).toolCalls;
    expect(Object.hasOwn((call.result as { data: object }).data, "escalated")).toBe(false);
  });

  it("keeps only tool calls and redacts like the trace store", () => {
    expect(snapshotFromResult(result, meta)).toStrictEqual({
      runId: "run-1",
      workflowId: "toy",
      tenantId: "t1",
      agencyId: "a1",
      source: "portal",
      status: "completed",
      error: null,
      userMessage: "I'm [email]",
      output: "I emailed [email]",
      toolCalls: [
        {
          name: "ping",
          stage: "execute",
          status: "ok",
          args: { note: "call [phone]", ticket_id: "6d1b7450-b660-4899-a4de-47565e081d31" },
          result: { ok: true, data: { pong: 1 } },
        },
      ],
    });
  });
});
