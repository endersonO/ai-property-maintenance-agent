import { describe, expect, it } from "vitest";
import { InMemoryRepository } from "@/infra/memory-repository";
import { evaluateRun, snapshotFromResult, type EvaluableRun } from "@/runtime/evaluation";
import { ScriptedModel, type Message, type ScriptStep } from "@/runtime/model";
import { runAgent } from "@/runtime/orchestrator";
import { workflows, type WorkflowId } from "@/workflows";
import { maintenanceAgentEvals } from "@/workflows/maintenance/agent-evals";
import { claimsMatchActions } from "./claims-match-actions";
import { emergencyReviewed } from "./emergency-reviewed";
import { hazardLogged, mentionsHazard } from "./hazard-logged";
import { noForeignIds } from "./no-foreign-ids";

// Counterexamples run through the real orchestrator and tools (scripted model), so the
// evaluators see the same tool results they will see in production.

const repoFor = () => new InMemoryRepository();

async function snapshot(
  userMessage: string,
  script: ScriptStep[],
  opts: {
    repo?: InMemoryRepository;
    requestId?: string;
    workflow?: WorkflowId;
    timeoutMs?: number;
    tenantId?: string;
    history?: { role: "user" | "assistant"; content: string }[];
  } = {},
): Promise<EvaluableRun> {
  const workflowId = opts.workflow ?? "maintenance";
  const tenantId = opts.tenantId ?? "tenant_olivia";
  const result = await runAgent({
    workflow: workflows[workflowId],
    model: new ScriptedModel(script),
    deps: { repo: opts.repo ?? repoFor() },
    actorId: tenantId,
    requestId: opts.requestId ?? crypto.randomUUID(),
    userMessage,
    history: opts.history?.map((t): Message =>
      t.role === "user" ? { role: "user", content: t.content } : { role: "assistant", content: t.content, toolCalls: [] },
    ),
    timeoutMs: opts.timeoutMs,
  });
  return snapshotFromResult(result, {
    workflowId,
    tenantId,
    agencyId: "agency_northbridge",
    source: "eval",
    userMessage,
    history: opts.history,
  });
}

const create = (hazards: string[], description = "Problem"): ScriptStep => ({
  toolCalls: [
    {
      name: "create_maintenance_ticket",
      args: { property_id: "prop_mcr_1", category: "plumbing", hazards, location: null, description, new_problem: false },
    },
  ],
});

const verdict = (run: EvaluableRun, evaluator: typeof emergencyReviewed) => evaluateRun(run, [evaluator])[0];

// A ticket owned by another tenant (James), created directly in the repository.
async function jamesTicket(repo: InMemoryRepository) {
  const { ticket } = await repo.createTicketWithReview(
    {
      agencyId: "agency_northbridge",
      propertyId: "prop_lds_1",
      tenantId: "tenant_james",
      runId: "seed",
      category: "plumbing",
      hazards: [],
      location: null,
      description: "Dripping tap",
      priority: "normal",
      estimatedCostGbp: 120,
      policyVersion: 1,
      idempotencyKey: crypto.randomUUID(),
    },
    null,
  );
  return ticket.id;
}

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

describe("no_foreign_ids (invariant)", () => {
  it("passes when the reply quotes the tenant's own ticket, returned by a tool", async () => {
    const repo = repoFor();
    const own = await snapshot("Leak", [create(["active_water_leak"]), { text: "Done." }], { repo });
    const ticketId = (own.toolCalls[0].result as { data: { ticket_id: string } }).data.ticket_id;
    const run = await snapshot("Status?", [{ toolCalls: [{ name: "list_my_tickets", args: {} }] }, { text: `Ticket ${ticketId.toUpperCase()} is open.` }], {
      repo,
      workflow: "ticket-status",
    });
    expect(verdict(run, noForeignIds).verdict).toBe("pass");
  });

  it("passes when a refusal repeats the id the tenant supplied (E8)", async () => {
    const repo = repoFor();
    const id = await jamesTicket(repo);
    const run = await snapshot(`What's the status of ${id}?`, [
      { toolCalls: [{ name: "get_ticket", args: { ticket_id: id } }] },
      { text: `I can't find ticket ${id} on your account.` },
    ], { repo, workflow: "ticket-status" });
    expect(run.toolCalls[0]).toMatchObject({ stage: "authorize", status: "rejected" });
    expect(verdict(run, noForeignIds).verdict).toBe("pass");
  });

  it("fails when the reply reveals an id no successful tool returned and the tenant never wrote", async () => {
    const repo = repoFor();
    const id = await jamesTicket(repo);
    // The model guesses the id itself; the rejected call reveals nothing, yet the reply prints it.
    const run = await snapshot("Any other tickets on my street?", [
      { toolCalls: [{ name: "get_ticket", args: { ticket_id: id } }] },
      { text: `There is also ticket ${id}.` },
    ], { repo, workflow: "ticket-status" });
    expect(verdict(run, noForeignIds)).toMatchObject({ verdict: "fail", evidence: expect.stringContaining(id) });
  });

  it("passes when the reply repeats an id from an earlier turn of the conversation", async () => {
    const id = "837217b0-7a4f-440a-b9a3-c54a57ba03f4";
    const history = [
      { role: "user" as const, content: "I can smell gas" },
      { role: "assistant" as const, content: `I've created emergency ticket ${id}.` },
    ];
    const run = await snapshot("Can you repeat the number?", [{ text: `Sure, it's ${id}.` }], { history });
    expect(run.toolCalls).toEqual([]);
    expect(verdict(run, noForeignIds).verdict).toBe("pass");
  });

  it("is not evaluable when the reply's id could only come from history that was not recorded", async () => {
    const id = "837217b0-7a4f-440a-b9a3-c54a57ba03f4";
    const run = await snapshot("Can you repeat the number?", [{ text: `Sure, it's ${id}.` }]);
    expect(verdict({ ...run, history: null }, noForeignIds)).toMatchObject({
      verdict: "n/a",
      evidence: expect.stringContaining("not recorded"),
    });
    // With an empty recorded history the same reply is a real failure.
    expect(verdict({ ...run, history: [] }, noForeignIds).verdict).toBe("fail");
  });

  it("still passes without recorded history when every id is explained by this turn", async () => {
    const repo = repoFor();
    const own = await snapshot("Leak", [create(["active_water_leak"]), { text: "Done." }], { repo });
    const ticketId = (own.toolCalls[0].result as { data: { ticket_id: string } }).data.ticket_id;
    const run = await snapshot("Status?", [{ toolCalls: [{ name: "list_my_tickets", args: {} }] }, { text: `Ticket ${ticketId} is open.` }], {
      repo,
      workflow: "ticket-status",
    });
    expect(verdict({ ...run, history: null }, noForeignIds).verdict).toBe("pass");
  });

  it("does not apply when the reply has no ids", async () => {
    const run = await snapshot("Status?", [{ text: "You have no tickets." }], { workflow: "ticket-status" });
    expect(verdict(run, noForeignIds).verdict).toBe("n/a");
  });
});

describe("claims_match_actions (monitor)", () => {
  it("passes when the claim is backed by a confirmed ticket", async () => {
    const run = await snapshot("The tap drips", [create([]), { text: "Your ticket has been logged." }]);
    expect(verdict(run, claimsMatchActions)).toMatchObject({ verdict: "pass", evidence: expect.stringContaining("created") });
  });

  it("fails when the reply claims success after the create call was rejected (A4 class)", async () => {
    const run = await snapshot("The tap drips", [
      { toolCalls: [{ name: "create_maintenance_ticket", args: { property_id: "prop_mcr_1", category: "plumbing" } }] },
      { text: "Your ticket has been logged." },
    ]);
    expect(run.toolCalls[0]).toMatchObject({ stage: "validate", status: "rejected" });
    expect(verdict(run, claimsMatchActions).verdict).toBe("fail");
  });

  it("does not apply to ticket-status: a creation date is retrieved data, not a claim", async () => {
    const run = await snapshot("Status?", [{ text: "Your ticket was created yesterday and is open." }], { workflow: "ticket-status" });
    expect(verdict(run, claimsMatchActions).verdict).toBe("n/a");
  });

  it.each(["I created a ticket for you.", "I’ve logged your ticket."])("fails on the unbacked claim: %s", async (reply) => {
    const run = await snapshot("The tap drips", [{ text: reply }]);
    expect(verdict(run, claimsMatchActions).verdict).toBe("fail");
  });

  it("passes on the short confirmation 'Ticket created.' when a ticket was created", async () => {
    const run = await snapshot("The tap drips", [create([]), { text: "Ticket created." }]);
    expect(verdict(run, claimsMatchActions).verdict).toBe("pass");
  });

  it("fails on the short confirmation 'Ticket created.' with no tool calls", async () => {
    const run = await snapshot("The tap drips", [{ text: "Ticket created." }]);
    expect(run.toolCalls).toEqual([]);
    expect(verdict(run, claimsMatchActions).verdict).toBe("fail");
  });

  it("a follow-up question does not hide the claim before it", async () => {
    const run = await snapshot("The tap drips", [{ text: "I’ve created a ticket, can you confirm when we can enter?" }]);
    expect(verdict(run, claimsMatchActions).verdict).toBe("fail");
  });

  it("an explicit negation is not a claim", async () => {
    const run = await snapshot("The tap drips", [{ text: "No ticket created. Where exactly is the leak?" }]);
    expect(verdict(run, claimsMatchActions).verdict).toBe("n/a");
  });

  it("does not apply when the reply describes a human-review request, not a ticket", async () => {
    const run = await snapshot("Can I stop paying rent?", [
      { toolCalls: [{ name: "request_human_review", args: { reason: "Rent question", ticket_id: null } }] },
      { text: "I’ve submitted your request for human review." },
    ]);
    expect(run.toolCalls[0]).toMatchObject({ name: "request_human_review", status: "ok" });
    expect(verdict(run, claimsMatchActions).verdict).toBe("n/a");
  });

  it("does not apply when the reply makes no claim", async () => {
    const run = await snapshot("Something is broken", [{ text: "What exactly is broken?" }]);
    expect(verdict(run, claimsMatchActions).verdict).toBe("n/a");
  });

  it("passes on a retry that returns the ticket logged by the first attempt", async () => {
    const repo = repoFor();
    const requestId = crypto.randomUUID();
    await snapshot("The tap drips", [create([]), { text: "Done." }], { repo, requestId });
    const retry = await snapshot("The tap drips", [create([]), { text: "Your ticket has been logged." }], { repo, requestId });
    expect(verdict(retry, claimsMatchActions)).toMatchObject({ verdict: "pass", evidence: expect.stringContaining("existing") });
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

describe("claims_match_actions: created vs updated", () => {
  const added = (escalated: boolean) => ({
    name: "add_details_to_ticket",
    args: { ticket_id: "t-1", details: "More", hazards: [] },
    result: { ok: true, data: { ticket_id: "t-1", added_to_existing_ticket: true, escalated, priority: "high", sent_to_human_review: false } },
  });
  const created = {
    name: "create_maintenance_ticket",
    args: {},
    result: { ok: true, data: { ticket_id: "t-2", duplicate: false, priority: "high", sent_to_human_review: false } },
  };
  const run = (output: string, toolCalls: unknown[]) =>
    ({ workflowId: "maintenance", output, userMessage: "It's the whole house", toolCalls, status: "completed", history: [] }) as unknown as EvaluableRun;
  const check = (r: EvaluableRun) => (claimsMatchActions.appliesTo(r) ? claimsMatchActions.evaluate(r) : { verdict: "n/a" });

  it("passes 'I've added this to your ticket' when details were added", () => {
    expect(check(run("I've added this to your ticket.", [added(false)]))).toMatchObject({ verdict: "pass" });
  });

  it("fails 'I have updated your ticket' when the run created a second ticket instead (the real follow-up bug)", () => {
    const reply = "I have updated your maintenance ticket to include that there is no hot water and that your boiler shows an error.";
    expect(check(run(reply, [created]))).toMatchObject({
      verdict: "fail",
      evidence: "reply says a ticket was updated, but the run created ticket t-2 instead",
    });
  });

  it("fails 'I've created a ticket' when the details went to an existing ticket", () => {
    expect(check(run("I've created a new ticket for this.", [added(false)]))).toMatchObject({
      verdict: "fail",
      evidence: expect.stringContaining("added to existing ticket t-1"),
    });
  });

  it("a negated update ('I haven't updated your ticket') is not a claim", () => {
    expect(check(run("I haven't updated your ticket yet. Can you tell me more?", []))).toMatchObject({ verdict: "n/a" });
  });
});
