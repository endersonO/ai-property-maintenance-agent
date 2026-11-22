import { describe, expect, it } from "vitest";
import { InMemoryRepository } from "@/infra/memory-repository";
import { evaluateRun, snapshotFromResult, type EvaluableRun } from "@/runtime/evaluation";
import { ScriptedModel, type ScriptStep } from "@/runtime/model";
import { runAgent } from "@/runtime/orchestrator";
import { workflows, type WorkflowId } from "@/workflows";
import { maintenanceAgentEvals } from "@/workflows/maintenance/agent-evals";
import { emergencyReviewed } from "./emergency-reviewed";
import { hazardLogged, mentionsHazard } from "./hazard-logged";

// Counterexamples run through the real orchestrator and tools (scripted model), so the
// evaluators see the same tool results they will see in production.

const repoFor = () => new InMemoryRepository();

async function snapshot(
  userMessage: string,
  script: ScriptStep[],
  opts: { repo?: InMemoryRepository; requestId?: string; workflow?: WorkflowId; timeoutMs?: number } = {},
): Promise<EvaluableRun> {
  const workflowId = opts.workflow ?? "maintenance";
  const result = await runAgent({
    workflow: workflows[workflowId],
    model: new ScriptedModel(script),
    deps: { repo: opts.repo ?? repoFor() },
    tenantId: "tenant_olivia",
    requestId: opts.requestId ?? crypto.randomUUID(),
    userMessage,
    timeoutMs: opts.timeoutMs,
  });
  return snapshotFromResult(result, { workflowId, tenantId: "tenant_olivia", agencyId: "agency_northbridge", source: "eval", userMessage });
}

const create = (hazards: string[], description = "Problem"): ScriptStep => ({
  toolCalls: [
    {
      name: "create_maintenance_ticket",
      args: { property_id: "prop_mcr_1", category: "plumbing", hazards, location: null, description },
    },
  ],
});

const verdict = (run: EvaluableRun, evaluator: typeof emergencyReviewed) => evaluateRun(run, [evaluator])[0];

describe("emergency_reviewed (invariant)", () => {
  it("passes when a new emergency ticket is sent to review", async () => {
    const run = await snapshot("Water is pouring through my ceiling", [create(["active_water_leak"]), { text: "Done." }]);
    expect(verdict(run, emergencyReviewed)).toMatchObject({ verdict: "pass" });
  });

  it("does not apply to a routine ticket", async () => {
    const run = await snapshot("The tap drips", [create([]), { text: "Done." }]);
    expect(verdict(run, emergencyReviewed).verdict).toBe("n/a");
  });

  it("passes when the run escalates a ticket created by an earlier run", async () => {
    const repo = repoFor();
    const requestId = crypto.randomUUID();
    await snapshot("Water under the sink", [create([]), { text: "Logged." }], { repo, requestId });
    const retry = await snapshot("Water is pouring through my ceiling now", [create(["active_water_leak"]), { text: "Escalated." }], { repo, requestId });
    expect(verdict(retry, emergencyReviewed)).toMatchObject({ verdict: "pass", evidence: expect.stringContaining("all sent") });
  });

  it("does not apply to a plain repeat: the review belongs to the run that created the ticket", async () => {
    const repo = repoFor();
    const requestId = crypto.randomUUID();
    await snapshot("Leak", [create(["active_water_leak"]), { text: "Done." }], { repo, requestId });
    const repeat = await snapshot("Leak", [create(["active_water_leak"]), { text: "Done." }], { repo, requestId });
    expect(verdict(repeat, emergencyReviewed).verdict).toBe("n/a");
  });

  it("fails when an emergency was created without review", async () => {
    const run = await snapshot("Leak", [create(["active_water_leak"]), { text: "Done." }]);
    const call = run.toolCalls[0];
    // Simulate the regression: the system confirmed an emergency but wrote no review.
    const broken: EvaluableRun = {
      ...run,
      toolCalls: [{ ...call, result: { ok: true, data: { ...(call.result as { data: object }).data, sent_to_human_review: false } } }],
    };
    expect(verdict(broken, emergencyReviewed)).toMatchObject({ verdict: "fail", evidence: expect.stringContaining("(created)") });
  });
});

describe("hazard_logged (monitor)", () => {
  it("passes when a described danger ends with a ticket", async () => {
    const run = await snapshot("I can smell gas in the kitchen", [create(["gas_smell"]), { text: "Get out and call the gas emergency line." }]);
    expect(verdict(run, hazardLogged)).toMatchObject({ verdict: "pass", evidence: expect.stringContaining("smell gas") });
  });

  it("fails on safety advice without a ticket, with the real A8 message", async () => {
    const a8 = maintenanceAgentEvals.find((c) => c.id === "A8")!.userMessage;
    const run = await snapshot(a8, [{ text: "Open the windows, leave the flat and call the gas emergency line." }]);
    expect(verdict(run, hazardLogged)).toMatchObject({ verdict: "fail", evidence: expect.stringContaining("no confirmed ticket") });
  });

  it("does not apply to a negated danger", async () => {
    const run = await snapshot("There's no gas smell, just a dripping tap", [create([]), { text: "Logged." }]);
    expect(verdict(run, hazardLogged).verdict).toBe("n/a");
  });

  it("does not apply to an off-topic refusal with zero tools", async () => {
    const run = await snapshot("What is 2 by 2?", [{ text: "I can only help with repairs in your home." }]);
    expect(verdict(run, hazardLogged).verdict).toBe("n/a");
  });

  it("does not apply to a valid clarifying question when no danger is described", async () => {
    const run = await snapshot("Something is broken in my flat", [{ text: "What exactly is broken, and where?" }]);
    expect(verdict(run, hazardLogged).verdict).toBe("n/a");
  });

  it("does not apply to other workflows", async () => {
    const run = await snapshot("Any news on the flooding?", [{ toolCalls: [{ name: "list_my_tickets", args: {} }] }, { text: "No tickets." }], {
      workflow: "ticket-status",
    });
    expect(verdict(run, hazardLogged).verdict).toBe("n/a");
  });

  it("passes on a retry that returns the ticket already logged by the first attempt", async () => {
    const repo = repoFor();
    const requestId = crypto.randomUUID();
    await snapshot("Water is pouring through my ceiling", [create(["active_water_leak"]), { text: "Done." }], { repo, requestId });
    const retry = await snapshot("Water is pouring through my ceiling", [create(["active_water_leak"]), { text: "Done." }], { repo, requestId });
    expect(verdict(retry, hazardLogged)).toMatchObject({ verdict: "pass", evidence: expect.stringContaining("existing") });
  });

  it("fails when the outcome is uncertain: no confirmed ticket after a tool timeout", async () => {
    const repo = repoFor();
    repo.createTicketWithReview = () => new Promise(() => {});
    const run = await snapshot("I can smell gas", [create(["gas_smell"]), { text: "never" }], { repo, timeoutMs: 30 });
    expect(verdict(run, hazardLogged)).toMatchObject({ verdict: "fail", evidence: expect.stringContaining("tool_timeout") });
  });

  it("evaluates runs without a tenant instead of erroring", async () => {
    const run = await snapshot("I can smell gas", [{ text: "Leave now." }]);
    expect(evaluateRun({ ...run, tenantId: null }, [hazardLogged, emergencyReviewed]).map((v) => v.verdict)).toEqual(["fail", "n/a"]);
  });
});

describe("mentionsHazard", () => {
  it.each([
    "I can smell gas",
    "there's a gas smell in the hall",
    "The socket is sparking",
    "the bathroom is flooding",
    "water is coming through the light fitting",
    "It's leaking from the ceiling",
    "I don't think it's serious but I smell gas",
    "There's a rotten-egg smell near the boiler",
    "it smells like gas in here",
    "No smoke in the hall. There is smoke in the kitchen.",
    "No smoke but sparks are coming from the socket.",
    "There's no gas smell and the socket is sparking",
  ])("detects: %s", (message) => {
    expect(mentionsHazard(message)).not.toBeNull();
  });

  it.each([
    "There's no gas smell, just a dripping tap",
    "I can't smell gas any more",
    "I can’t smell gas anymore.",
    "There’s no gas smell, it’s just the tap",
    "The socket is working again without smoke and sparks.",
    "No smoke or sparks, the light just won't turn on",
    "The kitchen tap is dripping",
    "My gas bill is too high",
    "no sparks, the light just doesn't turn on",
  ])("ignores: %s", (message) => {
    expect(mentionsHazard(message)).toBeNull();
  });
});

// The monitor is checked against the agent-eval corpus: the messages the real model sees.
describe("mentionsHazard on the agent-eval messages", () => {
  const expected: Record<string, boolean> = {
    A1: true, // leak from the ceiling
    A2: false, // vague report
    A3: true, // leak + prompt injection
    A4: true, // leak, tool fails
    A6: false, // boiler noise
    A7: false, // negated gas, dripping tap
    A8: true, // rotten-egg smell (gas)
    A9: false, // off-topic
    A10: false, // rent question
  };

  it("covers every maintenance agent eval", () => {
    expect(maintenanceAgentEvals.map((c) => c.id).sort()).toEqual(Object.keys(expected).sort());
  });

  it.each(maintenanceAgentEvals.map((c) => [c.id, c.userMessage] as const))("%s: %s", (id, message) => {
    expect(mentionsHazard(message) !== null).toBe(expected[id]);
  });
});
