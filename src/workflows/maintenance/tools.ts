import { createHash } from "node:crypto";
import { z } from "zod";
import { Category, Hazard } from "@/domain/enums";
import { evaluatePolicy, type PolicyDecision } from "@/domain/policy";
import { defineTool, type ToolContext } from "@/runtime/types";
import type { AppDeps } from "../deps";
import { authorizeTicketOwnership } from "../shared";

// Tool schemas are strict: arguments the model invents (e.g. `priority`) are rejected.
// Optional fields are nullable rather than omitted, as provider strict modes require.

type Ctx = ToolContext<AppDeps>;

async function tenantContext(ctx: Ctx) {
  const context = await ctx.deps.repo.getTenantContext(ctx.tenantId);
  if (!context) throw new Error(`Session tenant ${ctx.tenantId} not found`);
  return context;
}

export const getPropertyContext = defineTool<AppDeps, Record<string, never>>({
  name: "get_property_context",
  description: "Get the tenant's property and letting agency. Call this before creating a ticket.",
  input: z.strictObject({}),
  execute: async (ctx) => tenantContext(ctx),
});

export const getMaintenancePolicy = defineTool<AppDeps, Record<string, never>>({
  name: "get_maintenance_policy",
  description:
    "Get the letting agency's maintenance policy, to explain to the tenant what happens next. " +
    "Priority is always decided by the system, never by you.",
  input: z.strictObject({}),
  execute: async (ctx) => {
    const { agency } = await tenantContext(ctx);
    const active = await ctx.deps.repo.getActivePolicy(agency.id);
    if (!active) throw new Error(`No active policy for ${agency.id}`);
    return { agency: agency.name, version: active.version, policy: active.policy };
  },
});

const CreateTicketInput = z.strictObject({
  property_id: z.string(),
  category: Category,
  hazards: z.array(Hazard).describe("Only hazards the tenant actually described; [] if none."),
  location: z.string().max(200).nullable().describe("Where in the property, e.g. 'kitchen ceiling'."),
  description: z.string().min(1).max(2000).describe("The problem in the tenant's own terms."),
});
type CreateTicketInput = z.infer<typeof CreateTicketInput>;

type TicketPolicy = { decision: PolicyDecision; version: number; agencyId: string };

export const createMaintenanceTicket = defineTool<AppDeps, CreateTicketInput, TicketPolicy>({
  name: "create_maintenance_ticket",
  description:
    "Create a maintenance ticket once you know the category and have a description. " +
    "The system decides priority, cost estimate and whether a human must review it.",
  input: CreateTicketInput,
  authorize: async (ctx, args) => {
    const { property } = await tenantContext(ctx);
    return property.id === args.property_id
      ? null
      : { code: "property_not_authorized", message: "The tenant cannot report issues for this property." };
  },
  applyPolicy: async (ctx, args) => {
    const { agency } = await tenantContext(ctx);
    const active = await ctx.deps.repo.getActivePolicy(agency.id);
    if (!active) throw new Error(`No active policy for ${agency.id}`);
    return {
      decision: evaluatePolicy(active.policy, { category: args.category, hazards: args.hazards }),
      version: active.version,
      agencyId: agency.id,
    };
  },
  // Dedupes retries of the same request; separate requests never merge.
  idempotencyKey: (ctx, args) =>
    createHash("sha256").update(`${ctx.requestId}|${args.property_id}|${args.category}`).digest("hex"),
  execute: async (ctx, args, { policy, idempotencyKey }) => {
    const { decision, version, agencyId } = policy;
    const result = await ctx.deps.repo.createTicketWithReview(
      {
        agencyId,
        propertyId: args.property_id,
        tenantId: ctx.tenantId,
        runId: ctx.runId,
        category: args.category,
        hazards: args.hazards,
        location: args.location,
        description: args.description,
        priority: decision.priority,
        estimatedCostGbp: decision.estimatedCostGbp,
        policyVersion: version,
        idempotencyKey: idempotencyKey!,
      },
      decision.forceReview
        ? {
            runId: ctx.runId,
            agencyId,
            tenantId: ctx.tenantId,
            source: "policy",
            reason: decision.reviewReasons.join("; "),
          }
        : null,
    );
    const { ticket } = result;
    return {
      ticket_id: ticket.id,
      duplicate: result.duplicate,
      priority: ticket.priority,
      status: ticket.status,
      estimated_cost_gbp: ticket.estimatedCostGbp,
      sent_to_human_review: result.duplicate ? undefined : result.review !== null,
    };
  },
});

const RequestReviewInput = z.strictObject({
  reason: z.string().min(1).max(500).describe("Why a person should look at this."),
  ticket_id: z.string().nullable().describe("The related ticket, if one was created."),
});
type RequestReviewInput = z.infer<typeof RequestReviewInput>;

export const requestHumanReview = defineTool<AppDeps, RequestReviewInput>({
  name: "request_human_review",
  description:
    "Ask a person at the letting agency to review the case when you are unsure what to do. " +
    "Emergencies are already sent to review automatically.",
  input: RequestReviewInput,
  authorize: async (ctx, args) => (args.ticket_id === null ? null : authorizeTicketOwnership(ctx, args.ticket_id)),
  execute: async (ctx, args) => {
    const { agency } = await tenantContext(ctx);
    const review = await ctx.deps.repo.createReview({
      runId: ctx.runId,
      agencyId: agency.id,
      tenantId: ctx.tenantId,
      ticketId: args.ticket_id,
      source: "agent",
      reason: args.reason,
    });
    return { review_id: review.id, status: review.status };
  },
});

export const maintenanceTools = [
  getPropertyContext,
  getMaintenancePolicy,
  createMaintenanceTicket,
  requestHumanReview,
];
