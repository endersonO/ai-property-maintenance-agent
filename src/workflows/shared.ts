import type { Rejection, ToolContext } from "@/runtime/types";
import type { AppDeps } from "./deps";

// Tenant workflows are only ever run with a tenant as the actor (the server sets it from the
// session), so the actor id is the tenant id.
export const tenantOf = (ctx: ToolContext<AppDeps>): string => ctx.actorId;

// Same answer for "missing" and "not yours": never reveal other tenants' tickets.
export async function authorizeTicketOwnership(
  ctx: ToolContext<AppDeps>,
  ticketId: string,
): Promise<Rejection | null> {
  const ticket = await ctx.deps.repo.getTicket(ticketId);
  return ticket?.tenantId === tenantOf(ctx)
    ? null
    : { code: "ticket_not_found", message: "No such ticket for this tenant." };
}
