import { z } from "zod";
import type { Fact } from "@/infra/operations-queries";
import { PERIODS } from "@/operations/periods";
import type { BriefReport, OpsDeps } from "@/operations/port";
import { defineTool, type ToolContext } from "@/runtime/types";

// Read-only, aggregate-only tools. Numbers come from SQL; every fact carries the key the brief
// must cite next to the figure. The manager's scope comes from the server: an agency_id argument
// narrows it and is rejected at authorize when outside it — it never grants access.

type Ctx = ToolContext<OpsDeps>;

const Period = z.enum(PERIODS).describe("A closed reporting period; never the current, incomplete one.");
const AgencyFilter = z
  .string()
  .nullable()
  .describe("One agency id from list_my_agencies (e.g. agency_riverside) to focus on, or null for all agencies you manage.");

const ScopeInput = z.strictObject({ period: Period, agency_id: AgencyFilter });
type ScopeInput = z.infer<typeof ScopeInput>;

const ResolutionInput = z.strictObject({
  period: Period,
  agency_id: AgencyFilter,
  priority: z.enum(["emergency", "high", "normal", "low"]).nullable().describe("Only tickets with this priority, or null."),
});
type ResolutionInput = z.infer<typeof ResolutionInput>;

async function authorizeAgency(ctx: Ctx, args: { agency_id: string | null }) {
  // The actor must be the manager the server scoped these deps to.
  if (ctx.actorId !== ctx.deps.scope.managerId) return { code: "actor_mismatch", message: "Session and scope disagree." };
  if (args.agency_id !== null && !ctx.deps.scope.agencyIds.includes(args.agency_id)) {
    return { code: "agency_not_authorized", message: "That agency is not in your scope." };
  }
  return null;
}

// The dataset and cut-off come from the report itself: the ones its facts were computed with.
async function present(ctx: Ctx, report: BriefReport) {
  const { dataset, asOf } = report;
  const names = await ctx.deps.operations.agencyNames(ctx.deps.scope.agencyIds);
  return {
    dataset,
    data_note:
      dataset === "synthetic"
        ? "Synthetic demonstration history, not real operations."
        : "Live data: the current state of real tickets.",
    as_of: dataset === "live" ? asOf.toISOString().slice(0, 16).replace("T", " ") + " UTC" : asOf.toISOString().slice(0, 10),
    facts: report.facts.map((f: Fact) => ({
      key: f.key,
      metric: f.metric,
      agency: f.agencyId === "all" ? "all your agencies" : (names[f.agencyId] ?? f.agencyId),
      agency_id: f.agencyId,
      period: f.period,
      unit: f.unit,
      value: f.value,
      ...(f.n !== undefined && { n: f.n }),
    })),
    notes: report.notes,
  };
}

const queryOf = (ctx: Ctx, args: { period: ScopeInput["period"]; agency_id: string | null }) => ({
  period: args.period,
  agencyIds: args.agency_id ? [args.agency_id] : ctx.deps.scope.agencyIds,
});

export const getVolume = defineTool<OpsDeps, ScopeInput>({
  name: "get_volume",
  description:
    "Tickets created in a closed period, the change vs the previous period and the same period last year, and tickets per 100 homes, per agency and in total.",
  input: ScopeInput,
  authorize: authorizeAgency,
  execute: async (ctx, args) => present(ctx, await ctx.deps.operations.volume(queryOf(ctx, args))),
});

export const getResolution = defineTool<OpsDeps, ResolutionInput>({
  name: "get_resolution",
  description:
    "For tickets created in a closed period: how many, the share resolved, median and p90 hours to resolve, the open backlog and its age, per agency and in total.",
  input: ResolutionInput,
  authorize: authorizeAgency,
  execute: async (ctx, args) =>
    present(ctx, await ctx.deps.operations.resolution({ ...queryOf(ctx, args), priority: args.priority })),
});

const OpenNowInput = z.strictObject({ agency_id: AgencyFilter });
type OpenNowInput = z.infer<typeof OpenNowInput>;

export const getOpenNow = defineTool<OpsDeps, OpenNowInput>({
  name: "get_open_now",
  description:
    "Right now, from LIVE tickets: how many are open, how many open emergencies, the oldest open emergency's age, and reviews pending — per agency and in total. Use it for 'what is open / what is happening now'.",
  input: OpenNowInput,
  authorize: authorizeAgency,
  execute: async (ctx, args) =>
    present(ctx, await ctx.deps.operations.openNow({ agencyIds: args.agency_id ? [args.agency_id] : ctx.deps.scope.agencyIds })),
});

export const listMyAgencies = defineTool<OpsDeps, Record<string, never>>({
  name: "list_my_agencies",
  description: "The agencies you manage: their ids (to pass as agency_id), names, and acquisition/onboarding dates.",
  input: z.strictObject({}),
  authorize: (ctx) => authorizeAgency(ctx, { agency_id: null }),
  execute: async (ctx) =>
    (await ctx.deps.operations.agencies(ctx.deps.scope.agencyIds)).map((a) => ({
      agency_id: a.id,
      name: a.name,
      acquired_on: a.acquiredOn,
      onboarded_on: a.onboardedOn,
    })),
});

export const operationsBriefTools = [listMyAgencies, getOpenNow, getVolume, getResolution];
