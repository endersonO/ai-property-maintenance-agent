import { randomUUID } from "node:crypto";
import { executeToolCall } from "./executor";
import { toToolSpecs, type Message, type ModelPort, type ModelResponse, type Usage } from "./model";
import { estimateCostUsd, redact, type RunMeta, type TraceStore } from "./tracing";
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
  // Optional persistence. Without it the run still returns its events in memory.
  trace?: { store: TraceStore; meta: RunMeta };
  // Upper bound for each trace write, so persistence can never hang the response.
  traceTimeoutMs?: number;
};

export async function runAgent<Deps>(input: RunInput<Deps>): Promise<RunResult> {
  const { workflow, model, maxSteps = 6, timeoutMs = 60_000, traceTimeoutMs = 2_000 } = input;
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

  const finish = async (
    status: RunResult["status"],
    output: string | null,
    error: string | null,
  ): Promise<RunResult> => {
    const result: RunResult = {
      runId,
      status,
      output,
      error,
      steps,
      usage,
      durationMs: Math.round(performance.now() - startedAt),
      events,
      messages,
    };
    try {
      if (input.trace) await withDeadline(input.trace.store.finishRun({
        runId,
        status,
        output: redact(output),
        error,
        steps,
        usage,
        costUsd: estimateCostUsd(model.id, usage),
        durationMs: result.durationMs,
        events: redact(events),
      }), Date.now() + traceTimeoutMs);
    } catch (traceError) {
      // The tenant's outcome already happened (e.g. a ticket exists); losing the trace
      // must not turn it into a failure. Surface it in logs instead.
      console.error(`Failed to persist trace for run ${runId}`, traceError);
    }
    return result;
  };

  // The run row must exist before any tool writes a ticket that references it.
  if (input.trace) {
    try {
      await withDeadline(input.trace.store.startRun({
        ...input.trace.meta,
        runId,
        workflowId: workflow.id,
        tenantId: input.tenantId,
        requestId: input.requestId,
        model: model.id,
        input: redact({ userMessage: input.userMessage, historyLength: input.history?.length ?? 0 }),
      }), Math.min(deadline, Date.now() + traceTimeoutMs));
    } catch (traceError) {
      console.error(`Failed to start trace for run ${runId}`, traceError);
      return { runId, status: "failed", output: null, error: "trace_unavailable", steps, usage, durationMs: 0, events, messages };
    }
  }

  while (steps < maxSteps) {
    if (Date.now() >= deadline) return finish("failed", null, "timeout");

    steps++;
    const modelStartedAt = performance.now();
    let response: ModelResponse;
    try {
      const controller = new AbortController();
      response = await withDeadline(
        model.next({ messages, tools, signal: controller.signal }),
        deadline,
        () => controller.abort(),
      );
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

    if (response.toolCalls.length === 0) {
      // A final answer with no text is not an answer.
      return response.text?.trim()
        ? finish("completed", response.text, null)
        : finish("failed", null, "empty_response");
    }

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

function withDeadline<T>(promise: Promise<T>, deadline: number, onTimeout?: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout?.();
      reject(new Error("timeout"));
    }, Math.max(0, deadline - Date.now()));
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
