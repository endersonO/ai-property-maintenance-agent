import type { z } from "zod";

// Generic runtime contracts. Nothing in src/runtime may import from src/domain or src/workflows.

export type ExecutorStage = "validate" | "authorize" | "policy" | "idempotency" | "execute";

export type Rejection = { code: string; message: string };

// What the model receives back for every tool call. Failures are data, not exceptions,
// so the model can explain them instead of inventing a success.
export type ToolResult =
  | { ok: true; data: unknown }
  | { ok: false; stage: ExecutorStage; code: string; message: string };

export type ToolContext<Deps> = {
  runId: string;
  // Stable per user message; retries of the same request reuse it.
  requestId: string;
  // Identity comes from the session, never from the model.
  tenantId: string;
  deps: Deps;
};

type Execute<Deps, Args, PolicyOutcome> = (
  ctx: ToolContext<Deps>,
  args: Args,
  extras: { policy: PolicyOutcome; idempotencyKey: string | null },
) => Promise<unknown>;

// A tool plugs its own rules into the executor's fixed pipeline:
// validate (input) → authorize → applyPolicy → idempotencyKey → execute.
type ToolBase<Deps, Args> = {
  name: string;
  description: string;
  input: z.ZodType<Args>;
  authorize?: (ctx: ToolContext<Deps>, args: Args) => Promise<Rejection | null>;
  idempotencyKey?: (ctx: ToolContext<Deps>, args: Args) => string;
};

// `execute` only receives a policy outcome when the tool defines `applyPolicy`.
export type ToolWithPolicy<Deps, Args, PolicyOutcome> = ToolBase<Deps, Args> & {
  applyPolicy: (ctx: ToolContext<Deps>, args: Args) => Promise<PolicyOutcome>;
  execute: Execute<Deps, Args, PolicyOutcome>;
};

export type ToolWithoutPolicy<Deps, Args> = ToolBase<Deps, Args> & {
  applyPolicy?: undefined;
  execute: Execute<Deps, Args, undefined>;
};

// Tools in one workflow have different argument types; the registry stores them erased.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyTool<Deps> = ToolWithPolicy<Deps, any, any> | ToolWithoutPolicy<Deps, any>;

// Overloads keep each shape fully typed at the definition site.
export function defineTool<Deps, Args, PolicyOutcome>(
  tool: ToolWithPolicy<Deps, Args, PolicyOutcome>,
): AnyTool<Deps>;
export function defineTool<Deps, Args>(tool: ToolWithoutPolicy<Deps, Args>): AnyTool<Deps>;
export function defineTool<Deps>(tool: AnyTool<Deps>): AnyTool<Deps> {
  return tool;
}

export type WorkflowDefinition<Deps> = {
  id: string;
  systemPrompt: string;
  tools: AnyTool<Deps>[];
};
