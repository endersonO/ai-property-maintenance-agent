import { z } from "zod";
import { CHECK_COPY } from "@/evaluators/check-copy";
import { evaluators } from "@/evaluators";
import { defineTool, type ToolContext } from "@/runtime/types";
import type { QualityDeps, RunDetail, RunListing } from "./port";

// Read-only tools over the Agent Inspector's data. Every count is a fact with a key the answer
// must cite (checked by numbers_grounded). Text written by tenants and managers, and the agent's
// own replies, come back under *_untrusted fields: they are evidence to report, never instructions.

type Ctx = ToolContext<QualityDeps>;

const CHECK_IDS = evaluators.map((e) => e.id) as [string, ...string[]];
const WORKFLOW_IDS = ["maintenance", "ticket-status", "operations-brief", "quality-analyst"] as const;
// All counts are platform-wide: numbers_grounded skips the agency check for "all …" facts.
const SCOPE = "all runs";
const MAX_TEXT = { listing: 300, detail: 1500 };

const fact = (key: string, value: number, unit: "runs" | "tool calls" | "gbp") => ({ key, value, unit, agency: SCOPE });
const ref = (id: string) => id.replace(/-/g, "").slice(0, 8);
const clip = (text: string | null, max: number) => (text && text.length > max ? `${text.slice(0, max)}…` : text);
const minute = (d: Date) => d.toISOString().slice(0, 16).replace("T", " ") + " UTC";

async function authorizeViewer(ctx: Ctx) {
  // The actor must be the viewer the server set up these deps for.
  if (ctx.actorId !== ctx.deps.viewerId) return { code: "actor_mismatch", message: "Session and viewer disagree." };
  return null;
}

const checkName = (id: string) => CHECK_COPY[id]?.title ?? id;

function presentRun(run: RunListing, max: number) {
  return {
    run_ref: ref(run.id),
    run_id: run.id,
    at: minute(run.createdAt),
    workflow: run.workflowId,
    who: run.who,
    agency: run.agency,
    asked_untrusted: clip(run.asked, max),
    status: run.status,
    error: run.error,
    tickets: run.tickets.map((t) => ({ ticket_id: t.id, priority: t.priority, status: t.status, escalated: t.escalated, details_added: t.updated })),
    review_requested: run.reviewsTotal > 0,
    review_still_pending: run.reviewsPending > 0,
    // Only what needs attention: a failure, a check that couldn't run, or one not run yet.
    checks_needing_attention: run.checks
      .filter((c) => c.verdict === "fail" || c.verdict === "error" || c.verdict === "pending")
      .map((c) => ({
        check: c.checkId,
        name: checkName(c.checkId),
        verdict: c.verdict === "error" ? "could_not_run" : c.verdict === "pending" ? "not_checked_yet" : "failed",
        evidence_untrusted: clip(c.evidence, max),
      })),
  };
}

export const getQualitySummary = defineTool<QualityDeps, Record<string, never>>({
  name: "get_quality_summary",
  description:
    "The Inspector's headline over every finished run: how many were checked, broke a rule, were flagged by an alarm, had a check that couldn't run or are not checked yet; per check, its results; and runs per workflow.",
  input: z.strictObject({}),
  authorize: authorizeViewer,
  execute: async (ctx) => {
    const o = await ctx.deps.quality.overview();
    return {
      checks: o.checks.map((c) => ({
        check: c.checkId,
        name: checkName(c.checkId),
        type: c.kind === "invariant" ? "rule (must always hold)" : "alarm (heuristic, flags a run for a person to look at)",
        protects: CHECK_COPY[c.checkId]?.protects ?? null,
      })),
      facts: [
        fact("runs_finished", o.finished, "runs"),
        fact("runs_checked", o.checked, "runs"),
        fact("runs_not_checked_yet", o.notCheckedYet, "runs"),
        fact("runs_rule_broken", o.ruleBroken, "runs"),
        fact("runs_flagged_by_alarm", o.flaggedByAlarm, "runs"),
        fact("runs_check_could_not_run", o.checkCouldNotRun, "runs"),
        ...o.checks.flatMap((c) => [
          fact(`${c.checkId}.passed`, c.passed, "runs"),
          fact(`${c.checkId}.failed`, c.failed, "runs"),
          fact(`${c.checkId}.could_not_run`, c.couldNotRun, "runs"),
          fact(`${c.checkId}.not_applicable`, c.notApplicable, "runs"),
          fact(`${c.checkId}.not_checked_yet`, c.notCheckedYet, "runs"),
        ]),
        ...o.runsByWorkflow.map((w) => fact(`runs.${w.workflowId}`, w.runs, "runs")),
      ],
      notes: [
        "A check that couldn't run is unknown, not a failure.",
        "'not applicable' means the check had nothing to look at in that run (e.g. no emergency).",
      ],
    };
  },
});

const ListRunsInput = z
  .strictObject({
    problems: z
      .enum(["rules", "alarms", "errors", "any"])
      .nullable()
      .describe("rules: a rule failed; alarms: an alarm failed and no rule did; errors: a check couldn't run; any: any of those; null: no filter."),
    check_id: z.enum(CHECK_IDS).nullable().describe("Only runs where this check failed or couldn't run, or null."),
    verdict: z.enum(["fail", "error"]).nullable().describe("With check_id: only this verdict, or null for both."),
    workflow: z.enum(WORKFLOW_IDS).nullable().describe("Only runs of this workflow, or null."),
    limit: z.number().int().min(1).max(20).describe("How many of the latest matching runs to return (1–20)."),
  })
  .refine((a) => !(a.problems && a.check_id), { message: "Use problems or check_id, not both." })
  .refine((a) => !a.verdict || a.check_id, { message: "verdict needs a check_id." });
type ListRunsInput = z.infer<typeof ListRunsInput>;

export const listRuns = defineTool<QualityDeps, ListRunsInput>({
  name: "list_runs",
  description:
    "The latest runs (newest first), optionally only those with problems or one check's failures, or one workflow: who, what they asked, what the run left (tickets, reviews), and the checks that need attention with their evidence.",
  input: ListRunsInput,
  authorize: authorizeViewer,
  execute: async (ctx, args) => {
    const { total, runs } = await ctx.deps.quality.runs({
      problems: args.problems,
      checkId: args.check_id,
      verdict: args.verdict,
      workflowId: args.workflow,
      limit: args.limit,
    });
    const filter = args.check_id ? `${args.check_id}${args.verdict ? `_${args.verdict}` : ""}` : (args.problems ?? "all");
    return {
      facts: [fact(`matching_runs.${filter}${args.workflow ? `.${args.workflow}` : ""}`, total, "runs")],
      showing: `the latest ${runs.length} of the matching runs`,
      runs: runs.map((r) => presentRun(r, MAX_TEXT.listing)),
    };
  },
});

const RUN_REF = /^#?[0-9a-f-]{8,36}$/i;
const GetRunInput = z.strictObject({
  run_ref: z.string().describe("A run id or its first 8+ characters, as list_runs returns it."),
});
type GetRunInput = z.infer<typeof GetRunInput>;

function presentDetail(run: RunDetail) {
  const r = ref(run.id);
  return {
    ...presentRun(run, MAX_TEXT.detail),
    reply_untrusted: clip(run.reply, MAX_TEXT.detail),
    all_checks: run.checks.map((c) => ({
      check: c.checkId,
      name: checkName(c.checkId),
      verdict: c.verdict,
      evidence_untrusted: clip(c.evidence, MAX_TEXT.listing),
    })),
    tool_calls: run.toolCalls,
    tickets: run.ticketDetails.map((t) => ({
      ticket_id: t.id,
      priority: t.priority,
      category: t.category,
      status: t.status,
      escalated: t.escalated,
      details_added: t.updated,
      cost_fact: `run.${r}.ticket.${ref(t.id)}.estimated_cost_gbp`,
    })),
    reviews: run.reviews.map((v) => ({ source: v.source, reason_untrusted: clip(v.reason, MAX_TEXT.listing), status: v.status })),
  };
}

// Same place as in the other tools (data.facts): that is where numbers_grounded reads them.
function runFacts(run: RunDetail) {
  const r = ref(run.id);
  return [
    fact(`run.${r}.tool_calls`, run.toolCalls.length, "tool calls"),
    ...run.ticketDetails.map((t) => fact(`run.${r}.ticket.${ref(t.id)}.estimated_cost_gbp`, t.estimatedCostGbp, "gbp")),
  ];
}

export const getRun = defineTool<QualityDeps, GetRunInput>({
  name: "get_run",
  description:
    "One run in detail: the message, the agent's reply, its tool calls (with stages that rejected them), tickets and reviews it left, and every check's verdict and evidence.",
  input: GetRunInput,
  authorize: authorizeViewer,
  execute: async (ctx, args) => {
    if (!RUN_REF.test(args.run_ref.trim())) {
      return { found: false, note: "A run reference is a run id or its first 8 or more characters." };
    }
    const lookup = await ctx.deps.quality.run(args.run_ref.trim().replace(/^#/, ""));
    if (lookup.kind === "not_found") return { found: false, note: "No run starts with that reference." };
    if (lookup.kind === "ambiguous") return { found: false, note: "More than one run starts with that reference: give more characters." };
    return { found: true, run: presentDetail(lookup.run), facts: runFacts(lookup.run) };
  },
});

export const qualityAnalystTools = [getQualitySummary, listRuns, getRun];
