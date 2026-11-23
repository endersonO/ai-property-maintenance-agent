import { describe, expect, it } from "vitest";
import type { Repository, Ticket } from "@/domain/repository";
import { executeToolCall } from "@/runtime/executor";
import type { ToolContext } from "@/runtime/types";
import type { AppDeps } from "../deps";
import { ticketStatusTools } from "./tools";

// Short-number resolution with controlled ids (the in-memory repository generates random ones).
const ticket = (id: string, tenantId: string): Ticket =>
  ({ id, tenantId, category: "plumbing", location: null, description: "Leak", priority: "normal", status: "open", createdAt: new Date() }) as Ticket;

function ctxWith(tickets: Ticket[]): ToolContext<AppDeps> {
  const repo = {
    listTickets: async (tenantId: string) => tickets.filter((t) => t.tenantId === tenantId),
    getTicket: async (id: string) => tickets.find((t) => t.id === id) ?? null,
    listReviews: async () => [],
  } as unknown as Repository;
  return { runId: "r", requestId: "q", actorId: "tenant_olivia", deps: { repo } };
}

const get = (ctx: ToolContext<AppDeps>, ref: string) =>
  executeToolCall(ticketStatusTools, { name: "get_ticket", args: { ticket_id: ref } }, ctx);

describe("get_ticket short numbers", () => {
  const mine = ticket("547bf635-453a-4d69-ad12-efbd3662f1da", "tenant_olivia");

  it("accepts the portal's short number, with or without #, and the full id", async () => {
    const ctx = ctxWith([mine]);
    for (const ref of ["547bf635", "#547bf635", "547BF635", mine.id]) {
      expect((await get(ctx, ref)).result).toMatchObject({ ok: true, data: { ticket_id: mine.id } });
    }
  });

  it("asks for more characters when two of the tenant's tickets share the prefix", async () => {
    const twin = ticket("547bf635-0000-4000-8000-000000000000", "tenant_olivia");
    expect((await get(ctxWith([mine, twin]), "547bf635")).result).toMatchObject({ ok: false, code: "ticket_ref_ambiguous" });
    // More characters, with or without the dash, pick the right one.
    for (const longer of ["547bf635-4", "547bf6354", "547bf635-453a"]) {
      expect((await get(ctxWith([mine, twin]), longer)).result).toMatchObject({ ok: true, data: { ticket_id: mine.id } });
    }
    expect((await get(ctxWith([mine, twin]), "547bf635-0")).result).toMatchObject({ ok: true, data: { ticket_id: twin.id } });
  });

  it("never matches another tenant's ticket, and rejects too-short references", async () => {
    const theirs = ticket("547bf635-453a-4d69-ad12-efbd3662f1da", "tenant_james");
    expect((await get(ctxWith([theirs]), "547bf635")).result).toMatchObject({ ok: false, code: "ticket_not_found" });
    expect((await get(ctxWith([theirs]), theirs.id)).result).toMatchObject({ ok: false, code: "ticket_not_found" });
    expect((await get(ctxWith([mine]), "547b")).result).toMatchObject({ ok: false, code: "ticket_not_found" });
    // Fewer than 8 characters once dashes are ignored.
    expect((await get(ctxWith([mine]), "547b-f63")).result).toMatchObject({ ok: false, code: "ticket_not_found" });
  });
});
