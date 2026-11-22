import type { Rejection, ToolContext } from "@/runtime/types";
import type { AppDeps } from "./deps";

// Same answer for "missing" and "not yours": never reveal other tenants' tickets.
export async function authorizeTicketOwnership(
  ctx: ToolContext<AppDeps>,
  ticketId: string,
): Promise<Rejection | null> {
  const ticket = await ctx.deps.repo.getTicket(ticketId);
  return ticket?.tenantId === ctx.tenantId
    ? null
    : { code: "ticket_not_found", message: "No such ticket for this tenant." };
}
