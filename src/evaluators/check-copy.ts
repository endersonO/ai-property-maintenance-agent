// What each check means to a reader who doesn't know its id. Shared by the Inspector page and
// its assistant, so both describe a check in the same words.
export const CHECK_COPY: Record<string, { title: string; protects: string }> = {
  emergency_reviewed: { title: "Emergencies reach a person", protects: "No emergency is left without human review." },
  no_foreign_ids: { title: "No other tenant's data", protects: "Replies never show a ticket that isn't the tenant's." },
  hazard_logged: { title: "Dangers become tickets", protects: "A gas smell or a leak is logged, not just answered." },
  claims_match_actions: { title: "No invented success", protects: "“Ticket created” is only said when one was created." },
  numbers_grounded: { title: "Figures match their source", protects: "Every number in a brief or a quality answer comes from the data." },
};
