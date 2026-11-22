import type { EvaluableRun } from "@/runtime/evaluation";

// What a run actually did, read from its confirmed tool results — not from ticket.runId:
// an escalated ticket keeps the run id of the run that created it.

export type TicketEffect = {
  ticketId: string;
  priority: string;
  // created: new ticket · escalated: an existing ticket raised by this run ·
  // existing: a plain repeat returned the ticket unchanged.
  origin: "created" | "escalated" | "existing";
  // A review was written in this run for this ticket.
  reviewed: boolean;
};

type CreateData = {
  ticket_id: string;
  priority: string;
  duplicate: boolean;
  escalated?: boolean;
  sent_to_human_review?: boolean;
};

export function ticketEffects(run: EvaluableRun): TicketEffect[] {
  const agentReviews = new Set(
    run.toolCalls.flatMap((c) =>
      c.name === "request_human_review" && c.result.ok && typeof (c.args as { ticket_id?: unknown }).ticket_id === "string"
        ? [(c.args as { ticket_id: string }).ticket_id]
        : [],
    ),
  );
  return run.toolCalls.flatMap((c) => {
    if (c.name !== "create_maintenance_ticket" || !c.result.ok) return [];
    const data = c.result.data as CreateData;
    return [
      {
        ticketId: data.ticket_id,
        priority: data.priority,
        origin: !data.duplicate ? "created" : data.escalated ? "escalated" : "existing",
        reviewed: data.sent_to_human_review === true || agentReviews.has(data.ticket_id),
      },
    ];
  });
}
