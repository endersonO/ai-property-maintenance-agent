import { InMemoryRepository } from "@/infra/memory-repository";
import { expectations, type EvalCase } from "@/runtime/evals";
import type { RunEvent, RunResult } from "@/runtime/orchestrator";
import type { AppDeps } from "../deps";

// Executor evals for the maintenance workflow. IDs match plan.md (E8 belongs to ticket-status).

export const makeEvalDeps = (): AppDeps => ({ repo: new InMemoryRepository() });

const repoOf = (deps: AppDeps) => deps.repo as InMemoryRepository;

const getContext = { toolCalls: [{ name: "get_property_context", args: {} }] };
const create = (args: Record<string, unknown>) => ({
  toolCalls: [{ name: "create_maintenance_ticket", args }],
});

const dishwasher = (propertyId: string) => ({
  property_id: propertyId,
  category: "appliance",
  hazards: [],
  location: "kitchen",
  description: "My dishwasher stopped working",
  new_problem: false,
});

const leak = {
  property_id: "prop_mcr_1",
  category: "plumbing",
  hazards: ["active_water_leak"],
  location: "kitchen ceiling",
  description: "Water is leaking from my ceiling",
  new_problem: false,
};

const toolEvents = (result: RunResult) =>
  result.events.filter((e): e is Extract<RunEvent, { type: "tool_call" }> => e.type === "tool_call");

const createEvents = (result: RunResult) =>
  toolEvents(result).filter((e) => e.toolName === "create_maintenance_ticket");

export const maintenanceEvals: EvalCase<AppDeps>[] = [
  {
    id: "E1",
    title: "Routine fault at Northbridge: normal priority, no review",
    actorId: "tenant_olivia",
    runs: [
      {
        requestId: "e1",
        userMessage: "My dishwasher stopped working",
        script: [getContext, create(dishwasher("prop_mcr_1")), { text: "Ticket created." }],
      },
    ],
    check: async ({ deps, results }) => {
      const e = expectations();
      const tickets = await deps.repo.listTickets("tenant_olivia");
      e.equal("run status", results[0].status, "completed");
      e.equal("tickets", tickets.map((t) => [t.priority, t.estimatedCostGbp]), [["normal", 120]]);
      e.equal("reviews", (await deps.repo.listReviews("tenant_olivia")).length, 0);
      return e.failures;
    },
  },
  {
    id: "E2",
    title: "Ceiling leak: emergency, review forced by policy and linked to the ticket",
    actorId: "tenant_olivia",
    runs: [
      {
        requestId: "e2",
        userMessage: "Water is leaking from my ceiling. Please help!",
        script: [getContext, create(leak), { text: "Emergency ticket created and sent for review." }],
      },
    ],
    check: async ({ deps, results }) => {
      const e = expectations();
      const tickets = await deps.repo.listTickets("tenant_olivia");
      const reviews = await deps.repo.listReviews("tenant_olivia");
      e.equal("ticket priorities", tickets.map((t) => t.priority), ["emergency"]);
      e.equal("ticket run", tickets[0]?.runId, results[0].runId);
      e.equal("reviews", reviews.map((r) => [r.source, r.ticketId]), [["policy", tickets[0]?.id]]);
      return e.failures;
    },
  },
  {
    id: "E3",
    title: "Same routine fault at Harbour Lane: routed to human review",
    actorId: "tenant_priya",
    runs: [
      {
        requestId: "e3",
        userMessage: "My dishwasher stopped working",
        script: [getContext, create(dishwasher("prop_bri_1")), { text: "Ticket created." }],
      },
    ],
    check: async ({ deps }) => {
      const e = expectations();
      const tickets = await deps.repo.listTickets("tenant_priya");
      const reviews = await deps.repo.listReviews("tenant_priya");
      e.equal("ticket priorities", tickets.map((t) => t.priority), ["normal"]);
      e.equal("review sources", reviews.map((r) => r.source), ["policy"]);
      return e.failures;
    },
  },
  {
    id: "E4",
    title: "Model targets another tenant's property: rejected at authorize, nothing written",
    actorId: "tenant_olivia",
    runs: [
      {
        requestId: "e4",
        userMessage: "Report a leak at 27 Kirkgate Row",
        script: [getContext, create({ ...leak, property_id: "prop_lds_1" }), { text: "I can't do that." }],
      },
    ],
    check: async ({ deps, results }) => {
      const e = expectations();
      e.equal("create outcome", createEvents(results[0]).map((c) => [c.stage, c.status]), [["authorize", "rejected"]]);
      e.equal("olivia tickets", (await deps.repo.listTickets("tenant_olivia")).length, 0);
      e.equal("james tickets", (await deps.repo.listTickets("tenant_james")).length, 0);
      return e.failures;
    },
  },
  {
    id: "E5",
    title: "Model repeats the create call in one request: one ticket, one review",
    actorId: "tenant_olivia",
    runs: [
      {
        requestId: "e5",
        userMessage: "Water is leaking from my ceiling",
        script: [getContext, create(leak), create(leak), { text: "Ticket created." }],
      },
    ],
    check: async ({ deps, results }) => {
      const e = expectations();
      const duplicates = createEvents(results[0]).map((c) => c.result.ok && (c.result.data as { duplicate: boolean }).duplicate);
      e.equal("duplicate flags", duplicates, [false, true]);
      e.equal("tickets", (await deps.repo.listTickets("tenant_olivia")).length, 1);
      e.equal("reviews", (await deps.repo.listReviews("tenant_olivia")).length, 1);
      return e.failures;
    },
  },
  {
    id: "E6",
    title: "Invalid or invented arguments: rejected at validate, nothing written",
    actorId: "tenant_olivia",
    runs: [
      {
        requestId: "e6",
        userMessage: "Water is leaking from my ceiling",
        script: [
          getContext,
          create({ ...leak, hazards: ["fire"] }),
          create({ ...leak, description: "" }),
          create({ ...leak, priority: "low" }),
          { text: "Something went wrong." },
        ],
      },
    ],
    check: async ({ deps, results }) => {
      const e = expectations();
      e.equal(
        "create outcomes",
        createEvents(results[0]).map((c) => [c.stage, c.status]),
        [["validate", "rejected"], ["validate", "rejected"], ["validate", "rejected"]],
      );
      e.equal("tickets", (await deps.repo.listTickets("tenant_olivia")).length, 0);
      return e.failures;
    },
  },
  {
    id: "E7",
    title: "Review insert fails: no ticket persisted, model told nothing changed",
    actorId: "tenant_olivia",
    setup: (deps) => repoOf(deps).injectFault("review_insert"),
    runs: [
      {
        requestId: "e7",
        userMessage: "Water is leaking from my ceiling",
        script: [getContext, create(leak), { text: "Sorry, I couldn't create the ticket." }],
      },
    ],
    check: async ({ deps, results }) => {
      const e = expectations();
      const [event] = createEvents(results[0]);
      e.equal("create outcome", [event?.stage, event?.status], ["execute", "error"]);
      e.equal("model saw", event?.result, {
        ok: false,
        stage: "execute",
        code: "internal_error",
        message: "The create_maintenance_ticket tool failed. Nothing was changed.",
      });
      e.equal("tickets", (await deps.repo.listTickets("tenant_olivia")).length, 0);
      return e.failures;
    },
  },
  {
    id: "E9",
    title: "Two different problems, same category, same day (new_problem: true): two tickets, second an emergency",
    actorId: "tenant_olivia",
    runs: [
      {
        requestId: "e9-morning",
        userMessage: "The bathroom tap is dripping",
        script: [
          getContext,
          create({ ...leak, hazards: [], location: "bathroom", description: "Dripping tap" }),
          { text: "Ticket created." },
        ],
      },
      {
        requestId: "e9-afternoon",
        userMessage: "Now water is leaking from my ceiling!",
        script: [getContext, create({ ...leak, new_problem: true }), { text: "Emergency ticket created." }],
      },
    ],
    check: async ({ deps }) => {
      const e = expectations();
      const priorities = (await deps.repo.listTickets("tenant_olivia")).map((t) => t.priority).sort();
      e.equal("ticket priorities", priorities, ["emergency", "normal"]);
      return e.failures;
    },
  },
  {
    id: "E24",
    title: "'Still leaking, did you get my report?' adds to the open ticket and escalates it: no duplicate",
    actorId: "tenant_olivia",
    runs: [
      {
        requestId: "e24-first",
        userMessage: "There's a damp patch on the kitchen ceiling",
        script: [getContext, create({ ...leak, hazards: [], description: "Damp patch on the ceiling" }), { text: "Ticket created." }],
      },
      {
        requestId: "e24-again",
        userMessage: "It's still leaking from the ceiling and dripping a lot now, did you get my report?",
        // The model forgets the open ticket and creates again: the duplicate guard adds it instead.
        script: [getContext, create(leak), { text: "Yes — I've added this to your ticket and it is now an emergency, sent for review." }],
      },
    ],
    check: async ({ deps, results }) => {
      const e = expectations();
      const tickets = await deps.repo.listTickets("tenant_olivia");
      e.equal("tickets", tickets.map((t) => t.priority), ["emergency"]);
      e.equal("updates", (await deps.repo.listTicketUpdates(tickets[0]?.id ?? "")).length, 1);
      e.equal("reviews", (await deps.repo.listReviews("tenant_olivia")).map((r) => r.ticketId), [tickets[0]?.id]);
      e.equal("second run outcome", results[1].status, "completed");
      return e.failures;
    },
  },
];
