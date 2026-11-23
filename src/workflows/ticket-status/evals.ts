import type { NewTicket } from "@/domain/repository";
import { expectations, type AgentEvalCase, type EvalCase } from "@/runtime/evals";
import type { RunEvent, RunResult } from "@/runtime/orchestrator";
import type { AppDeps } from "../deps";

// Evals for the ticket-status workflow. E8 (executor) and A5 (agent) in plan.md.

const leakTicket = (tenantId: string, propertyId: string, key: string): NewTicket => ({
  agencyId: "agency_northbridge",
  propertyId,
  tenantId,
  runId: "seed-run",
  category: "plumbing",
  hazards: ["active_water_leak"],
  location: "kitchen ceiling",
  description: "Water leaking from the ceiling",
  priority: "emergency",
  estimatedCostGbp: 180,
  policyVersion: 1,
  idempotencyKey: key,
});

// True when the reply describes the ticket as an emergency (or open) without negating it.
export function statesOpenEmergency(reply: string): boolean {
  const negated = /\b(not|isn't|is not|no longer)\s+(an?\s+)?(emergency|open)\b/i.test(reply);
  return !negated && /\b(emergency|open)\b/i.test(reply);
}

const toolEvents = (result: RunResult) =>
  result.events.filter((e): e is Extract<RunEvent, { type: "tool_call" }> => e.type === "tool_call");

export const ticketStatusEvals: EvalCase<AppDeps>[] = [
  {
    id: "E8",
    title: "Model asks for another tenant's ticket: rejected at authorize, nothing revealed",
    actorId: "tenant_olivia",
    setup: async (deps) => {
      const { ticket } = await deps.repo.createTicketWithReview(leakTicket("tenant_james", "prop_lds_1", "james-1"), null);
      return { jamesTicketId: ticket.id };
    },
    runs: ({ jamesTicketId }) => [
      {
        requestId: "e8",
        userMessage: `What's the status of ticket ${jamesTicketId}?`,
        script: [
          { toolCalls: [{ name: "get_ticket", args: { ticket_id: jamesTicketId } }] },
          { toolCalls: [{ name: "list_my_tickets", args: {} }] },
          { text: "I can't find that ticket on your account." },
        ],
      },
    ],
    check: async ({ results }) => {
      const e = expectations();
      const [get, list] = toolEvents(results[0]);
      e.equal("get_ticket outcome", [get?.stage, get?.status, get?.result.ok === false && get.result.code], [
        "authorize",
        "rejected",
        "ticket_not_found",
      ]);
      e.equal("own tickets listed", list?.result, { ok: true, data: [] });
      return e.failures;
    },
  },
  {
    id: "E15",
    title: "Tenant quotes the short number shown in the portal: resolved among their own tickets",
    actorId: "tenant_olivia",
    setup: async (deps) => {
      const { ticket } = await deps.repo.createTicketWithReview(leakTicket("tenant_olivia", "prop_mcr_1", "olivia-1"), null);
      return { short: ticket.id.slice(0, 8), full: ticket.id };
    },
    runs: ({ short }) => [
      {
        requestId: "e15",
        userMessage: `What happened with this ticket ${short}?`,
        script: [
          { toolCalls: [{ name: "get_ticket", args: { ticket_id: short } }] },
          { text: "It's an open emergency, and a person at the agency is reviewing it." },
        ],
      },
    ],
    check: async ({ deps, results }) => {
      const e = expectations();
      const [get] = toolEvents(results[0]);
      const [own] = await deps.repo.listTickets("tenant_olivia");
      e.equal("get_ticket ok", [get?.stage, get?.status], ["execute", "ok"]);
      e.equal("resolved ticket", get?.result.ok && (get.result.data as { ticket_id: string }).ticket_id, own.id);
      return e.failures;
    },
  },
  {
    id: "E16",
    title: "A short number of another tenant's ticket is 'not found', exactly like a missing one",
    actorId: "tenant_olivia",
    setup: async (deps) => {
      const { ticket } = await deps.repo.createTicketWithReview(leakTicket("tenant_james", "prop_lds_1", "james-1"), null);
      return { jamesShort: ticket.id.slice(0, 8) };
    },
    runs: ({ jamesShort }) => [
      {
        requestId: "e16",
        userMessage: `What's happening with ${jamesShort}?`,
        script: [
          { toolCalls: [{ name: "get_ticket", args: { ticket_id: jamesShort } }] },
          { toolCalls: [{ name: "get_ticket", args: { ticket_id: "00000000" } }] },
          { text: "I can't find that ticket on your account." },
        ],
      },
    ],
    check: async ({ results }) => {
      const e = expectations();
      const [james, missing] = toolEvents(results[0]);
      // Same stage, code and message: nothing tells the tenant the first one exists.
      e.equal("someone else's", james?.result, missing?.result);
      e.equal("code", james?.result.ok === false && james.result.code, "ticket_not_found");
      return e.failures;
    },
  },
];

export const ticketStatusAgentEvals: AgentEvalCase<AppDeps>[] = [
  {
    id: "A5",
    title: "'What's happening with my leak?' → looks the ticket up and answers from real data",
    actorId: "tenant_olivia",
    userMessage: "What's happening with my leak?",
    setup: async (deps) => {
      await deps.repo.createTicketWithReview(leakTicket("tenant_olivia", "prop_mcr_1", "olivia-1"), null);
    },
    check: async ({ result }) => {
      const e = expectations();
      const listed = toolEvents(result).find((t) => t.toolName === "list_my_tickets");
      e.equal("list_my_tickets succeeded", listed?.status, "ok");
      e.equal("reply states the open emergency", statesOpenEmergency(result.output ?? ""), true);
      return e.failures;
    },
  },
];
