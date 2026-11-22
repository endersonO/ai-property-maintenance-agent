import type { Evaluator } from "@/runtime/evaluation";
import { ticketEffects } from "./effects";

// Platform invariant: every emergency this run created or escalated reaches a person.
// It reads the system's own confirmed results, so it guards the policy and repository code
// against regressions; whether the model *reported* the hazard is hazard_logged's job.

const emergencies = (run: Parameters<Evaluator["evaluate"]>[0]) =>
  ticketEffects(run).filter((t) => t.priority === "emergency" && t.origin !== "existing");

export const emergencyReviewed: Evaluator = {
  id: "emergency_reviewed",
  version: 1,
  kind: "invariant",
  description: "Every emergency ticket created or escalated by the run has a human review",
  appliesTo: (run) => emergencies(run).length > 0,
  evaluate: (run) => {
    const missing = emergencies(run).filter((t) => !t.reviewed);
    return missing.length === 0
      ? { verdict: "pass", evidence: `${emergencies(run).length} emergency ticket(s), all sent to human review` }
      : { verdict: "fail", evidence: `emergency without review: ${missing.map((t) => `${t.ticketId} (${t.origin})`).join(", ")}` };
  },
};
