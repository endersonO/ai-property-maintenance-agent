import type { Evaluator } from "@/runtime/evaluation";
import { claimsTicketCreated } from "@/workflows/maintenance/reply-heuristics";
import { ticketEffects } from "./effects";

// Monitor (heuristic): a maintenance reply that claims a ticket was logged must be backed by a
// confirmed ticket in the same run (created, escalated, or returned by a retry). Catches
// invented success, e.g. after a rejection or a failed write (A4 class). ticket-status is out
// of scope: "your ticket was created yesterday" is retrieved data, not a claim of action.

export const claimsMatchActions: Evaluator = {
  id: "claims_match_actions",
  version: 1,
  kind: "monitor",
  description: "A maintenance reply that claims a ticket was logged is backed by a confirmed ticket",
  appliesTo: (run) => run.workflowId === "maintenance" && claimsTicketCreated(run.output ?? ""),
  evaluate: (run) => {
    const [ticket] = ticketEffects(run);
    return ticket
      ? { verdict: "pass", evidence: `claim backed by ticket ${ticket.ticketId} (${ticket.origin})` }
      : { verdict: "fail", evidence: "reply claims a ticket was logged, but no create call succeeded in this run" };
  },
};
