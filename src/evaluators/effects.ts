import type { EvaluableRun } from "@/runtime/evaluation";

// What a run actually did, read from its confirmed tool results — not from ticket.runId:
// an escalated ticket keeps the run id of the run that created it.

export type TicketEffect = {
  ticketId: string;
  priority: string;
  // created: new ticket · escalated: an existing ticket raised by this run ·
  // existing: a plain repeat returned the ticket unchanged ·
  // updated: details added to an open ticket, priority unchanged.
  origin: "created" | "escalated" | "existing" | "updated";
  // How: a create call (new ticket, or a retry of the same request), or details added to an
  // open ticket (add_details_to_ticket, or a create the duplicate guard redirected).
  via: "create" | "add";
  // A review was written in this run for this ticket.
  reviewed: boolean;
};

type CreateData = {
  ticket_id: string;
  priority: string;
  duplicate: boolean;
  escalated?: boolean;
  sent_to_human_review?: boolean;
  added_to_existing_ticket?: boolean;
};

const ADDS = new Set(["create_maintenance_ticket", "add_details_to_ticket"]);

export function ticketEffects(run: EvaluableRun): TicketEffect[] {
  const agentReviews = new Set(
    run.toolCalls.flatMap((c) =>
      c.name === "request_human_review" && c.result.ok && typeof (c.args as { ticket_id?: unknown }).ticket_id === "string"
        ? [(c.args as { ticket_id: string }).ticket_id]
        : [],
    ),
  );
  return run.toolCalls.flatMap((c) => {
    if (!ADDS.has(c.name) || !c.result.ok) return [];
    const data = c.result.data as CreateData;
    const added = data.added_to_existing_ticket === true;
    return [
      {
        ticketId: data.ticket_id,
        priority: data.priority,
        via: added ? ("add" as const) : ("create" as const),
        origin: added
          ? data.escalated
            ? "escalated"
            : "updated"
          : !data.duplicate
            ? "created"
            : data.escalated
              ? "escalated"
              : "existing",
        reviewed: data.sent_to_human_review === true || agentReviews.has(data.ticket_id),
      },
    ];
  });
}
