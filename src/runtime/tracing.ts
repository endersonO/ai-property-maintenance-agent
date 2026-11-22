import type { RunEvent, RunResult } from "./orchestrator";
import type { Usage } from "./model";

// Persistence port for runs and their events. Implemented in memory (tests, evals)
// and on PostgreSQL (`runs`, `run_events`).

export type RunMeta = {
  source: "portal" | "eval";
  evalCaseId?: string;
  agencyId?: string;
};

export type RunStart = RunMeta & {
  runId: string;
  workflowId: string;
  tenantId: string;
  requestId: string;
  model: string;
  input: unknown;
};

export type RunFinish = {
  runId: string;
  status: RunResult["status"];
  output: string | null;
  error: string | null;
  steps: number;
  usage: Usage;
  costUsd: number | null;
  durationMs: number;
  events: RunEvent[];
};

export interface TraceStore {
  // Called before the first tool runs: tickets reference the run id.
  startRun(run: RunStart): Promise<void>;
  finishRun(run: RunFinish): Promise<void>;
}

export class InMemoryTraceStore implements TraceStore {
  readonly runs = new Map<
    string,
    RunStart & Omit<Partial<RunFinish>, "status"> & { status: "running" | RunFinish["status"] }
  >();

  async startRun(run: RunStart) {
    this.runs.set(run.runId, { ...run, status: "running" });
  }

  async finishRun(run: RunFinish) {
    const started = this.runs.get(run.runId);
    if (!started) throw new Error(`Run ${run.runId} was never started`);
    this.runs.set(run.runId, { ...started, ...run });
  }
}

// USD per million tokens. Only models with a known price get a cost; others record null
// rather than a guess. Fill from the provider's pricing page when adding a model.
const PRICES: Record<string, { input: number; output: number }> = {
  scripted: { input: 0, output: 0 },
};

export function estimateCostUsd(model: string, usage: Usage): number | null {
  const price = PRICES[model];
  if (!price) return null;
  return (usage.inputTokens * price.input + usage.outputTokens * price.output) / 1_000_000;
}

// Traces keep the shape of every payload but not personal contact details.
// Identifiers are kept so a trace stays joinable to its tickets and runs, but only values
// that look like identifiers: an id field is model-controlled and could carry an email.
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
// Not glued to letters or hyphens (UUID segments, ISO dates); at least 10 digits.
const PHONE = /(?<![\w-])\+?\d[\d\s().-]{7,}\d(?![\w-])/g;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID_KEY = /(^id$|_id$|Id$)/;
// UUIDs and slugs (tenant_olivia, prop_mcr_1): no spaces, "@", "+" or dots.
const ID_VALUE = /^[\w-]{1,100}$/;
const keepAsId = (key: string, value: unknown) =>
  ID_KEY.test(key) && (value === null || typeof value === "number" || (typeof value === "string" && ID_VALUE.test(value)));

function redactText(text: string): string {
  if (UUID.test(text)) return text;
  return text
    .replace(EMAIL, "[email]")
    .replace(PHONE, (match) => (match.replace(/\D/g, "").length >= 10 ? "[phone]" : match));
}

export function redact<T>(value: T): T {
  if (typeof value === "string") return redactText(value) as T;
  if (Array.isArray(value)) return value.map(redact) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, keepAsId(k, v) ? v : redact(v)]),
    ) as T;
  }
  return value;
}
