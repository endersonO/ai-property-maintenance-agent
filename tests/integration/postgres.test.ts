import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { repositoryContract } from "@/domain/repository.contract";
import type { NewTicket } from "@/domain/repository";
import { PostgresRepository } from "@/infra/postgres-repository";
import { PostgresTraceStore } from "@/infra/postgres-trace-store";
import * as seed from "@/infra/seed-data";
import { ScriptedModel } from "@/runtime/model";
import { runAgent } from "@/runtime/orchestrator";
import { maintenanceWorkflow } from "@/workflows/maintenance";

// Real PostgreSQL guarantees the in-memory repository cannot prove: transactions,
// concurrency, constraints. Needs TEST_DATABASE_URL (a seeded, disposable database).

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("PostgreSQL integration", () => {
  const sql = postgres(url ?? "", { prepare: false, max: 10, onnotice: () => {} });
  const repo = new PostgresRepository(sql);

  afterAll(() => sql.end());

  const reset = () => sql`truncate review_queue, tickets, run_events, runs`;

  const newRun = async () => {
    const runId = randomUUID();
    await sql`
      insert into runs (id, workflow_id, tenant_id, request_id, source, model, input)
      values (${runId}, 'maintenance', 'tenant_olivia', 'req-test', 'eval', 'test', '{}')
    `;
    return runId;
  };

  const ticket = (runId: string): NewTicket => ({
    agencyId: "agency_northbridge",
    propertyId: "prop_mcr_1",
    tenantId: "tenant_olivia",
    runId,
    category: "plumbing",
    hazards: ["active_water_leak"],
    location: null,
    description: "Leak",
    priority: "emergency",
    estimatedCostGbp: 180,
    policyVersion: 1,
    idempotencyKey: "same-key",
  });

  repositoryContract("PostgresRepository", async () => {
    await reset();
    return { repo, runId: await newRun() };
  });

  describe("guarantees", () => {
    beforeEach(reset);

    it("I1: concurrent creates with the same idempotency key produce exactly one ticket", async () => {
      const runId = await newRun();
      const results = await Promise.all(
        Array.from({ length: 8 }, () => repo.createTicketWithReview(ticket(runId), null)),
      );

      expect(new Set(results.map((r) => r.ticket.id)).size).toBe(1);
      expect(results.filter((r) => !r.duplicate)).toHaveLength(1);
      expect(await repo.listTickets("tenant_olivia")).toHaveLength(1);
    });

    it("I2: a failing review insert rolls back the ticket", async () => {
      const runId = await newRun();
      await expect(
        repo.createTicketWithReview(ticket(runId), {
          runId,
          agencyId: "agency_northbridge",
          tenantId: "tenant_nobody", // violates the foreign key
          source: "policy",
          reason: "emergency",
        }),
      ).rejects.toThrow(/foreign key/);

      expect(await repo.listTickets("tenant_olivia")).toHaveLength(0);
    });

    it("the database seed matches the in-memory seed used by evals", async () => {
      const agencies = await sql`select id, name from agencies order by id`;
      expect(agencies.map((a) => ({ ...a }))).toEqual(
        [...seed.agencies].sort((a, b) => a.id.localeCompare(b.id)),
      );
      for (const p of seed.policies) {
        expect(await repo.getActivePolicy(p.agencyId)).toEqual(p);
      }
      for (const t of seed.tenants) {
        const ctx = await repo.getTenantContext(t.id);
        expect(ctx?.property.id).toBe(t.propertyId);
      }
    });

    it("persists a full traced run that can be explained with one query", async () => {
      const result = await runAgent({
        workflow: maintenanceWorkflow,
        model: new ScriptedModel([
          { toolCalls: [{ name: "get_property_context", args: {} }] },
          {
            toolCalls: [
              {
                name: "create_maintenance_ticket",
                args: {
                  property_id: "prop_mcr_1",
                  category: "plumbing",
                  hazards: ["active_water_leak"],
                  location: "kitchen ceiling",
                  description: "Water is leaking from my ceiling",
                },
              },
            ],
          },
          { text: "Emergency ticket created." },
        ]),
        deps: { repo },
        tenantId: "tenant_olivia",
        requestId: "req-full",
        userMessage: "Water is leaking from my ceiling",
        trace: { store: new PostgresTraceStore(sql), meta: { source: "eval", agencyId: "agency_northbridge" } },
      });
      expect(result.status).toBe("completed");

      const [run] = await sql`select status, steps, cost_usd from runs where id = ${result.runId}`;
      expect(run).toMatchObject({ status: "completed", steps: 3 });

      // The talking-points query: a ticket explained end to end.
      const rows = await sql`
        select t.priority, t.policy_version, e.seq, e.type, e.tool_name, e.stage, e.status
        from tickets t
        join run_events e on e.run_id = t.run_id
        where t.run_id = ${result.runId}
        order by e.seq
      `;
      expect(rows.map((r) => [r.seq, r.type, r.tool_name, r.stage, r.status])).toEqual([
        [1, "model_call", null, null, "ok"],
        [2, "tool_call", "get_property_context", "execute", "ok"],
        [3, "model_call", null, null, "ok"],
        [4, "tool_call", "create_maintenance_ticket", "execute", "ok"],
        [5, "model_call", null, null, "ok"],
      ]);
      expect(rows[0]).toMatchObject({ priority: "emergency", policy_version: 1 });
    });
  });
});
