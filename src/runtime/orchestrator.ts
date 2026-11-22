import { randomUUID } from "node:crypto";
import { executeToolCall } from "./executor";
import { toToolSpecs, type Message, type ModelPort, type ModelResponse, type Usage } from "./model";
import type { ExecutorStage, ToolResult, WorkflowDefinition } from "./types";

// The agent loop: ask the model → run requested tools through the executor → feed results
// back → repeat until a final answer, the step limit or the deadline.
// It knows nothing about any specific workflow.

export type RunEvent =
  | {
      seq: number;
      type: "model_call";
      status: "ok" | "error";
      durationMs: number;
      usage: Usage;
      toolCalls: string[];
      error?: string;
    }
  | {
      seq: number;
      type: "tool_call";
      toolName: string;
      stage: ExecutorStage;
      status: "ok" | "rejected" | "error";
      durationMs: number;
      args: unknown;
      result: ToolResult;
      internalError?: string;
    };

export type RunResult = {
  runId: string;
  status: "completed" | "failed";
  // Null when the run failed: callers show a safe fallback, never an invented reply.
  output: string | null;
  error: string | null;
  steps: number;
  usage: Usage;
  durationMs: number;
  events: RunEvent[];
  messages: Message[];
};

export type RunInput<Deps> = {
  workflow: WorkflowDefinition<Deps>;
  model: ModelPort;
  deps: Deps;
  tenantId: string;
  requestId: string;
  runId?: string;
  // Previous user/assistant turns, sent by the client (the server keeps no conversation).
  history?: Message[];
  userMessage: string;
  maxSteps?: number;
  timeoutMs?: number;
};

export async function runAgent<Deps>(input: RunInput<Deps>): Promise<RunResult> {
  const { workflow, model, maxSteps = 6, timeoutMs = 60_000 } = input;
  const runId = input.runId ?? randomUUID();
  const ctx = { runId, requestId: input.requestId, tenantId: input.tenantId, deps: input.deps };
  const tools = toToolSpecs(workflow.tools);
  const startedAt = performance.now();
  const deadline = Date.now() + timeoutMs;

  const messages: Message[] = [
    { role: "system", content: workflow.systemPrompt },
    ...(input.history ?? []),
    { role: "user", content: input.userMessage },
  ];
  const events: RunEvent[] = [];
  const usage: Usage = { inputTokens: 0, outputTokens: 0 };
  let steps = 0;

  const finish = (status: RunResult["status"], output: string | null, error: string | null): RunResult => ({
    runId,
    status,
    output,
    error,
    steps,
    usage,
    durationMs: Math.round(performance.now() - startedAt),
    events,
    messages,
  });

  while (steps < maxSteps) {
    if (Date.now() >= deadline) return finish("failed", null, "timeout");

    steps++;
    const modelStartedAt = performance.now();
    let response: ModelResponse;
    try {
      response = await withDeadline(model.next({ messages, tools }), deadline);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      events.push({
        seq: events.length + 1,
        type: "model_call",
        status: "error",
        durationMs: Math.round(performance.now() - modelStartedAt),
        usage: { inputTokens: 0, outputTokens: 0 },
        toolCalls: [],
        error: message,
      });
      return finish("failed", null, message === "timeout" ? "timeout" : "model_error");
    }

    usage.inputTokens += response.usage.inputTokens;
    usage.outputTokens += response.usage.outputTokens;
    events.push({
      seq: events.length + 1,
      type: "model_call",
      status: "ok",
      durationMs: Math.round(performance.now() - modelStartedAt),
      usage: response.usage,
      toolCalls: response.toolCalls.map((c) => c.name),
    });
    messages.push({ role: "assistant", content: response.text, toolCalls: response.toolCalls });

    if (response.toolCalls.length === 0) return finish("completed", response.text, null);

    for (const call of response.toolCalls) {
      const outcome = await executeToolCall(workflow.tools, call, ctx);
      events.push({
        seq: events.length + 1,
        type: "tool_call",
        toolName: call.name,
        stage: outcome.stage,
        status: outcome.status,
        durationMs: outcome.durationMs,
        args: call.args,
        result: outcome.result,
        internalError: outcome.internalError,
      });
      messages.push({
        role: "tool",
        toolCallId: call.id,
        name: call.name,
        content: JSON.stringify(outcome.result),
      });
    }
  }

  return finish("failed", null, "max_steps_exceeded");
}

function withDeadline<T>(promise: Promise<T>, deadline: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timeout")), Math.max(0, deadline - Date.now()));
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
