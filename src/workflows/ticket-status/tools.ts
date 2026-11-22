import { z } from "zod";
import type { Ticket } from "@/domain/repository";
import { defineTool } from "@/runtime/types";
import type { AppDeps } from "../deps";
import { authorizeTicketOwnership } from "../shared";

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
    const tickets = await ctx.deps.repo.listTickets(ctx.tenantId);
    return Promise.all(tickets.map((t) => describe(ctx.deps, ctx.tenantId, t)));
  },
});

const GetTicketInput = z.strictObject({ ticket_id: z.string() });
type GetTicketInput = z.infer<typeof GetTicketInput>;

export const getTicket = defineTool<AppDeps, GetTicketInput>({
  name: "get_ticket",
  description: "Get one of the tenant's tickets by id.",
  input: GetTicketInput,
  authorize: (ctx, args) => authorizeTicketOwnership(ctx, args.ticket_id),
  execute: async (ctx, args) => describe(ctx.deps, ctx.tenantId, (await ctx.deps.repo.getTicket(args.ticket_id))!),
});

export const ticketStatusTools = [listMyTickets, getTicket];
