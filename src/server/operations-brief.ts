import { z } from "zod";
import type { OperationsPort, ManagerScope } from "@/operations/port";
import { runAgent } from "@/runtime/orchestrator";
import { operationsBriefWorkflow } from "@/workflows/operations-brief";
import { checkAccess } from "./access";
import { evaluateOnline, type ChatDeps } from "./chat";

// The operations brief use case behind POST /api/operations-brief. Separate from the tenant chat:
// a different actor (a manager), a scope loaded by the server, and only aggregate tools.

export const BriefRequest = z.strictObject({
  // Simulated manager session (like the tenant selector). Real auth would set this server-side.
  managerId: z.string().min(1),
  requestId: z.uuid(),
  message: z.string().trim().min(1).max(1000),
  history: z
    .array(z.strictObject({ role: z.enum(["user", "assistant"]), content: z.string().max(4000) }))
    .max(10)
    .default([]),
});

export type BriefDeps = Pick<
  ChatDeps,
  "traces" | "model" | "limiter" | "accessCode" | "accessLimiter" | "timeoutMs" | "evaluations" | "evaluators" | "evaluationBudgetMs"
> & {
  operations: OperationsPort;
  // Loads the manager's authorised agencies; null for an unknown manager.
  loadScope: (managerId: string) => Promise<ManagerScope | null>;
};

export type BriefResponse =
  | { status: 400; body: { error: "invalid_request"; issues: string } }
  | { status: 401; body: { error: "access_code_required" } }
  | { status: 429; body: { error: "too_many_attempts" } | { error: "rate_limited"; retryAfterSeconds: number } }
  | { status: 404; body: { error: "unknown_manager" } }
  | { status: 200; body: { runId: string; traceAvailable: boolean; outcome: "completed" | "failed"; reply: string } };

const FAILED = "Sorry, I couldn't prepare the brief. Nothing was changed — please try again.";

export async function handleOperationsBrief(
  input: unknown,
  deps: BriefDeps,
  request: { accessCode: string | null; client: string } = { accessCode: null, client: "local" },
): Promise<BriefResponse> {
  const access = checkAccess(request.accessCode, request.client, deps.accessCode, deps.accessLimiter);
  if (access === "locked") return { status: 429, body: { error: "too_many_attempts" } };
  if (access === "denied") return { status: 401, body: { error: "access_code_required" } };
  const parsed = BriefRequest.safeParse(input);
  if (!parsed.success) return { status: 400, body: { error: "invalid_request", issues: z.prettifyError(parsed.error) } };
  const { managerId, requestId, message, history } = parsed.data;

  const scope = await deps.loadScope(managerId);
  if (!scope) return { status: 404, body: { error: "unknown_manager" } };

  const allowed = deps.limiter.take(managerId);
  if (!allowed.ok) {
    return { status: 429, body: { error: "rate_limited", retryAfterSeconds: Math.ceil(allowed.retryAfterMs / 1000) } };
  }

  const result = await runAgent({
    workflow: operationsBriefWorkflow,
    model: deps.model,
    deps: { operations: deps.operations, scope },
    actorId: managerId,
    requestId,
    userMessage: message,
    history: history.map((turn) =>
      turn.role === "user"
        ? { role: "user" as const, content: turn.content }
        : { role: "assistant" as const, content: turn.content, toolCalls: [] },
    ),
    timeoutMs: deps.timeoutMs ?? 50_000,
    // A manager acts across agencies: no tenant, no single agency on the run.
    trace: { store: deps.traces, meta: { source: "portal", tenantId: null } },
  });

  await evaluateOnline(deps, result, {
    workflowId: operationsBriefWorkflow.id,
    tenantId: null,
    agencyId: null,
    userMessage: message,
    history: history.map(({ role, content }) => ({ role, content })),
  });

  return {
    status: 200,
    body: {
      runId: result.runId,
      traceAvailable: result.error !== "trace_unavailable",
      outcome: result.status,
      // Read-only: a failed run changed nothing, so saying so is true here.
      reply: result.status === "completed" && result.output ? result.output : FAILED,
    },
  };
}
