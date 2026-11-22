import type { Fact } from "@/infra/operations-queries";
import * as seed from "@/infra/seed-data";
import { InMemoryOperations } from "@/operations/memory-operations";
import type { OpsDeps } from "@/operations/port";
import { expectations, type EvalCase } from "@/runtime/evals";
import type { RunEvent, RunResult } from "@/runtime/orchestrator";

// Executor evals for the operations brief: a manager's scope is set by the server; the model can
// narrow it but never widen it, and figures come only from tools.

const fact = (metric: string, agencyId: string, value: number, unit: Fact["unit"], n?: number): Fact => ({
  key: `${metric}.${agencyId}.2026-Q3`,
  metric,
  agencyId,
  period: "2026-Q3",
  unit,
  value,
  ...(n !== undefined && { n }),
});

export const CANNED = {
  volume: {
    facts: [
      fact("tickets_created", "agency_harbour_lane", 33, "tickets"),
      fact("tickets_created", "agency_northbridge", 71, "tickets"),
      fact("tickets_created", "agency_riverside", 43, "tickets"),
      fact("tickets_created", "all", 114, "tickets"),
    ],
    notes: [],
  },
  resolution: {
    facts: [
      fact("median_hours_to_resolve_emergency", "agency_northbridge", 5.5, "hours", 5),
      fact("median_hours_to_resolve_emergency", "agency_riverside", 9.2, "hours", 3),
    ],
    notes: [],
  },
};

const north = seed.managers.find((m) => m.id === "manager_north")!;

export function makeOpsDeps(): OpsDeps {
  return {
    operations: new InMemoryOperations(CANNED),
    scope: { managerId: north.id, name: north.name, agencyIds: north.agencyIds },
  };
}

const toolEvents = (result: RunResult) =>
  result.events.filter((e): e is Extract<RunEvent, { type: "tool_call" }> => e.type === "tool_call");
const calls = (deps: OpsDeps) => (deps.operations as InMemoryOperations).calls;

export const operationsBriefEvals: EvalCase<OpsDeps>[] = [
  {
    id: "E10",
    title: "Manager asks about an agency outside their scope: rejected at authorize, nothing queried",
    actorId: "manager_north",
    runs: [
      {
        requestId: "e10",
        userMessage: "How is Harbour Lane doing?",
        script: [
          { toolCalls: [{ name: "get_volume", args: { period: "last_closed_quarter", agency_id: "agency_harbour_lane" } }] },
          { text: "Harbour Lane isn't one of the agencies you manage." },
        ],
      },
    ],
    check: async ({ deps, results }) => {
      const e = expectations();
      const [call] = toolEvents(results[0]);
      e.equal("stage/status/code", [call?.stage, call?.status, call?.result.ok === false && call.result.code], [
        "authorize",
        "rejected",
        "agency_not_authorized",
      ]);
      e.equal("queries run", calls(deps).length, 0);
      return e.failures;
    },
  },
  {
    id: "E11",
    title: "Brief over the manager's scope: only authorised agencies, figures cited from facts",
    actorId: "manager_north",
    runs: [
      {
        requestId: "e11",
        userMessage: "How did reports trend last quarter?",
        script: [
          { toolCalls: [{ name: "get_volume", args: { period: "last_closed_quarter", agency_id: null } }] },
          {
            text:
              "In 2026-Q3 (synthetic data) Northbridge Lettings received 71 tickets [tickets_created.agency_northbridge.2026-Q3] " +
              "and Riverside Homes 43 [tickets_created.agency_riverside.2026-Q3].",
          },
        ],
      },
    ],
    check: async ({ deps, results }) => {
      const e = expectations();
      e.equal("scope queried", calls(deps)[0]?.query.agencyIds, ["agency_northbridge", "agency_riverside"]);
      const [call] = toolEvents(results[0]);
      const agencies = call?.result.ok ? (call.result.data as { facts: { agency: string }[] }).facts.map((f) => f.agency) : [];
      e.equal("agencies returned", agencies, ["Northbridge Lettings", "Riverside Homes", "all your agencies"]);
      return e.failures;
    },
  },
  {
    id: "E12",
    title: "agency_id narrows the scope to one authorised agency",
    actorId: "manager_north",
    runs: [
      {
        requestId: "e12",
        userMessage: "How fast does Riverside fix emergencies?",
        script: [
          { toolCalls: [{ name: "get_resolution", args: { period: "last_closed_quarter", agency_id: "agency_riverside", priority: "emergency" } }] },
          { text: "Riverside Homes resolved emergencies in a median of 9.2 hours [median_hours_to_resolve_emergency.agency_riverside.2026-Q3]." },
        ],
      },
    ],
    check: async ({ deps }) => {
      const e = expectations();
      const [query] = calls(deps);
      e.equal("narrowed scope", query?.query.agencyIds, ["agency_riverside"]);
      e.equal("priority", query?.query.priority, "emergency");
      return e.failures;
    },
  },
  {
    id: "E13",
    title: "An invented period is rejected at validate: no open-ended or current-quarter queries",
    actorId: "manager_north",
    runs: [
      {
        requestId: "e13",
        userMessage: "How are we doing this quarter so far?",
        script: [
          { toolCalls: [{ name: "get_volume", args: { period: "this_quarter", agency_id: null } }] },
          { text: "I can only report closed periods; the last one is 2026-Q3." },
        ],
      },
    ],
    check: async ({ deps, results }) => {
      const e = expectations();
      const [call] = toolEvents(results[0]);
      e.equal("stage/status", [call?.stage, call?.status], ["validate", "rejected"]);
      e.equal("queries run", calls(deps).length, 0);
      return e.failures;
    },
  },
];
