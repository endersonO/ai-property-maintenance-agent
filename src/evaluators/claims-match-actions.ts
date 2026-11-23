import type { Evaluator } from "@/runtime/evaluation";
import { claimsTicketCreated, claimsTicketUpdated } from "@/workflows/maintenance/reply-heuristics";
import { ticketEffects } from "./effects";

// Monitor (heuristic): what a maintenance reply says it did matches what the run did.
//   - "I've created a ticket" needs a ticket from a create call: a new one, or the one a retry
//     of the same request returned. Details added to an existing ticket are not a new ticket.
//   - "I've updated / added this to your ticket" needs details actually added to a ticket.
// Catches invented success, e.g. after a rejection or a failed write (A4 class), and the
// follow-up that created a second ticket while saying it updated the first. ticket-status is
// out of scope: "your ticket was created yesterday" is retrieved data, not a claim of action.

export const claimsMatchActions: Evaluator = {
  id: "claims_match_actions",
  version: 2,
  kind: "monitor",
  description: "What a maintenance reply says it did to a ticket (created, updated) matches what the run did",
  appliesTo: (run) =>
    run.workflowId === "maintenance" && (claimsTicketCreated(run.output ?? "") || claimsTicketUpdated(run.output ?? "")),
  evaluate: (run) => {
    const reply = run.output ?? "";
    const effects = ticketEffects(run);
    const problems: string[] = [];
    const backed: string[] = [];
    if (claimsTicketCreated(reply)) {
      const created = effects.find((t) => t.via === "create");
      if (created) backed.push(`created: ticket ${created.ticketId} (${created.origin})`);
      else
        problems.push(
          effects.length > 0
            ? `reply says a ticket was created, but the details were added to existing ticket ${effects[0].ticketId}`
            : "reply claims a ticket was logged, but no create call succeeded in this run",
        );
    }
    if (claimsTicketUpdated(reply)) {
      const added = effects.find((t) => t.via === "add");
      if (added) backed.push(`updated: ticket ${added.ticketId} (${added.origin})`);
      else
        problems.push(
          effects.length > 0
            ? `reply says a ticket was updated, but the run created ticket ${effects[0].ticketId} instead`
            : "reply says a ticket was updated, but nothing was added to any ticket",
        );
    }
    return problems.length === 0
      ? { verdict: "pass", evidence: `claim backed — ${backed.join("; ")}` }
      : { verdict: "fail", evidence: problems.join("; ") };
  },
};
