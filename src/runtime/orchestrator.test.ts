import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ScriptedModel, type ModelPort } from "./model";
import { runAgent } from "./orchestrator";
import { defineTool, type WorkflowDefinition } from "./types";

// Loop mechanics with a toy workflow: the orchestrator knows nothing about maintenance.

const ping = defineTool<object, { n: number }>({
  name: "ping",
  description: "Echo a number",
  input: z.strictObject({ n: z.number() }),
  execute: async (_ctx, args) => ({ pong: args.n }),
});

const workflow: WorkflowDefinition<object> = { id: "toy", systemPrompt: "Be brief.", tools: [ping] };

const run = (model: ModelPort, extra: { maxSteps?: number; timeoutMs?: number } = {}) =>
  runAgent({ workflow, model, deps: {}, actorId: "t1", requestId: "r1", userMessage: "hi", ...extra });

describe("runAgent", () => {
  it("runs tools, feeds results back and completes with the final answer", async () => {
    const model = new ScriptedModel([{ toolCalls: [{ name: "ping", args: { n: 1 } }] }, { text: "pong 1" }]);
    const result = await run(model);

    expect(result).toMatchObject({ status: "completed", output: "pong 1", error: null, steps: 2 });
    expect(result.events.map((e) => e.type)).toEqual(["model_call", "tool_call", "model_call"]);
    // The second model call saw the tool result.
    expect(model.seen[1].at(-1)).toMatchObject({ role: "tool", name: "ping", content: '{"ok":true,"data":{"pong":1}}' });
  });

  it("a rejected tool call does not stop the run: the model gets the rejection", async () => {
    const model = new ScriptedModel([
      { toolCalls: [{ name: "ping", args: { n: "one" } }] },
      { text: "Sorry, I could not do that." },
    ]);
    const result = await run(model);

    expect(result.status).toBe("completed");
    expect(result.events[1]).toMatchObject({ type: "tool_call", stage: "validate", status: "rejected" });
  });

  it("fails after maxSteps instead of looping forever", async () => {
    const loop = Array.from({ length: 10 }, () => ({ toolCalls: [{ name: "ping", args: { n: 1 } }] }));
    const result = await run(new ScriptedModel(loop), { maxSteps: 3 });

    expect(result).toMatchObject({ status: "failed", output: null, error: "max_steps_exceeded", steps: 3 });
  });

  it("fails on model errors without inventing an answer", async () => {
    const result = await run(new ScriptedModel([]));

    expect(result).toMatchObject({ status: "failed", output: null, error: "model_error" });
    expect(result.events[0]).toMatchObject({ type: "model_call", status: "error" });
  });

  it("fails on an empty final answer instead of completing with nothing", async () => {
    const result = await run(new ScriptedModel([{ text: "   " }]));
    expect(result).toMatchObject({ status: "failed", output: null, error: "empty_response" });
  });

  it("aborts the in-flight model call when the deadline passes", async () => {
    let signal: AbortSignal | undefined;
    const slow: ModelPort = {
      id: "slow",
      next: (input) => {
        signal = input.signal;
        return new Promise(() => {});
      },
    };
    await run(slow, { timeoutMs: 20 });
    expect(signal?.aborted).toBe(true);
  });

  it("fails when the model exceeds the deadline", async () => {
    const slow: ModelPort = {
      id: "slow",
      next: () => new Promise((resolve) => setTimeout(() => resolve({ text: "late", toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 } }), 200)),
    };
    const result = await run(slow, { timeoutMs: 20 });

    expect(result).toMatchObject({ status: "failed", output: null, error: "timeout" });
  });

  it("does not start a tool once the deadline has passed", async () => {
    const executed: number[] = [];
    let skew = 0;
    const now = Date.now;
    vi.spyOn(Date, "now").mockImplementation(() => now() + skew);
    const clockJump = defineTool<object, { n: number }>({
      name: "ping",
      description: "Echo a number",
      input: z.strictObject({ n: z.number() }),
      execute: async (_ctx, args) => {
        executed.push(args.n);
        skew += 60_000; // the first call returns, but the deadline has now passed
        return { pong: args.n };
      },
    });
    const model = new ScriptedModel([
      { toolCalls: [{ name: "ping", args: { n: 1 } }, { name: "ping", args: { n: 2 } }] },
      { text: "never" },
    ]);
    const result = await runAgent({
      workflow: { ...workflow, tools: [clockJump] },
      model,
      deps: {},
      actorId: "t1",
      requestId: "r1",
      userMessage: "hi",
      timeoutMs: 1_000,
    });
    vi.restoreAllMocks();

    expect(result).toMatchObject({ status: "failed", output: null, error: "timeout" });
    expect(executed).toEqual([1]);
  });

  it("a hung tool cannot hold the run past its deadline", async () => {
    const hung = defineTool<object, { n: number }>({
      name: "ping",
      description: "Never answers",
      input: z.strictObject({ n: z.number() }),
      execute: () => new Promise(() => {}),
    });
    const startedAt = Date.now();
    const result = await runAgent({
      workflow: { ...workflow, tools: [hung] },
      model: new ScriptedModel([{ toolCalls: [{ name: "ping", args: { n: 1 } }] }, { text: "never" }]),
      deps: {},
      actorId: "t1",
      requestId: "r1",
      userMessage: "hi",
      timeoutMs: 30,
    });

    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(result).toMatchObject({ status: "failed", output: null, error: "tool_timeout" });
    expect(result.events.at(-1)).toMatchObject({ type: "tool_call", status: "error", result: { code: "timeout" } });
  });
});
