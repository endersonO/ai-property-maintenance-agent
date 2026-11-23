import { createHash } from "node:crypto";
import { z } from "zod";
import { Category, Hazard } from "@/domain/enums";
import { evaluatePolicy, type PolicyDecision } from "@/domain/policy";
import type { Ticket } from "@/domain/repository";
import { defineTool, type ToolContext } from "@/runtime/types";
import type { AppDeps } from "../deps";
import { authorizeTicketOwnership, tenantOf } from "../shared";

// Tool schemas are strict: arguments the model invents (e.g. `priority`) are rejected.
// Optional fields are nullable rather than omitted, as provider strict modes require.

type Ctx = ToolContext<AppDeps>;

async function tenantContext(ctx: Ctx) {
  const context = await ctx.deps.repo.getTenantContext(tenantOf(ctx));
  if (!context) throw new Error(`Session tenant ${tenantOf(ctx)} not found`);
  return context;
}

const OPEN = new Set(["open", "in_progress"]);

// The tenant's own open tickets, so a follow-up ("it's still leaking") can be recognised.
async function openTickets(ctx: Ctx) {
  return (await ctx.deps.repo.listTickets(tenantOf(ctx))).filter((t) => OPEN.has(t.status));
}

export const getPropertyContext = defineTool<AppDeps, Record<string, never>>({
  name: "get_property_context",
  description:
    "Get the tenant's property, letting agency and open tickets. Call this first: if the tenant is talking about a problem already in open_tickets, add to that ticket instead of creating one.",
  input: z.strictObject({}),
  execute: async (ctx) => ({
    ...(await tenantContext(ctx)),
    open_tickets: (await openTickets(ctx)).map((t) => ({
      ticket_id: t.id,
      category: t.category,
      location: t.location,
      description: t.description.length > 200 ? `${t.description.slice(0, 200)}…` : t.description,
      priority: t.priority,
      status: t.status,
      reported_on: t.createdAt.toISOString().slice(0, 10),
    })),
  }),
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
  new_problem: z
    .boolean()
    .describe(
      "true only if this is a different problem from every open ticket of the same category (e.g. a dripping tap while a ceiling leak is open). Otherwise false: the report is added to that open ticket.",
    ),
});
type CreateTicketInput = z.infer<typeof CreateTicketInput>;

type TicketPolicy = { decision: PolicyDecision; version: number; agencyId: string };

const keyOf = (...parts: string[]) => createHash("sha256").update(parts.join("|")).digest("hex");

// Adds a report to an existing open ticket, with the policy's decision for the ticket's
// category and ALL its hazards: priority may go up (never down) and the review the policy then
// requires is added. Shared by add_details_to_ticket and the create tool's duplicate guard.
async function addToTicket(
  ctx: Ctx,
  ticket: Ticket,
  args: { details: string; hazards: Hazard[] },
  idempotencyKey: string,
) {
  const active = await ctx.deps.repo.getActivePolicy(ticket.agencyId);
  if (!active) throw new Error(`No active policy for ${ticket.agencyId}`);
  const hazards = [...new Set([...ticket.hazards, ...args.hazards])];
  const decision = evaluatePolicy(active.policy, { category: ticket.category, hazards });
  const result = await ctx.deps.repo.addTicketUpdate(
    { ticketId: ticket.id, runId: ctx.runId, tenantId: tenantOf(ctx), details: args.details, hazards: args.hazards, idempotencyKey },
    { priority: decision.priority, hazards },
    decision.forceReview
      ? { runId: ctx.runId, agencyId: ticket.agencyId, tenantId: tenantOf(ctx), source: "policy", reason: decision.reviewReasons.join("; ") }
      : null,
  );
  return {
    ticket_id: result.ticket.id,
    added_to_existing_ticket: true,
    escalated: result.escalated,
    priority: result.ticket.priority,
    status: result.ticket.status,
    estimated_cost_gbp: result.ticket.estimatedCostGbp,
    // A review added now; an earlier review of the ticket still stands.
    sent_to_human_review: result.review !== null,
  };
}

// Open tickets of the same kind on the same property: candidates for the duplicate guard. The
// ticket this same request already created is not a candidate (a retry takes the
// idempotency path instead).
async function sameKindOpen(ctx: Ctx, args: CreateTicketInput, idempotencyKey: string) {
  return (await openTickets(ctx)).filter(
    (t) => t.propertyId === args.property_id && t.category === args.category && t.idempotencyKey !== idempotencyKey,
  );
}

const createKey = (ctx: Ctx, args: CreateTicketInput) => keyOf(ctx.requestId, args.property_id, args.category);

// An update's key names the exact call — the request, where it goes, and what it adds — so an
// identical retry is recognised, while a second call in the same request with new data (a
// hazard the first call missed) is applied, not mistaken for a retry.
const contentOf = (details: string, hazards: Hazard[]) => [details, [...hazards].sort().join(",")];
const addKey = (ctx: Ctx, ticketId: string, details: string, hazards: Hazard[]) =>
  keyOf(ctx.requestId, "add", ticketId, ...contentOf(details, hazards));
// The duplicate guard's key doesn't depend on the ticket it picked: a retry finds what the
// first attempt did even if the open tickets changed since.
const guardDetails = (args: CreateTicketInput) => [args.location, args.description].filter(Boolean).join(": ");
const guardKey = (ctx: Ctx, args: CreateTicketInput) =>
  keyOf(ctx.requestId, "guard", args.property_id, args.category, ...contentOf(guardDetails(args), args.hazards));

// What this request already did, read before choosing anything: a retry must return the
// original result, never pick a ticket again (another one may have been opened since).
// Most specific first: this exact call's update (same content) names its ticket; only then
// "this request created a ticket of this kind" — the same request may have updated A with
// this call and created B with another one.
async function priorOutcome(ctx: Ctx, args: CreateTicketInput): Promise<{ created: true } | { addedTo: Ticket } | null> {
  const update = await ctx.deps.repo.findTicketUpdateByKey(guardKey(ctx, args));
  const ticket = update && (await ctx.deps.repo.getTicket(update.ticketId));
  if (ticket) return { addedTo: ticket };
  const key = createKey(ctx, args);
  if ((await ctx.deps.repo.listTickets(tenantOf(ctx))).some((t) => t.idempotencyKey === key)) return { created: true };
  return null;
}

const GUARD_NOTE =
  "Added to the tenant's open ticket for the same kind of problem; no new ticket was created. If it is a different problem, call again with new_problem: true.";

export const createMaintenanceTicket = defineTool<AppDeps, CreateTicketInput, TicketPolicy>({
  name: "create_maintenance_ticket",
  description:
    "Create a maintenance ticket once you know the category and have a description. " +
    "The system decides priority, cost estimate and whether a human must review it.",
  input: CreateTicketInput,
  authorize: async (ctx, args) => {
    const { property, agency } = await tenantContext(ctx);
    if (property.id !== args.property_id) {
      return { code: "property_not_authorized", message: "The tenant cannot report issues for this property." };
    }
    // Several open tickets of this kind: the code can't tell which one the tenant means, so
    // nothing is written until the model names it. An emergency is never held back for this:
    // it gets its own ticket below and reaches a person.
    if (!args.new_problem && !(await priorOutcome(ctx, args))) {
      const candidates = await sameKindOpen(ctx, args, createKey(ctx, args));
      if (candidates.length > 1) {
        const active = await ctx.deps.repo.getActivePolicy(agency.id);
        const emergency = active && evaluatePolicy(active.policy, { category: args.category, hazards: args.hazards }).priority === "emergency";
        if (!emergency) {
          return {
            code: "choose_ticket",
            message:
              `The tenant has ${candidates.length} open ${args.category} tickets (${candidates.map((t) => `${t.id}: ${t.location ?? t.description.slice(0, 60)}`).join("; ")}). ` +
              "If this is about one of them, call add_details_to_ticket with its ticket_id; if it is a different problem, call again with new_problem: true. Nothing was written.",
          };
        }
      }
    }
    return null;
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
  // Dedupes retries of the same request; separate requests never merge. A more severe
  // repeat escalates the existing ticket instead of being swallowed (planDuplicate).
  idempotencyKey: createKey,
  execute: async (ctx, args, { policy, idempotencyKey }) => {
    // Duplicate guard, decided by code: unless the model says this is a different problem, a
    // report of the same category as an open ticket on the same property is added to that
    // ticket — never dropped, so an emergency still escalates it and reaches a person.
    if (!args.new_problem) {
      const prior = await priorOutcome(ctx, args);
      // A retry of a redirected report: the same ticket again (the repository sees the key).
      if (prior && "addedTo" in prior) {
        return { ...(await addToTicket(ctx, prior.addedTo, { details: guardDetails(args), hazards: args.hazards }, guardKey(ctx, args))), note: GUARD_NOTE };
      }
      // Exactly one candidate: that is the ticket. Several only reach here for an emergency,
      // which gets its own ticket (see authorize). A retry of a created ticket skips this and
      // takes the create's idempotency path below.
      const candidates = prior ? [] : await sameKindOpen(ctx, args, idempotencyKey!);
      const sameKind = candidates.length === 1 ? candidates[0] : null;
      if (sameKind) {
        return { ...(await addToTicket(ctx, sameKind, { details: guardDetails(args), hazards: args.hazards }, guardKey(ctx, args))), note: GUARD_NOTE };
      }
    }
    const { decision, version, agencyId } = policy;
    const result = await ctx.deps.repo.createTicketWithReview(
      {
        agencyId,
        propertyId: args.property_id,
        tenantId: tenantOf(ctx),
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
            tenantId: tenantOf(ctx),
            source: "policy",
            reason: decision.reviewReasons.join("; "),
          }
        : null,
    );
    const { ticket } = result;
    return {
      ticket_id: ticket.id,
      duplicate: result.duplicate,
      escalated: result.duplicate ? result.escalated : undefined,
      priority: ticket.priority,
      status: ticket.status,
      estimated_cost_gbp: ticket.estimatedCostGbp,
      sent_to_human_review: result.review !== null ? true : result.duplicate ? undefined : false,
    };
  },
});

const AddDetailsInput = z.strictObject({
  ticket_id: z.string().describe("One of the tenant's open tickets, from open_tickets."),
  details: z.string().min(1).max(2000).describe("What the tenant added, in their own terms."),
  hazards: z.array(Hazard).describe("Hazards the tenant describes now; [] if none."),
});
type AddDetailsInput = z.infer<typeof AddDetailsInput>;

export const addDetailsToTicket = defineTool<AppDeps, AddDetailsInput>({
  name: "add_details_to_ticket",
  description:
    "Add what the tenant says to one of their OPEN tickets (it's still happening, it got worse, more details). " +
    "The system re-checks the priority with the new hazards — it can go up, never down — and sends it to review if needed.",
  input: AddDetailsInput,
  authorize: async (ctx, args) => {
    const owned = await authorizeTicketOwnership(ctx, args.ticket_id);
    if (owned) return owned;
    const ticket = await ctx.deps.repo.getTicket(args.ticket_id);
    return ticket && OPEN.has(ticket.status)
      ? null
      : { code: "ticket_closed", message: "That ticket is closed: create a new ticket for the problem." };
  },
  idempotencyKey: (ctx, args) => addKey(ctx, args.ticket_id, args.details, args.hazards),
  execute: async (ctx, args, { idempotencyKey }) => {
    const ticket = (await ctx.deps.repo.getTicket(args.ticket_id))!;
    return addToTicket(ctx, ticket, { details: args.details, hazards: args.hazards }, idempotencyKey!);
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
      tenantId: tenantOf(ctx),
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
  addDetailsToTicket,
  requestHumanReview,
];
