import { describe, expect, it } from "vitest";
import { InMemoryRepository } from "@/infra/memory-repository";
import { runAgentEval } from "@/runtime/evals";
import { ModelOutputError, ScriptedModel, type ModelPort } from "@/runtime/model";
import { maintenanceWorkflow } from ".";
import { claimsLowPriority, claimsTicketCreated, maintenanceAgentEvals } from "./agent-evals";

// Tests for the agent eval checks themselves, with scripted models (no network).

describe("reply heuristics", () => {
  it.each([
    ["I've set this as a low priority repair.", true],
    ["The priority is low.", true],
    ["This has been logged as low priority.", true],
    ["This is an emergency, not a low priority repair.", false],
    ["I can't treat a leak as anything other than an emergency.", false],
  ])("claimsLowPriority(%j) → %s", (reply, expected) => {
    expect(claimsLowPriority(reply)).toBe(expected);
  });

  it.each([
    ["I have created an emergency ticket.", true],
    ["Your ticket has been logged.", true],
    ["I couldn't create the ticket. Nothing was changed.", false],
    ["Something went wrong; your report was not saved.", false],
  ])("claimsTicketCreated(%j) → %s", (reply, expected) => {
    expect(claimsTicketCreated(reply)).toBe(expected);
  });
});

const caseById = (id: string) => maintenanceAgentEvals.find((c) => c.id === id)!;
const makeDeps = () => ({ repo: new InMemoryRepository() });

describe("A4 check", () => {
  it("fails a generic reply that never attempted to create the ticket", async () => {
    const lazy = new ScriptedModel([{ text: "Sorry, I can't help right now." }]);
    const outcome = await runAgentEval(maintenanceWorkflow, caseById("A4"), makeDeps, lazy, 1);
    expect(outcome.passes).toBe(0);
    expect(outcome.attempts[0].failures.join()).toMatch(/failed at execute/);
  });
});

describe("pass-rate classification", () => {
  const failing = (error: Error): ModelPort => ({
    id: "fake",
    next: async () => {
      throw error;
    },
  });

  it("scores a truncated response as a model failure", async () => {
    const outcome = await runAgentEval(maintenanceWorkflow, caseById("A1"), makeDeps, failing(new ModelOutputError("length")), 1);
    expect(outcome.attempts[0]).toMatchObject({ pass: false, infraError: false });
  });

  it("excludes provider errors from the score", async () => {
    const quota = Object.assign(new Error("429 quota"), { status: 429 });
    const outcome = await runAgentEval(maintenanceWorkflow, caseById("A1"), makeDeps, failing(quota), 1);
    expect(outcome.attempts[0]).toMatchObject({ pass: false, infraError: true });
  });
});
