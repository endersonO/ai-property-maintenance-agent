import { getSql } from "@/infra/db";
import { createModelFromEnv } from "@/infra/model-config";
import { PostgresRepository } from "@/infra/postgres-repository";
import { PostgresTraceStore } from "@/infra/postgres-trace-store";
import type { ChatDeps } from "./chat";

// Production wiring: PostgreSQL for data and traces, the configured real model.
// Created once per server process (the rate limiter must be shared across requests).

let deps: ChatDeps | undefined;

export function getServerDeps(): ChatDeps {
  deps ??= {
    repo: new PostgresRepository(getSql()),
    traces: new PostgresTraceStore(getSql()),
    model: createModelFromEnv(),
  };
  return deps;
}
