import { getSql } from "@/infra/db";
import { PostgresEvaluationStore } from "@/infra/evaluation-store";
import { managerScope, PostgresOperations } from "@/infra/postgres-operations";
import { createModelFromEnv } from "@/infra/model-config";
import { PostgresRepository } from "@/infra/postgres-repository";
import { PostgresTraceStore } from "@/infra/postgres-trace-store";
import type { ChatDeps } from "./chat";
import type { BriefDeps } from "./operations-brief";
import { SlidingWindowLimiter } from "./limits";

// Production wiring: PostgreSQL for data and traces, the configured real model.
// Created once per server process (the rate limiter must be shared across requests).

let deps: ChatDeps | undefined;

export function getServerDeps(): ChatDeps {
  deps ??= {
    repo: new PostgresRepository(getSql()),
    traces: new PostgresTraceStore(getSql()),
    model: createModelFromEnv(),
    limiter: new SlidingWindowLimiter(Number(process.env.CHAT_MAX_PER_MINUTE) || 10, 60_000),
    accessCode: process.env.DEMO_ACCESS_CODE || undefined,
    // Same budget as the chat's evaluation wait: PostgreSQL cancels the write itself.
    evaluations: new PostgresEvaluationStore(getSql(), { timeoutMs: 300 }),
  };
  return deps;
}

let briefDeps: BriefDeps | undefined;

// The operations brief shares the model, traces, access code and verdict store, with its own
// rate limiter (managers and tenants don't compete for the same budget).
export function getBriefDeps(): BriefDeps {
  const shared = getServerDeps();
  briefDeps ??= {
    ...shared,
    limiter: new SlidingWindowLimiter(Number(process.env.BRIEF_MAX_PER_MINUTE) || 5, 60_000),
    operations: new PostgresOperations(getSql()),
    loadScope: (managerId) => managerScope(getSql(), managerId),
  };
  return briefDeps;
}
