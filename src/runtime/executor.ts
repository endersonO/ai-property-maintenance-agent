import { z } from "zod";
import type { AnyTool, ExecutorStage, ToolContext, ToolResult } from "./types";

// Runs one tool call through the fixed pipeline and stops at the first failure:
// validate → authorize → policy → idempotency → execute.
// It never throws: every outcome becomes a ToolResult the model can read.

export type ToolCallOutcome = {
  result: ToolResult;
  // Last stage reached: where the call stopped, or "execute" on success.
  stage: ExecutorStage;
  status: "ok" | "rejected" | "error";
  durationMs: number;
  // Full error for the trace only; the model gets a generic message.
  internalError?: string;
};

export async function executeToolCall<Deps>(
  tools: AnyTool<Deps>[],
  call: { name: string; args: unknown },
  ctx: ToolContext<Deps>,
): Promise<ToolCallOutcome> {
  const startedAt = performance.now();
  const done = (outcome: Omit<ToolCallOutcome, "durationMs">): ToolCallOutcome => ({
    ...outcome,
    durationMs: Math.round(performance.now() - startedAt),
  });
  const rejected = (stage: ExecutorStage, code: string, message: string) =>
    done({ result: { ok: false, stage, code, message }, stage, status: "rejected" });
  const failed = (stage: ExecutorStage, error: unknown) =>
    done({
      result: { ok: false, stage, code: "internal_error", message: `The ${call.name} tool failed. Nothing was changed.` },
      stage,
      status: "error",
      internalError: error instanceof Error ? error.message : String(error),
    });

  // 1. validate
  const tool = tools.find((t) => t.name === call.name);
  if (!tool) return rejected("validate", "unknown_tool", `Unknown tool: ${call.name}`);
  const parsed = tool.input.safeParse(call.args);
  if (!parsed.success) {
    return rejected("validate", "invalid_arguments", z.prettifyError(parsed.error));
  }
  const args = parsed.data;

  // 2. authorize
  try {
    const rejection = await tool.authorize?.(ctx, args);
    if (rejection) return rejected("authorize", rejection.code, rejection.message);
  } catch (error) {
    return failed("authorize", error);
  }

  // 3. policy
  let policy: unknown;
  try {
    policy = await tool.applyPolicy?.(ctx, args);
  } catch (error) {
    return failed("policy", error);
  }

  // 4. idempotency
  let idempotencyKey: string | null;
  try {
    idempotencyKey = tool.idempotencyKey?.(ctx, args) ?? null;
  } catch (error) {
    return failed("idempotency", error);
  }

  // 5. execute
  try {
    const data = await tool.execute(ctx, args, { policy, idempotencyKey } as never);
    return done({ result: { ok: true, data }, stage: "execute", status: "ok" });
  } catch (error) {
    return failed("execute", error);
  }
}
