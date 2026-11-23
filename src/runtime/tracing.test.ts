import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ScriptedModel } from "./model";
import { runAgent } from "./orchestrator";
import { estimateCostUsd, InMemoryTraceStore, redact, type TraceStore } from "./tracing";
import { defineTool, type WorkflowDefinition } from "./types";

type Deps = { store: InMemoryTraceStore; statusSeenByTool: string[] };

// The tool records the run's status at the moment it executes.
const record = defineTool<Deps, { email: string }>({
  name: "record",
  description: "Record something",
  input: z.strictObject({ email: z.string() }),
  execute: async (ctx) => {
    ctx.deps.statusSeenByTool.push(ctx.deps.store.runs.get(ctx.runId)?.status ?? "missing");
    return { saved: true };
  },
});

const workflow: WorkflowDefinition<Deps> = { id: "toy", systemPrompt: "", tools: [record] };

function run(store: TraceStore, deps: Deps, model = new ScriptedModel([
  { toolCalls: [{ name: "record", args: { email: "olivia.bennett@example.com" } }] },
  { text: "Saved. We'll call you on +44 7700 900123." },
])) {
  return runAgent({
    workflow,
    model,
    deps,
    actorId: "t1",
    requestId: "r1",
    userMessage: "My email is olivia.bennett@example.com",
    trace: { store, meta: { source: "eval", evalCaseId: "E-test" } },
  });
}

describe("tracing", () => {
  it("starts the run before any tool executes and finishes it with the result", async () => {
    const store = new InMemoryTraceStore();
    const deps = { store, statusSeenByTool: [] as string[] };
    const result = await run(store, deps);

    expect(deps.statusSeenByTool).toEqual(["running"]);
    expect(store.runs.get(result.runId)).toMatchObject({
      status: "completed",
      source: "eval",
      evalCaseId: "E-test",
      model: "scripted",
      steps: 2,
      costUsd: 0,
    });
    expect(store.runs.get(result.runId)?.events?.map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it("redacts contact details in the persisted trace but not in the live result", async () => {
    const store = new InMemoryTraceStore();
    const result = await run(store, { store, statusSeenByTool: [] });
    const persisted = JSON.stringify(store.runs.get(result.runId));

    expect(persisted).not.toContain("olivia.bennett@example.com");
    expect(persisted).not.toContain("+44 7700 900123");
    expect(persisted).toContain("[email]");
    expect(persisted).toContain("[phone]");
    expect(result.output).toContain("+44 7700 900123");
  });

  it("does not run any tool when the trace cannot be started", async () => {
    const broken: TraceStore = {
      startRun: async () => {
        throw new Error("db down");
      },
      finishRun: async () => {},
    };
    const deps = { store: new InMemoryTraceStore(), statusSeenByTool: [] as string[] };
    vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await run(broken, deps);

    expect(result).toMatchObject({ status: "failed", output: null, error: "trace_unavailable" });
    expect(deps.statusSeenByTool).toEqual([]);
  });

  it("keeps the run's outcome when only finishing the trace fails", async () => {
    const store = new InMemoryTraceStore();
    store.finishRun = async () => {
      throw new Error("db down");
    };
    vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await run(store, { store, statusSeenByTool: [] });

    expect(result.status).toBe("completed");
  });
});

describe("trace write deadlines", () => {
  const slow = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  it("does not start the run when startRun hangs", async () => {
    const hanging: TraceStore = { startRun: () => slow(500), finishRun: async () => {} };
    const deps = { store: new InMemoryTraceStore(), statusSeenByTool: [] as string[] };
    vi.spyOn(console, "error").mockImplementation(() => {});

    const startedAt = Date.now();
    const result = await runAgent({
      workflow,
      model: new ScriptedModel([{ toolCalls: [{ name: "record", args: { email: "x" } }] }, { text: "ok" }]),
      deps,
      actorId: "t1",
      requestId: "r1",
      userMessage: "hi",
      trace: { store: hanging, meta: { source: "eval" } },
      traceTimeoutMs: 20,
    });

    expect(result).toMatchObject({ status: "failed", error: "trace_unavailable" });
    expect(deps.statusSeenByTool).toEqual([]);
    expect(Date.now() - startedAt).toBeLessThan(200);
  });

  it("returns the result on time when finishRun hangs", async () => {
    const store = new InMemoryTraceStore();
    store.finishRun = () => slow(500);
    vi.spyOn(console, "error").mockImplementation(() => {});

    const startedAt = Date.now();
    const result = await runAgent({
      workflow,
      model: new ScriptedModel([{ text: "ok" }]),
      deps: { store, statusSeenByTool: [] },
      actorId: "t1",
      requestId: "r1",
      userMessage: "hi",
      trace: { store, meta: { source: "eval" } },
      traceTimeoutMs: 20,
    });

    expect(result).toMatchObject({ status: "completed", output: "ok" });
    expect(Date.now() - startedAt).toBeLessThan(200);
  });
});

describe("estimateCostUsd", () => {
  it("returns null for models without a known price instead of guessing", () => {
    expect(estimateCostUsd("some-new-model", { inputTokens: 1000, outputTokens: 1000 })).toBeNull();
  });
});

describe("redact", () => {
  it("never redacts identifiers, UUIDs or dates", () => {
    const payload = {
      ticket_id: "6d1b7450-b660-4899-a4de-47565e081d31",
      runId: "2026112212345678",
      note: "ticket 6d1b7450-b660-4899-a4de-47565e081d31 created on 2026-11-22",
      ref: "47565e081d31",
    };
    expect(redact(payload)).toEqual(payload);
  });

  it("redacts contact details hidden in id fields", () => {
    expect(redact({ ticket_id: "olivia@example.com", tenantId: "call +44 7700 900123" })).toEqual({
      ticket_id: "[email]",
      tenantId: "call [phone]",
    });
  });

  it("keeps null ids as they are, e.g. a human review requested without a ticket", () => {
    const call = { reason: "Rent question", ticket_id: null };
    expect(redact(call)).toEqual(call);
  });

  it("keeps dates and times: a date-time is not a phone number", () => {
    for (const text of ["as of 2026-11-23 00:25 UTC", "on 2026-11-23T00:25:00Z", "between 2026-11-01 and 2026-11-23"]) {
      expect(redact(text)).toBe(text);
    }
  });

  it("keeps period ranges, so fact citations survive in stored traces", () => {
    const cited = "a median of 5.3 hours [median_hours_to_resolve_emergency.agency_northbridge.2025-11..2026-10] (2025-11-01..2026-10-31)";
    expect(redact(cited)).toBe(cited);
    // A phone written with dots is still a phone.
    expect(redact("call 0161.496.0000")).toBe("call [phone]");
  });

  it("redacts phone numbers in UK formats", () => {
    expect(redact("call 07700 900123 or +44 (0)7700-900-123")).toBe("call [phone] or [phone]");
  });

  it("masks emails and phone numbers deep inside payloads", () => {
    expect(redact({ a: ["write to a.b@example.com", { tel: "call +44 7700 900123" }], n: 42 })).toEqual({
      a: ["write to [email]", { tel: "call [phone]" }],
      n: 42,
    });
  });
});
