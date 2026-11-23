import { z } from "zod";
import type { Ticket } from "@/domain/repository";
import { defineTool, type ToolContext } from "@/runtime/types";
import type { AppDeps } from "../deps";
import { tenantOf } from "../shared";

// Read-only tools: this workflow answers questions, it never changes a ticket.

async function describe(deps: AppDeps, tenantId: string, ticket: Ticket) {
  const reviews = await deps.repo.listReviews(tenantId);
  const review = reviews.find((r) => r.ticketId === ticket.id);
  return {
    ticket_id: ticket.id,
    category: ticket.category,
    location: ticket.location,
    description: ticket.description,
    priority: ticket.priority,
    status: ticket.status,
    created_at: ticket.createdAt.toISOString(),
    human_review: review ? review.status : null,
  };
}

export const listMyTickets = defineTool<AppDeps, Record<string, never>>({
  name: "list_my_tickets",
  description: "List the tenant's maintenance tickets, newest first. Use it to find the ticket they are asking about.",
  input: z.strictObject({}),
  execute: async (ctx) => {
    const tickets = await ctx.deps.repo.listTickets(tenantOf(ctx));
    return Promise.all(tickets.map((t) => describe(ctx.deps, tenantOf(ctx), t)));
  },
});

const GetTicketInput = z.strictObject({
  ticket_id: z
    .string()
    .describe("The ticket id, or the short number the tenant sees in the portal (its first 8 characters, e.g. 547bf635)."),
});
type GetTicketInput = z.infer<typeof GetTicketInput>;

const FULL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A prefix of the id, dashes optional ("547bf635", "547bf635-4", "547bf6354").
const SHORT_REF = /^#?([0-9a-f-]{8,})$/i;
const hexOnly = (s: string) => s.replace(/-/g, "").toLowerCase();

// The portal shows tickets by a short number (#547bf635), so tenants quote it. A short number is
// resolved ONLY among the tenant's own tickets: another tenant's ticket never matches, and the
// answer is the same "not found" either way — nothing is revealed.
async function resolveOwnTicket(ctx: ToolContext<AppDeps>, ref: string) {
  const trimmed = ref.trim();
  if (FULL_ID.test(trimmed)) {
    const ticket = await ctx.deps.repo.getTicket(trimmed);
    return ticket && ticket.tenantId === tenantOf(ctx) ? { ticket } : { ticket: null };
  }
  const short = SHORT_REF.exec(trimmed)?.[1];
  // Compared without dashes on both sides, so a longer prefix always narrows the match.
  const prefix = short ? hexOnly(short) : "";
  if (prefix.length < 8) return { ticket: null };
  const matches = (await ctx.deps.repo.listTickets(tenantOf(ctx))).filter((t) => hexOnly(t.id).startsWith(prefix));
  return matches.length > 1 ? { ticket: null, ambiguous: true } : { ticket: matches[0] ?? null };
}

export const getTicket = defineTool<AppDeps, GetTicketInput>({
  name: "get_ticket",
  description: "Get one of the tenant's tickets by its id or by the short number shown in the portal.",
  input: GetTicketInput,
  authorize: async (ctx, args) => {
    const found = await resolveOwnTicket(ctx, args.ticket_id);
    if (found.ambiguous) return { code: "ticket_ref_ambiguous", message: "Several of your tickets start with that number; use more characters." };
    return found.ticket ? null : { code: "ticket_not_found", message: "No such ticket for this tenant." };
  },
  execute: async (ctx, args) => describe(ctx.deps, tenantOf(ctx), (await resolveOwnTicket(ctx, args.ticket_id)).ticket!),
});

export const ticketStatusTools = [listMyTickets, getTicket];
