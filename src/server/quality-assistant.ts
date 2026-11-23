import { z } from "zod";
import { runAgent } from "@/runtime/orchestrator";
import { qualityAnalystWorkflow } from "@/workflows/quality-analyst";
import type { QualityPort } from "@/workflows/quality-analyst/port";
import { checkAccess } from "./access";
import { evaluateOnline, type ChatDeps } from "./chat";

// The Agent Inspector's assistant behind POST /api/quality-assistant: read-only questions about
// how the agent behaves. The viewer is set by the server (the demo has no engineer login), never
// by the request.

export const INSPECTOR_VIEWER = "inspector_viewer";

export const QualityRequest = z.strictObject({
  requestId: z.uuid(),
  message: z.string().trim().min(1).max(1000),
  history: z
    .array(z.strictObject({ role: z.enum(["user", "assistant"]), content: z.string().max(4000) }))
    .max(10)
    .default([]),
});

export type QualityAssistantDeps = Pick<
  ChatDeps,
  "traces" | "model" | "limiter" | "accessCode" | "accessLimiter" | "timeoutMs" | "evaluations" | "evaluators" | "evaluationBudgetMs"
> & { quality: QualityPort };

export type QualityResponse =
  | { status: 400; body: { error: "invalid_request"; issues: string } }
  | { status: 401; body: { error: "access_code_required" } }
  | { status: 429; body: { error: "too_many_attempts" } | { error: "rate_limited"; retryAfterSeconds: number } }
  | { status: 200; body: { runId: string; traceAvailable: boolean; outcome: "completed" | "failed"; reply: string } };

const FAILED = "Sorry, I couldn't answer that. Nothing was changed — please try again.";

export async function handleQualityAssistant(
  input: unknown,
  deps: QualityAssistantDeps,
  request: { accessCode: string | null; client: string } = { accessCode: null, client: "local" },
): Promise<QualityResponse> {
  const access = checkAccess(request.accessCode, request.client, deps.accessCode, deps.accessLimiter);
  if (access === "locked") return { status: 429, body: { error: "too_many_attempts" } };
  if (access === "denied") return { status: 401, body: { error: "access_code_required" } };
  const parsed = QualityRequest.safeParse(input);
  if (!parsed.success) return { status: 400, body: { error: "invalid_request", issues: z.prettifyError(parsed.error) } };
  const { requestId, message, history } = parsed.data;

  const allowed = deps.limiter.take(INSPECTOR_VIEWER);
  if (!allowed.ok) {
    return { status: 429, body: { error: "rate_limited", retryAfterSeconds: Math.ceil(allowed.retryAfterMs / 1000) } };
  }

  const result = await runAgent({
    workflow: qualityAnalystWorkflow,
    model: deps.model,
    deps: { quality: deps.quality, viewerId: INSPECTOR_VIEWER },
    actorId: INSPECTOR_VIEWER,
    requestId,
    userMessage: message,
    history: history.map((turn) =>
      turn.role === "user"
        ? { role: "user" as const, content: turn.content }
        : { role: "assistant" as const, content: turn.content, toolCalls: [] },
    ),
    timeoutMs: deps.timeoutMs ?? 50_000,
    trace: { store: deps.traces, meta: { source: "portal", tenantId: null } },
  });

  await evaluateOnline(deps, result, {
    workflowId: qualityAnalystWorkflow.id,
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
