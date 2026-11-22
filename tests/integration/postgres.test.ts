import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { repositoryContract } from "@/domain/repository.contract";
import type { NewTicket } from "@/domain/repository";
import { PostgresRepository } from "@/infra/postgres-repository";
import { getRunDetail, listRuns, qualityByEvaluator, runStats } from "@/infra/inspector-queries";
import { PostgresTraceStore } from "@/infra/postgres-trace-store";
import {
  backfillEvaluations,
  loadEvaluableRun,
  PostgresEvaluationStore,
  runsPendingEvaluation,
} from "@/infra/evaluation-store";
import { evaluators } from "@/evaluators";
import { evaluateRun, snapshotFromResult } from "@/runtime/evaluation";

const pendingIds = async (...args: Parameters<typeof runsPendingEvaluation>) =>
  (await runsPendingEvaluation(...args)).map((p) => p.runId);
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

  const reset = () => sql`truncate run_evaluations, review_queue, tickets, run_events, runs`;

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

    it("the evaluable snapshot loaded from the database equals the one built in memory", async () => {
      const userMessage = "Leak in the kitchen, call me on 07700 900123";
      const result = await runAgent({
        workflow: maintenanceWorkflow,
        model: new ScriptedModel([
          // One rejected call (another tenant's property) and one successful create.
          { toolCalls: [{ name: "create_maintenance_ticket", args: { property_id: "prop_lds_1", category: "plumbing", hazards: [], location: null, description: "Leak" } }] },
          {
            toolCalls: [
              {
                name: "create_maintenance_ticket",
                args: { property_id: "prop_mcr_1", category: "plumbing", hazards: ["active_water_leak"], location: null, description: "Leak, email me at olivia@example.com" },
              },
            ],
          },
          { text: "Ticket created. We'll call 07700 900123." },
        ]),
        deps: { repo },
        tenantId: "tenant_olivia",
        requestId: "req-snapshot",
        userMessage,
        trace: { store: new PostgresTraceStore(sql), meta: { source: "portal", agencyId: "agency_northbridge" } },
      });

      const fromMemory = snapshotFromResult(result, {
        workflowId: "maintenance",
        tenantId: "tenant_olivia",
        agencyId: "agency_northbridge",
        source: "portal",
        userMessage,
      });
      // Strict: an `undefined` property kept in memory but dropped by JSON would be a difference.
      expect(await loadEvaluableRun(sql, result.runId)).toStrictEqual(fromMemory);
      expect(fromMemory.toolCalls.map((c) => [c.stage, c.status])).toEqual([
        ["authorize", "rejected"],
        ["execute", "ok"],
      ]);
      expect(fromMemory.userMessage).not.toContain("07700");
    });

    it("does not build a snapshot for a run that is still running", async () => {
      expect(await loadEvaluableRun(sql, await newRun())).toBeNull();
    });

    it("loads a finished run without a tenant as tenantId null", async () => {
      const runId = randomUUID();
      await sql`
        insert into runs (id, workflow_id, request_id, source, model, input, status)
        values (${runId}, 'maintenance', 'req-no-tenant', 'eval', 'test', '{"userMessage":"hi"}', 'failed')
      `;
      expect(await loadEvaluableRun(sql, runId)).toMatchObject({ tenantId: null, agencyId: null, toolCalls: [] });
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

      // Inspector read model over the same run.
      const [listed] = await listRuns(sql);
      expect(listed).toMatchObject({ id: result.runId, status: "completed", toolCalls: 2, agency: "Northbridge Lettings" });
      const detail = await getRunDetail(sql, result.runId);
      expect(detail?.events.map((e) => e.toolName ?? e.type)).toEqual([
        "model_call",
        "get_property_context",
        "model_call",
        "create_maintenance_ticket",
        "model_call",
      ]);
      expect(detail?.tickets[0]).toMatchObject({ priority: "emergency", policyVersion: 1 });
      expect(detail?.reviews[0]).toMatchObject({ source: "policy" });
      expect(await getRunDetail(sql, "not-a-uuid")).toBeNull();
      expect(await runStats(sql)).toMatchObject({ total: 1, failed: 0, withoutToolCalls: 0 });
    });
  });

  describe("horizontal evaluation storage", () => {
    beforeEach(reset);

    const leakRun = (userMessage = "Water is pouring through my ceiling") =>
      runAgent({
        workflow: maintenanceWorkflow,
        model: new ScriptedModel([
          {
            toolCalls: [
              {
                name: "create_maintenance_ticket",
                args: { property_id: "prop_mcr_1", category: "plumbing", hazards: ["active_water_leak"], location: null, description: "Leak" },
              },
            ],
          },
          { text: "Emergency ticket created." },
        ]),
        deps: { repo },
        tenantId: "tenant_olivia",
        requestId: randomUUID(),
        userMessage,
        trace: { store: new PostgresTraceStore(sql), meta: { source: "portal", agencyId: "agency_northbridge" } },
      });

    const stored = () =>
      sql`select run_id, evaluator_id, evaluator_version, verdict from run_evaluations order by evaluator_id, evaluator_version`;

    it("backfill evaluates runs missed online, then has nothing left to do", async () => {
      const run = await leakRun();
      expect(await pendingIds(sql, evaluators, null)).toEqual([run.runId]);

      expect(await backfillEvaluations(sql, evaluators, null)).toEqual({
        runs: 1,
        verdicts: { pass: 2, fail: 0, "n/a": 0, error: 0 },
      });
      expect(await pendingIds(sql, evaluators, null)).toEqual([]);
      expect((await backfillEvaluations(sql, evaluators, null)).runs).toBe(0);
    });

    it("backfill gives the same verdicts the online hook would have stored", async () => {
      const userMessage = "Water is pouring through my ceiling, call 07700 900123";
      const run = await leakRun(userMessage);
      const online = evaluateRun(
        snapshotFromResult(run, { workflowId: "maintenance", tenantId: "tenant_olivia", agencyId: "agency_northbridge", source: "portal", userMessage }),
        evaluators,
      );
      await backfillEvaluations(sql, evaluators, null);
      const rows = await sql`select evaluator_id, evaluator_version, verdict, evidence from run_evaluations order by evaluator_id`;
      expect(rows.map((r) => [r.evaluator_id, r.evaluator_version, r.verdict, r.evidence])).toEqual(
        online.map((v) => [v.evaluatorId, v.evaluatorVersion, v.verdict, v.evidence]),
      );
    });

    it("retries error verdicts and re-evaluates when an evaluator's version changes", async () => {
      const run = await leakRun();
      const store = new PostgresEvaluationStore(sql);
      await store.save(evaluateRun((await loadEvaluableRun(sql, run.runId))!, evaluators));
      expect(await pendingIds(sql, evaluators, null)).toEqual([]);

      // An error verdict is not a result: the run is pending again.
      await sql`update run_evaluations set verdict = 'error' where evaluator_id = 'hazard_logged'`;
      expect(await pendingIds(sql, evaluators, null)).toEqual([run.runId]);
      await backfillEvaluations(sql, evaluators, null);
      expect((await stored()).map((r) => r.verdict)).toEqual(["pass", "pass"]);

      // A new version of an evaluator: old verdicts stay, the run needs the new one.
      const bumped = evaluators.map((e) => (e.id === "hazard_logged" ? { ...e, version: e.version + 1 } : e));
      expect(await pendingIds(sql, bumped, null)).toEqual([run.runId]);
      await backfillEvaluations(sql, bumped, null);
      expect((await stored()).map((r) => [r.evaluator_id, r.evaluator_version])).toEqual([
        ["emergency_reviewed", 1],
        ["hazard_logged", 1],
        ["hazard_logged", 2],
      ]);
    });

    it("retrying one evaluator's error leaves the other evaluators' verdicts untouched", async () => {
      const run = await leakRun();
      await backfillEvaluations(sql, evaluators, null);
      await sql`update run_evaluations set verdict = 'error', evaluated_at = '2026-01-01' where evaluator_id = 'hazard_logged'`;
      await sql`update run_evaluations set evaluated_at = '2026-01-01' where evaluator_id = 'emergency_reviewed'`;

      expect(await runsPendingEvaluation(sql, evaluators, null)).toEqual([{ runId: run.runId, evaluatorIds: ["hazard_logged"] }]);
      expect(await backfillEvaluations(sql, evaluators, null)).toEqual({
        runs: 1,
        verdicts: { pass: 1, fail: 0, "n/a": 0, error: 0 },
      });
      const rows = await sql`
        select evaluator_id, verdict, evaluated_at < '2026-01-02' as untouched
        from run_evaluations order by evaluator_id
      `;
      expect(rows.map((r) => [r.evaluator_id, r.verdict, r.untouched])).toEqual([
        ["emergency_reviewed", "pass", true],
        ["hazard_logged", "pass", false],
      ]);
    });

    it("a stored valid verdict is never overwritten; only an error is replaced", async () => {
      const run = await leakRun();
      const verdicts = evaluateRun((await loadEvaluableRun(sql, run.runId))!, evaluators);
      const store = new PostgresEvaluationStore(sql);
      expect(await store.save(verdicts)).toHaveLength(2);
      await sql`update run_evaluations set evaluated_at = '2026-01-01'`;
      await sql`update run_evaluations set verdict = 'error' where evaluator_id = 'hazard_logged'`;

      // Same pairs written again (e.g. by a concurrent backfill): only the error is replaced.
      const written = await store.save(verdicts);
      expect(written.map((v) => v.evaluatorId)).toEqual(["hazard_logged"]);
      const rows = await sql`select evaluator_id, verdict, evaluated_at < '2026-01-02' as untouched from run_evaluations order by evaluator_id`;
      expect(rows.map((r) => [r.evaluator_id, r.verdict, r.untouched])).toEqual([
        ["emergency_reviewed", "pass", true],
        ["hazard_logged", "pass", false],
      ]);
      expect(await store.save(verdicts)).toEqual([]);
    });

    it("two concurrent backfills write and count each verdict once", async () => {
      await leakRun();
      await leakRun();
      const reports = await Promise.all([
        backfillEvaluations(sql, evaluators, null),
        backfillEvaluations(sql, evaluators, null),
      ]);
      const counted = reports.reduce((n, r) => n + Object.values(r.verdicts).reduce((a, b) => a + b, 0), 0);
      expect(counted).toBe(4);
      expect(await stored()).toHaveLength(4);
    });

    it("the quality panel counts an unevaluated run as pending, never as a pass", async () => {
      await leakRun();
      const before = await qualityByEvaluator(sql, evaluators);
      expect(before.map((r) => [r.evaluatorId, r.agency, r.eligible, r.pass, r.pending])).toEqual([
        ["emergency_reviewed", "Northbridge Lettings", 1, 0, 1],
        ["hazard_logged", "Northbridge Lettings", 1, 0, 1],
      ]);

      await backfillEvaluations(sql, evaluators, null);
      const after = await qualityByEvaluator(sql, evaluators);
      expect(after.map((r) => [r.evaluatorId, r.pass, r.fail, r.notApplicable, r.pending])).toEqual([
        ["emergency_reviewed", 1, 0, 0, 0],
        ["hazard_logged", 1, 0, 0, 0],
      ]);
    });

    it("a blocked verdict write is cancelled by PostgreSQL, freeing its connection", async () => {
      const run = await leakRun();
      const verdicts = evaluateRun((await loadEvaluableRun(sql, run.runId))!, evaluators);
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      let locked!: () => void;
      const lockTaken = new Promise<void>((resolve) => (locked = resolve));
      const locker = sql.begin(async (tx) => {
        await tx`lock table run_evaluations in access exclusive mode`;
        locked();
        await held;
      });
      await lockTaken;
      try {
        const startedAt = Date.now();
        await expect(new PostgresEvaluationStore(sql, { timeoutMs: 100 }).save(verdicts)).rejects.toThrow(/timeout/);
        expect(Date.now() - startedAt).toBeLessThan(2_000);
        // The connection went back to the pool: a normal query still runs while the lock is held.
        expect(await sql`select 1 as ok`).toEqual([{ ok: 1 }]);
      } finally {
        release();
        await locker;
      }
    });

    it("the quality panel keeps agencies with the same name apart", async () => {
      await sql`insert into agencies (id, name) values ('agency_namesake', 'Northbridge Lettings')`;
      try {
        await leakRun();
        await sql`
          insert into runs (id, workflow_id, agency_id, request_id, source, model, input, status)
          values (${randomUUID()}, 'maintenance', 'agency_namesake', 'req-namesake', 'portal', 'test', '{"userMessage":"hi"}', 'completed')
        `;
        const rows = (await qualityByEvaluator(sql, evaluators)).filter((r) => r.evaluatorId === "hazard_logged");
        expect(rows.map((r) => [r.agencyId, r.agency, r.eligible])).toEqual([
          ["agency_namesake", "Northbridge Lettings", 1],
          ["agency_northbridge", "Northbridge Lettings", 1],
        ]);
      } finally {
        await sql`delete from runs where agency_id = 'agency_namesake'`;
        await sql`delete from agencies where id = 'agency_namesake'`;
      }
    });

    it("only considers runs inside the --since window", async () => {
      const run = await leakRun();
      await sql`update runs set created_at = now() - interval '10 days' where id = ${run.runId}`;
      expect(await pendingIds(sql, evaluators, new Date(Date.now() - 7 * 86_400_000))).toEqual([]);
      expect(await pendingIds(sql, evaluators, null)).toEqual([run.runId]);
    });
  });
});
