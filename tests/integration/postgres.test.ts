import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { repositoryContract } from "@/domain/repository.contract";
import type { NewTicket } from "@/domain/repository";
import { PostgresRepository } from "@/infra/postgres-repository";
import { getRunDetail, listRuns, qualityByEvaluator, qualitySummary, runEvaluations, runStats } from "@/infra/inspector-queries";
import { PostgresTraceStore } from "@/infra/postgres-trace-store";
import {
  backfillEvaluations,
  loadEvaluableRun,
  PostgresEvaluationStore,
  runsPendingEvaluation,
} from "@/infra/evaluation-store";
import { evaluators as allEvaluators } from "@/evaluators";
import { evaluateRun, snapshotFromResult } from "@/runtime/evaluation";
import { replaceSyntheticHistory } from "@/infra/operations-store";
import { managerScope, operationsDashboard, PostgresOperations, readAttentionQueue } from "@/infra/postgres-operations";
import { readOpenNow, resolutionFacts, volumeFacts, type Fact } from "@/infra/operations-queries";
import { demoHistoryAgencies, generateHistory } from "@/operations/history";

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

  const reset = () =>
    sql`truncate ticket_priority_changes, run_evaluations, review_queue, tickets, run_events, runs, synthetic_tickets, synthetic_portfolio, synthetic_history_meta`;

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
      const agencies = await sql`
        select id, name, acquired_on::text as "acquiredOn", history_starts_on::text as "historyStartsOn",
               onboarded_on::text as "onboardedOn"
        from agencies order by id
      `;
      expect(agencies.map((a) => ({ ...a }))).toEqual([...seed.agencies].sort((a, b) => a.id.localeCompare(b.id)));
      const grants = await sql`select manager_id, agency_id from manager_agencies order by 1, 2`;
      expect(grants.map((g) => [g.manager_id, g.agency_id])).toEqual(
        seed.managers.flatMap((m) => m.agencyIds.map((a) => [m.id, a])).sort((x, y) => x.join().localeCompare(y.join())),
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
        actorId: "tenant_olivia",
        requestId: "req-snapshot",
        userMessage,
        history: [
          { role: "user", content: "Hi, it's olivia@example.com" },
          { role: "assistant", content: "Ticket 837217b0-7a4f-440a-b9a3-c54a57ba03f4 is open.", toolCalls: [] },
        ],
        trace: { store: new PostgresTraceStore(sql), meta: { source: "portal", agencyId: "agency_northbridge", tenantId: "tenant_olivia" } },
      });

      const fromMemory = snapshotFromResult(result, {
        workflowId: "maintenance",
        tenantId: "tenant_olivia",
        agencyId: "agency_northbridge",
        source: "portal",
        userMessage,
        history: [
          { role: "user", content: "Hi, it's olivia@example.com" },
          { role: "assistant", content: "Ticket 837217b0-7a4f-440a-b9a3-c54a57ba03f4 is open." },
        ],
      });
      // Strict: an `undefined` property kept in memory but dropped by JSON would be a difference.
      expect(await loadEvaluableRun(sql, result.runId)).toStrictEqual(fromMemory);
      expect(fromMemory.toolCalls.map((c) => [c.stage, c.status])).toEqual([
        ["authorize", "rejected"],
        ["execute", "ok"],
      ]);
      expect(fromMemory.userMessage).not.toContain("07700");
      expect(fromMemory.history?.[0].content).toBe("Hi, it's [email]");
    });

    it("an old trace with earlier turns but no stored history loads as 'not recorded', not empty", async () => {
      const withTurns = randomUUID();
      const withoutTurns = randomUUID();
      for (const [id, historyLength] of [[withTurns, 2], [withoutTurns, 0]] as const) {
        await sql`
          insert into runs (id, workflow_id, tenant_id, request_id, source, model, input, status)
          values (${id}, 'ticket-status', 'tenant_olivia', 'req-old', 'portal', 'test',
                  ${sql.json({ userMessage: "Repeat the number?", historyLength })}, 'completed')
        `;
      }
      expect((await loadEvaluableRun(sql, withTurns))?.history).toBeNull();
      expect((await loadEvaluableRun(sql, withoutTurns))?.history).toEqual([]);
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
        actorId: "tenant_olivia",
        requestId: "req-full",
        userMessage: "Water is leaking from my ceiling",
        trace: { store: new PostgresTraceStore(sql), meta: { source: "eval", agencyId: "agency_northbridge", tenantId: "tenant_olivia" } },
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

    // A fixed pair, so these storage tests don't change every time an evaluator is added.
    const evaluators = allEvaluators.filter((e) => ["emergency_reviewed", "hazard_logged"].includes(e.id));

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
        actorId: "tenant_olivia",
        requestId: randomUUID(),
        userMessage,
        trace: { store: new PostgresTraceStore(sql), meta: { source: "portal", agencyId: "agency_northbridge", tenantId: "tenant_olivia" } },
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

    it("lists runs with their checks and filters to the runs an evaluator flagged", async () => {
      const flaggedRun = await leakRun();
      const cleanRun = await leakRun();
      const pendingRun = await leakRun();
      const store = new PostgresEvaluationStore(sql);
      for (const run of [flaggedRun, cleanRun]) {
        await store.save(evaluateRun((await loadEvaluableRun(sql, run.runId))!, evaluators));
      }
      await sql`update run_evaluations set verdict = 'fail' where run_id = ${flaggedRun.runId} and evaluator_id = 'hazard_logged'`;

      const all = await listRuns(sql, { evaluators });
      const checks = Object.fromEntries(all.map((r) => [r.id, r.checks]));
      expect(checks[flaggedRun.runId]).toEqual({ flagged: 1, pending: 0 });
      expect(checks[cleanRun.runId]).toEqual({ flagged: 0, pending: 0 });
      expect(checks[pendingRun.runId]).toEqual({ flagged: 0, pending: evaluators.length });

      expect((await listRuns(sql, { evaluators, failing: "hazard_logged" })).map((r) => r.id)).toEqual([flaggedRun.runId]);
      expect(await listRuns(sql, { evaluators, failing: "emergency_reviewed" })).toEqual([]);

      // A run still in progress has no verdicts yet: pending, never "clear".
      const running = await newRun();
      expect((await listRuns(sql, { evaluators })).find((r) => r.id === running)?.checks).toEqual({
        flagged: 0,
        pending: evaluators.length,
      });

      const verdicts = await runEvaluations(sql, pendingRun.runId, evaluators);
      expect(verdicts.map((v) => v.verdict)).toEqual(evaluators.map(() => "pending"));
      expect((await runEvaluations(sql, flaggedRun.runId, evaluators)).find((v) => v.evaluatorId === "hazard_logged")?.verdict).toBe("fail");
    });

    it("the headline counts distinct runs, keeps errors apart from failures, and matches its 'any' filter", async () => {
      // Two rules and two alarms, so a run can fail both alarms at once.
      const four = [
        { id: "rule_a", version: 1, kind: "invariant" as const },
        { id: "rule_b", version: 1, kind: "invariant" as const },
        { id: "alarm_a", version: 1, kind: "monitor" as const },
        { id: "alarm_b", version: 1, kind: "monitor" as const },
      ];
      const verdicts = async (runId: string, v: Record<string, string>) => {
        for (const [id, verdict] of Object.entries(v)) {
          await sql`insert into run_evaluations (run_id, evaluator_id, evaluator_version, verdict) values (${runId}, ${id}, 1, ${verdict})`;
        }
      };
      const finished = async () => {
        const id = await newRun();
        await sql`update runs set status = 'completed' where id = ${id}`;
        return id;
      };
      const clean = await finished();
      await verdicts(clean, { rule_a: "pass", rule_b: "n/a", alarm_a: "pass", alarm_b: "n/a" });
      const twoAlarms = await finished();
      await verdicts(twoAlarms, { rule_a: "pass", rule_b: "pass", alarm_a: "fail", alarm_b: "fail" });
      const broken = await finished();
      await verdicts(broken, { rule_a: "fail", rule_b: "pass", alarm_a: "fail", alarm_b: "pass" });
      const errored = await finished();
      await verdicts(errored, { rule_a: "error", rule_b: "pass", alarm_a: "pass", alarm_b: "pass" });
      const pending = await finished();
      await verdicts(pending, { rule_a: "pass" });
      await newRun(); // still running: not counted anywhere

      expect(await qualitySummary(sql, four)).toEqual({
        finished: 5,
        checked: 4,
        pending: 1,
        brokenRules: 1,
        flagged: 1, // the run with two failed alarms counts once; the broken one isn't double-counted
        checkErrors: 1, // an evaluator error is not a broken rule
      });
      // Each filter lists exactly the runs its count counts.
      const shown = async (failing: string) => (await listRuns(sql, { evaluators: four, failing })).map((r) => r.id).sort();
      expect(await shown("rules")).toEqual([broken]);
      expect(await shown("alarms")).toEqual([twoAlarms]); // the broken run also failed an alarm, but is counted as broken
      expect(await shown("errors")).toEqual([errored]);
      expect(await shown("any")).toEqual([twoAlarms, broken, errored].sort());
      // One evaluator, one verdict: rule_a failed in one run and couldn't run in another.
      expect(await shown("rule_a:fail")).toEqual([broken]);
      expect(await shown("rule_a:error")).toEqual([errored]);
      // A bare evaluator id (links saved before verdicts were split) keeps meaning "failed or couldn't run".
      expect(await shown("rule_a")).toEqual([broken, errored].sort());
      // The list says when it shows only part of the matching runs.
      const page = await listRuns(sql, { evaluators: four, failing: "any", limit: 2 });
      expect([page.length, page[0].totalMatching]).toEqual([2, 3]);
    });

    it("only considers runs inside the --since window", async () => {
      const run = await leakRun();
      await sql`update runs set created_at = now() - interval '10 days' where id = ${run.runId}`;
      expect(await pendingIds(sql, evaluators, new Date(Date.now() - 7 * 86_400_000))).toEqual([]);
      expect(await pendingIds(sql, evaluators, null)).toEqual([run.runId]);
    });
  });

  describe("synthetic operations history", () => {
    beforeEach(reset);
    const history = generateHistory(demoHistoryAgencies());

    it("replaces only synthetic rows, idempotently, and live flows never see them", async () => {
      await repo.createTicketWithReview(ticket(await newRun()), null);
      await replaceSyntheticHistory(sql, history);
      await replaceSyntheticHistory(sql, history);

      const [{ n }] = await sql`select count(*)::int as n from synthetic_tickets`;
      expect(n).toBe(history.tickets.length);
      // The live ticket is untouched and the tenant's view is unchanged.
      expect(await repo.listTickets("tenant_olivia")).toHaveLength(1);
      const datasets = await sql`select dataset, count(*)::int as n from ops.operations_tickets group by dataset order by dataset`;
      expect(datasets.map((r) => [r.dataset, r.n])).toEqual([
        ["live", 1],
        ["synthetic", history.tickets.length],
      ]);
    });

    it("two concurrent regenerations leave exactly one history", async () => {
      await Promise.all([replaceSyntheticHistory(sql, history), replaceSyntheticHistory(sql, history)]);
      const [{ n }] = await sql`select count(*)::int as n from synthetic_tickets`;
      expect(n).toBe(history.tickets.length);
      const [meta] = await sql`select seed, as_of from synthetic_history_meta`;
      expect([meta.seed, meta.as_of.toISOString()]).toEqual([history.seed, history.asOf.toISOString()]);
    });

    it("a failed write leaves the previous history in place", async () => {
      await replaceSyntheticHistory(sql, history);
      const broken = { ...history, tickets: [...history.tickets, { ...history.tickets[0], agencyId: "agency_missing" }] };
      await expect(replaceSyntheticHistory(sql, broken)).rejects.toThrow();
      const [{ n }] = await sql`select count(*)::int as n from synthetic_tickets`;
      expect(n).toBe(history.tickets.length);
    });

    it("the database rejects a resolution before creation or a resolved ticket without a date", async () => {
      await expect(sql`
        insert into synthetic_tickets (agency_id, category, priority, estimated_cost_gbp, sent_to_review, status, created_at, resolved_at)
        values ('agency_northbridge', 'plumbing', 'normal', 100, false, 'resolved', '2026-05-02', '2026-05-01')
      `).rejects.toThrow(/check/);
      await expect(sql`
        insert into synthetic_tickets (agency_id, category, priority, estimated_cost_gbp, sent_to_review, status, created_at)
        values ('agency_northbridge', 'plumbing', 'normal', 100, false, 'resolved', '2026-05-02')
      `).rejects.toThrow(/check/);
    });

    it("traces record who acted", async () => {
      const result = await runAgent({
        workflow: maintenanceWorkflow,
        model: new ScriptedModel([{ text: "Hello." }]),
        deps: { repo },
        actorId: "tenant_olivia",
        requestId: "req-actor",
        userMessage: "hi",
        trace: { store: new PostgresTraceStore(sql), meta: { source: "portal", tenantId: "tenant_olivia" } },
      });
      const [run] = await sql`select actor_id, tenant_id from runs where id = ${result.runId}`;
      expect({ ...run }).toEqual({ actor_id: "tenant_olivia", tenant_id: "tenant_olivia" });
    });
  });

  describe("operations metrics on a small fixture with hand-computed answers", () => {
    beforeEach(async () => {
      await reset();
      // `at` is the resolution or cancellation time, depending on the status.
      const row = (agency: string, created: string, status: string, at: string | null = null) =>
        sql`
          insert into synthetic_tickets (agency_id, category, priority, estimated_cost_gbp, sent_to_review, status, created_at, resolved_at, cancelled_at)
          values (${agency}, 'plumbing', 'normal', 100, false, ${status}, ${created},
                  ${status === "resolved" ? at : null}, ${status === "cancelled" ? at : null})
        `;
      // Northbridge, 2026-Q3: resolved in 10 h and 30 h, one open since 1 Sep, one cancelled.
      await row("agency_northbridge", "2026-07-10T08:00:00Z", "resolved", "2026-07-10T18:00:00Z");
      await row("agency_northbridge", "2026-08-01T00:00:00Z", "resolved", "2026-08-02T06:00:00Z");
      await row("agency_northbridge", "2026-09-01T00:00:00Z", "open");
      await row("agency_northbridge", "2026-09-15T00:00:00Z", "cancelled", "2026-09-16T00:00:00Z");
      // Northbridge baselines: two in 2026-Q2, one in 2025-Q3.
      await row("agency_northbridge", "2026-04-02T00:00:00Z", "resolved", "2026-04-03T00:00:00Z");
      await row("agency_northbridge", "2026-05-02T00:00:00Z", "resolved", "2026-05-03T00:00:00Z");
      await row("agency_northbridge", "2025-08-02T00:00:00Z", "resolved", "2025-08-03T00:00:00Z");
      // Riverside (history from 2026-03-01): one in Q3 resolved in 50 h, one in Q2, none a year ago.
      await row("agency_riverside", "2026-07-20T00:00:00Z", "resolved", "2026-07-22T02:00:00Z");
      await row("agency_riverside", "2026-06-20T00:00:00Z", "resolved", "2026-06-21T00:00:00Z");
      // Harbour Lane is outside the scope below and must not leak into "all".
      await row("agency_harbour_lane", "2026-07-05T00:00:00Z", "open");
      // Coverage: Northbridge for 2025-Q3 and Apr–Sep 2026; Riverside from its acquisition (March)
      // to September. Months outside these have no data and must never read as zero.
      const months = (from: string, to: string) => {
        const out: string[] = [];
        for (let d = new Date(`${from}T00:00:00Z`); d <= new Date(`${to}T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + 1)) {
          out.push(d.toISOString().slice(0, 10));
        }
        return out;
      };
      for (const month of [...months("2025-07-01", "2025-09-01"), ...months("2026-04-01", "2026-09-01")]) {
        await sql`insert into synthetic_portfolio (agency_id, month, properties) values ('agency_northbridge', ${month}, 400)`;
      }
      for (const month of months("2026-03-01", "2026-09-01")) {
        await sql`insert into synthetic_portfolio (agency_id, month, properties) values ('agency_riverside', ${month}, 300)`;
      }
      // The fixture represents what was observed up to 1 Nov 2026.
      await sql`insert into synthetic_history_meta (seed, as_of) values (0, '2026-11-01T00:00:00Z')`;
    });

    const scope = {
      dataset: "synthetic" as const,
      asOf: new Date("2026-11-01T00:00:00Z"),
      period: "last_closed_quarter" as const,
      agencyIds: ["agency_northbridge", "agency_riverside"],
    };
    const values = (facts: Fact[]) => Object.fromEntries(facts.map((f) => [f.key, f.value]));

    it("volume: counts, changes, exposure, and no invented baseline for an acquired agency", async () => {
      const { facts, notes } = await volumeFacts(sql, scope);
      expect(values(facts)).toEqual({
        "tickets_created.agency_northbridge.2026-Q3": 4,
        "tickets_created.agency_northbridge.2026-Q2": 2,
        "change_vs_previous_period.agency_northbridge.2026-Q3": 100,
        "tickets_created.agency_northbridge.2025-Q3": 1,
        "change_vs_same_period_last_year.agency_northbridge.2026-Q3": 300,
        "tickets_per_100_homes.agency_northbridge.2026-Q3": 0.33,
        "tickets_created.agency_riverside.2026-Q3": 1,
        "tickets_created.agency_riverside.2026-Q2": 1,
        "change_vs_previous_period.agency_riverside.2026-Q3": 0,
        "tickets_per_100_homes.agency_riverside.2026-Q3": 0.11,
        "tickets_created.all.2026-Q3": 5,
      });
      expect(notes).toEqual([
        "agency_riverside: no change_vs_same_period_last_year — data covers 3/3 months of 2026-Q3 and 0/3 of 2025-Q3.",
      ]);
    });

    it("resolution: created cohort, share resolved, median and p90, backlog and age, cancelled apart", async () => {
      const { facts } = await resolutionFacts(sql, scope);
      const v = values(facts);
      expect(v["tickets_in_cohort.agency_northbridge.2026-Q3"]).toBe(3);
      expect(v["resolved_share.agency_northbridge.2026-Q3"]).toBe(66.7);
      expect(v["median_hours_to_resolve.agency_northbridge.2026-Q3"]).toBe(20);
      expect(v["p90_hours_to_resolve.agency_northbridge.2026-Q3"]).toBe(28);
      expect(v["open_at_as_of.agency_northbridge.2026-Q3"]).toBe(1);
      expect(v["open_median_age_days.agency_northbridge.2026-Q3"]).toBe(61);
      expect(v["cancelled.agency_northbridge.2026-Q3"]).toBe(1);
      // "all" = the authorised scope only (Harbour Lane's open ticket is excluded).
      expect(v["tickets_in_cohort.all.2026-Q3"]).toBe(4);
      expect(v["resolved_share.all.2026-Q3"]).toBe(75);
      expect(v["median_hours_to_resolve.all.2026-Q3"]).toBe(30);
      expect(v["p90_hours_to_resolve.all.2026-Q3"]).toBe(46);
      expect(facts.find((f) => f.key === "median_hours_to_resolve.all.2026-Q3")?.n).toBe(3);
    });

    it("an agency with no tickets in the cohort reports zero instead of disappearing", async () => {
      const { facts } = await resolutionFacts(sql, { ...scope, priority: "emergency" });
      expect(values(facts)).toEqual({
        "tickets_in_cohort_emergency.agency_northbridge.2026-Q3": 0,
        "open_at_as_of_emergency.agency_northbridge.2026-Q3": 0,
        "cancelled_emergency.agency_northbridge.2026-Q3": 0,
        "tickets_in_cohort_emergency.agency_riverside.2026-Q3": 0,
        "open_at_as_of_emergency.agency_riverside.2026-Q3": 0,
        "cancelled_emergency.agency_riverside.2026-Q3": 0,
        "tickets_in_cohort_emergency.all.2026-Q3": 0,
        "open_at_as_of_emergency.all.2026-Q3": 0,
        "cancelled_emergency.all.2026-Q3": 0,
      });
    });

    it("states are taken as of asOf: a ticket resolved after the cut-off was still open then", async () => {
      // Created 20 Sep, resolved 20 Oct. Reported with asOf 1 Oct (Q3 is already closed).
      await sql`
        insert into synthetic_tickets (agency_id, category, priority, estimated_cost_gbp, sent_to_review, status, created_at, resolved_at)
        values ('agency_northbridge', 'plumbing', 'normal', 100, false, 'resolved', '2026-09-20T00:00:00Z', '2026-10-20T00:00:00Z')
      `;
      const early = values((await resolutionFacts(sql, { ...scope, asOf: new Date("2026-10-01T00:00:00Z") })).facts);
      expect(early["open_at_as_of.agency_northbridge.2026-Q3"]).toBe(2);
      expect(early["resolved_share.agency_northbridge.2026-Q3"]).toBe(50);
      expect(early["median_hours_to_resolve.agency_northbridge.2026-Q3"]).toBe(20);
      // A month later the same ticket counts as resolved (720 h).
      const later = values((await resolutionFacts(sql, scope)).facts);
      expect(later["open_at_as_of.agency_northbridge.2026-Q3"]).toBe(1);
      expect(later["resolved_share.agency_northbridge.2026-Q3"]).toBe(75);
      expect(later["median_hours_to_resolve.agency_northbridge.2026-Q3"]).toBe(30);
    });

    it("a cancellation after the cut-off leaves the ticket open as of asOf", async () => {
      await sql`
        insert into synthetic_tickets (agency_id, category, priority, estimated_cost_gbp, sent_to_review, status, created_at, cancelled_at)
        values ('agency_northbridge', 'plumbing', 'normal', 100, false, 'cancelled', '2026-09-25T00:00:00Z', '2026-10-20T00:00:00Z')
      `;
      const early = values((await resolutionFacts(sql, { ...scope, asOf: new Date("2026-10-01T00:00:00Z") })).facts);
      expect([early["open_at_as_of.agency_northbridge.2026-Q3"], early["cancelled.agency_northbridge.2026-Q3"]]).toEqual([2, 1]);
      const later = values((await resolutionFacts(sql, scope)).facts);
      expect([later["open_at_as_of.agency_northbridge.2026-Q3"], later["cancelled.agency_northbridge.2026-Q3"]]).toEqual([1, 2]);
    });

    it("tickets per 100 homes uses the months with data, and a partial period publishes no change", async () => {
      // Riverside has portfolio data only for September in this quarter.
      await sql`delete from synthetic_portfolio where agency_id = 'agency_riverside' and month in ('2026-07-01', '2026-08-01')`;
      await sql`
        insert into synthetic_tickets (agency_id, category, priority, estimated_cost_gbp, sent_to_review, status, created_at)
        values ('agency_riverside', 'plumbing', 'normal', 100, false, 'open', '2026-09-03T00:00:00Z'),
               ('agency_riverside', 'plumbing', 'normal', 100, false, 'open', '2026-09-04T00:00:00Z')
      `;
      const { facts, notes } = await volumeFacts(sql, scope);
      // The rate uses the same months for tickets and homes: September only, 2 tickets / 300 homes.
      // The July ticket still counts in the quarter's volume (3).
      expect(values(facts)["tickets_per_100_homes.agency_riverside.2026-Q3"]).toBe(0.67);
      expect(values(facts)["tickets_created.agency_riverside.2026-Q3"]).toBe(3);
      // Riverside joined in March: a gap in Q3 is reported as observed coverage, not as an acquisition.
      expect(notes).toContain("agency_riverside: data covers 1 of 3 months of 2026-Q3; rates use those months only.");
      expect(values(facts)["change_vs_previous_period.agency_riverside.2026-Q3"]).toBeUndefined();
    });

    it("mentions the acquisition only when its recorded date falls inside the period", async () => {
      const { notes } = await volumeFacts(sql, { ...scope, asOf: new Date("2026-04-01T00:00:00Z") });
      expect(notes).toContain(
        "agency_riverside: data covers 1 of 3 months of 2026-Q1; rates use those months only. Acquired on 2026-03-01.",
      );
    });

    it("every fact key is unique, also for 12 months where previous = last year", async () => {
      for (const period of ["last_closed_month", "last_closed_quarter", "last_12_closed_months"] as const) {
        const { facts } = await volumeFacts(sql, { ...scope, period });
        const keys = facts.map((f) => f.key);
        expect(new Set(keys).size).toBe(keys.length);
      }
    });

    it("live data is a separate dataset: the synthetic fixture never shows up in it", async () => {
      const { facts, notes } = await volumeFacts(sql, { ...scope, dataset: "live" });
      expect(facts).toEqual([]);
      expect(notes).toContain("agency_northbridge: no live data for 2026-Q3; nothing reported.");
    });

    it("the resolution total only includes the agencies that are reported", async () => {
      // Riverside keeps its tickets but loses its Q3 coverage: it is not reported, nor counted in "all".
      await sql`delete from synthetic_portfolio where agency_id = 'agency_riverside' and month >= '2026-07-01'`;
      const { facts, notes } = await resolutionFacts(sql, scope);
      const v = values(facts);
      expect(v["tickets_in_cohort.agency_riverside.2026-Q3"]).toBeUndefined();
      expect(v["tickets_in_cohort.all.2026-Q3"]).toBe(v["tickets_in_cohort.agency_northbridge.2026-Q3"]);
      expect(v["median_hours_to_resolve.all.2026-Q3"]).toBe(v["median_hours_to_resolve.agency_northbridge.2026-Q3"]);
      expect(notes).toContain("agency_riverside: no synthetic data for 2026-Q3; nothing reported.");
    });

    it("never infers states after the last observation: ages stop at the history's as_of", async () => {
      // Asking for a cut-off two months after the history ends (1 Jan 2027).
      const asked = { ...scope, asOf: new Date("2027-01-01T00:00:00Z"), period: "last_12_closed_months" as const };
      const { facts, notes } = await resolutionFacts(sql, asked);
      const v = values(facts);
      // The ticket open since 1 Sep is 61 days old at 1 Nov — not 122 at 1 Jan.
      expect(v["open_median_age_days.agency_northbridge.2026-01..2026-12"]).toBe(61);
      expect(notes).toContain("States use the last observed date 2026-11-01, not the requested 2027-01-01.");
    });

    it("each report reads one snapshot (repeatable read, read only)", async () => {
      const modes: string[] = [];
      const spy = {
        begin: (mode: string, fn: (tx: postgres.TransactionSql) => unknown) => {
          modes.push(mode);
          return sql.begin(mode, fn as never);
        },
      } as unknown as postgres.Sql;
      expect(await volumeFacts(spy, scope)).toEqual(await volumeFacts(sql, scope));
      expect(await resolutionFacts(spy, scope)).toEqual(await resolutionFacts(sql, scope));
      expect(modes).toEqual(["isolation level repeatable read read only", "isolation level repeatable read read only"]);
    });

    it("the dashboard shows the same figures as the brief's queries, plus the monthly trend", async () => {
      const dashboard = await operationsDashboard(sql, scope.agencyIds);
      const history = dashboard.history;
      if (!history) throw new Error("expected the synthetic history");
      // Same queries, same snapshot: the page and a brief can't disagree.
      expect(history.volume).toEqual(await volumeFacts(sql, scope));
      expect(history.resolution).toEqual(await resolutionFacts(sql, scope));
      // Northbridge per month: 1 ticket / 400 homes = 0.25 (Apr, May, Jul, Aug), 0 in Jun, 2 in Sep.
      const northbridge = history.monthly.facts.filter((f) => f.agencyId === "agency_northbridge").map((f) => [f.period, f.value]);
      expect(northbridge).toEqual([
        ["2026-04", 0.25],
        ["2026-05", 0.25],
        ["2026-06", 0],
        ["2026-07", 0.25],
        ["2026-08", 0.25],
        ["2026-09", 0.5],
      ]);
      expect(dashboard.agencies.map((a) => [a.name, a.acquiredOn])).toEqual([
        ["Northbridge Lettings", null],
        ["Riverside Homes", "2026-03-01"],
      ]);
    });

    it("a month after the history ends is 'no data', never a 100 % drop", async () => {
      // October 2026 has no portfolio data in the fixture.
      const { facts, notes } = await volumeFacts(sql, { ...scope, period: "last_closed_month" });
      expect(facts).toEqual([]);
      expect(notes).toEqual([
        "agency_northbridge: no synthetic data for 2026-10; nothing reported.",
        "agency_riverside: no synthetic data for 2026-10; nothing reported.",
      ]);
      const resolution = await resolutionFacts(sql, { ...scope, period: "last_closed_month" });
      expect(resolution.facts).toEqual([]);
    });

    it("gives the same answer whatever the database session time zone", async () => {
      // Compared against an explicit UTC session (the default session's zone depends on the
      // server: a local database may already be on Europe/Stockholm), and against a known value.
      const session = (TimeZone: string) =>
        postgres(url ?? "", { prepare: false, max: 1, onnotice: () => {}, connection: { TimeZone } });
      const utc = session("UTC");
      try {
        const expected = { volume: await volumeFacts(utc, scope), resolution: await resolutionFacts(utc, scope) };
        expect(values(expected.volume.facts)["tickets_per_100_homes.agency_northbridge.2026-Q3"]).toBe(0.33);
        for (const zone of ["Europe/Stockholm", "America/Los_Angeles", "Pacific/Auckland"]) {
          const client = session(zone);
          try {
            expect({ volume: await volumeFacts(client, scope), resolution: await resolutionFacts(client, scope) }).toEqual(expected);
          } finally {
            await client.end();
          }
        }
      } finally {
        await utc.end();
      }
    });
  });

  describe("tickets resolved or cancelled before transition dates existed", () => {
    beforeEach(reset);

    // Legacy rows can only be created with the transition trigger off, as before migration 003.
    const legacy = async (status: "resolved" | "cancelled", key: string) => {
      await sql.begin(async (tx) => {
        await tx`alter table tickets disable trigger tickets_transition_dates`;
        await tx`
          insert into tickets (agency_id, property_id, tenant_id, category, description, priority, status, policy_version,
                               idempotency_key, created_at)
          values ('agency_northbridge', 'prop_mcr_1', 'tenant_olivia', 'plumbing', 'Old', 'normal', ${status}, 1, ${key},
                  '2026-08-01T00:00:00Z')
        `;
        await tx`alter table tickets enable trigger tickets_transition_dates`;
      });
    };

    it("stay updatable (e.g. a priority escalation) while new transitions require a date", async () => {
      await legacy("resolved", "legacy-resolved");
      await sql`update tickets set priority = 'emergency', hazards = '{active_water_leak}' where idempotency_key = 'legacy-resolved'`;
      const [{ priority }] = await sql`select priority from tickets where idempotency_key = 'legacy-resolved'`;
      expect(priority).toBe("emergency");

      await repo.createTicketWithReview(ticket(await newRun()), null);
      await expect(sql`update tickets set status = 'resolved' where idempotency_key = 'same-key'`).rejects.toThrow(/resolved_at/);
      await expect(sql`update tickets set status = 'cancelled' where idempotency_key = 'same-key'`).rejects.toThrow(/cancelled_at/);
      await sql`update tickets set status = 'resolved', resolved_at = now() where idempotency_key = 'same-key'`;
    });

    it("resolved and cancelled are final: leaving them would rewrite history", async () => {
      await repo.createTicketWithReview(ticket(await newRun()), null);
      await sql`update tickets set status = 'resolved', resolved_at = now() + interval '1 day' where idempotency_key = 'same-key'`;
      await expect(
        sql`update tickets set status = 'cancelled', resolved_at = null, cancelled_at = now() + interval '2 days' where idempotency_key = 'same-key'`,
      ).rejects.toThrow(/final/);
      await expect(sql`update tickets set status = 'open', resolved_at = null where idempotency_key = 'same-key'`).rejects.toThrow(/final/);
      const [row] = await sql`select status, resolved_at from tickets where idempotency_key = 'same-key'`;
      expect(row.status).toBe("resolved");
    });

    it("a recorded resolution date can't be moved", async () => {
      await repo.createTicketWithReview(ticket(await newRun()), null);
      await sql`update tickets set status = 'resolved', resolved_at = now() + interval '1 day' where idempotency_key = 'same-key'`;
      await expect(
        sql`update tickets set resolved_at = now() + interval '30 days' where idempotency_key = 'same-key'`,
      ).rejects.toThrow(/final/);
    });

    describe("priority as of the cut-off", () => {
      const live = { dataset: "live" as const, agencyIds: ["agency_northbridge"], priority: "emergency" as const };
      const sept = { ...live, asOf: new Date("2026-10-01T00:00:00Z"), period: "last_closed_month" as const };
      // Fixed dates, so these tests give the same answer whenever they run.
      const octoberToDate = { ...live, asOf: new Date("2026-11-01T00:00:00Z"), period: "last_closed_quarter" as const };
      const factValue = async (scope: Parameters<typeof resolutionFacts>[1], key: string) =>
        Object.fromEntries((await resolutionFacts(sql, scope)).facts.map((f) => [f.key, f.value]))[key];

      const routineCreatedOn = async (createdAt: Date) => {
        const runId = await newRun();
        const { ticket: created } = await repo.createTicketWithReview({ ...ticket(runId), priority: "normal", hazards: [] }, null);
        await sql`update tickets set created_at = ${createdAt} where id = ${created.id}`;
        return { runId, id: created.id };
      };
      const routineInSeptember = () => routineCreatedOn(new Date("2026-09-10T00:00:00Z"));
      // Changes are written at real clock time (that's what is under test: their order), then
      // moved to fixed October timestamps KEEPING the order they were recorded in. The ticket and
      // the cut-off are fixed too, so the answer doesn't depend on the day the test runs.
      const pinChangesToOctober = (ticketId: string) => sql`
        update ticket_priority_changes c
        set changed_at = '2026-10-15T00:00:00Z'::timestamptz + o.rn * interval '1 second'
        from (select id, row_number() over (order by changed_at, id) as rn
              from ticket_priority_changes where ticket_id = ${ticketId}) o
        where c.id = o.id
      `;
      const emergenciesOpenOnFirstOfNovember = async () => {
        const scope = { ...live, asOf: new Date("2026-11-01T00:00:00Z"), period: "last_closed_month" as const };
        const facts = (await resolutionFacts(sql, scope)).facts;
        return facts.find((f) => f.key === "open_at_as_of_emergency.agency_northbridge.2026-10")?.value;
      };
      const routineInOctober = () => routineCreatedOn(new Date("2026-10-10T00:00:00Z"));

      it("a later escalation doesn't change the earlier report", async () => {
        await sql`update history_tracking set since = '2026-01-01' where subject = 'ticket_priority'`;
        const { runId, id } = await routineInSeptember();
        // A repeated, more severe report escalates it to emergency (real repository path), on 15 Oct.
        const escalation = await repo.createTicketWithReview(ticket(runId), {
          runId,
          agencyId: "agency_northbridge",
          tenantId: "tenant_olivia",
          source: "policy",
          reason: "emergency",
        });
        expect(escalation).toMatchObject({ duplicate: true, escalated: true });
        await sql`update ticket_priority_changes set changed_at = '2026-10-15T00:00:00Z' where ticket_id = ${id}`;

        expect(await factValue(sept, "open_at_as_of_emergency.agency_northbridge.2026-09")).toBe(0);
        expect(await factValue(octoberToDate, "open_at_as_of_emergency.agency_northbridge.2026-Q3")).toBe(1);
      });

      it("several changes in one transaction keep their order (clock time, then id)", async () => {
        await sql`update history_tracking set since = '2026-01-01' where subject = 'ticket_priority'`;
        const { id } = await routineInOctober();
        await sql.begin(async (tx) => {
          await tx`update tickets set priority = 'high' where id = ${id}`;
          await tx`update tickets set priority = 'emergency' where id = ${id}`;
        });
        const changes = await sql`select from_priority, to_priority from ticket_priority_changes where ticket_id = ${id} order by changed_at, id`;
        expect(changes.map((c) => `${c.from_priority}->${c.to_priority}`)).toEqual(["normal->high", "high->emergency"]);
        await pinChangesToOctober(id);
        expect(await emergenciesOpenOnFirstOfNovember()).toBe(1);
      });

      it("concurrent escalations are recorded in the order they happened, not by transaction start", async () => {
        await sql`update history_tracking set since = '2026-01-01' where subject = 'ticket_priority'`;
        const { id } = await routineInOctober();
        // Transaction A starts first (its now() is earlier) but escalates last.
        let started!: () => void;
        let proceed!: () => void;
        const aStarted = new Promise<void>((r) => (started = r));
        const aMayContinue = new Promise<void>((r) => (proceed = r));
        const a = sql.begin(async (tx) => {
          await tx`select now()`;
          started();
          await aMayContinue;
          await tx`update tickets set priority = 'emergency' where id = ${id}`;
        });
        await aStarted;
        await sql`update tickets set priority = 'high' where id = ${id}`; // B: normal -> high, committed
        proceed();
        await a; // A: high -> emergency, committed after B

        const [{ priority }] = await sql`select priority from tickets where id = ${id}`;
        expect(priority).toBe("emergency");
        await pinChangesToOctober(id);
        expect(await emergenciesOpenOnFirstOfNovember()).toBe(1);
      });

      it("before priority changes were recorded, an unexplained priority is unknown, not today's", async () => {
        // Tracking starts 1 Nov; the ticket was created in September and is an emergency today,
        // but nothing records when it became one.
        await sql`update history_tracking set since = '2026-11-01' where subject = 'ticket_priority'`;
        const runId = await newRun();
        const { ticket: created } = await repo.createTicketWithReview(ticket(runId), null);
        await sql`update tickets set created_at = '2026-09-10T00:00:00Z' where id = ${created.id}`;

        expect(await factValue(sept, "open_at_as_of_emergency.agency_northbridge.2026-09")).toBe(0);
        expect(await factValue(sept, "priority_unknown_at_cut_off_emergency.agency_northbridge.2026-09")).toBe(1);
        // After tracking started, today's priority is known to hold.
        expect(await factValue(octoberToDate, "open_at_as_of_emergency.agency_northbridge.2026-Q3")).toBe(1);
      });
    });

    it("a cancellation date can't be erased", async () => {
      await repo.createTicketWithReview(ticket(await newRun()), null);
      await sql`update tickets set status = 'cancelled', cancelled_at = now() where idempotency_key = 'same-key'`;
      await expect(sql`update tickets set cancelled_at = null where idempotency_key = 'same-key'`).rejects.toThrow(/never erased/);
    });

    it("a known resolution or cancellation date can't be erased", async () => {
      await repo.createTicketWithReview(ticket(await newRun()), null);
      await sql`update tickets set status = 'resolved', resolved_at = now() where idempotency_key = 'same-key'`;
      await expect(sql`update tickets set resolved_at = null where idempotency_key = 'same-key'`).rejects.toThrow(/never erased/);
      await expect(sql`update tickets set resolved_at = null where idempotency_key = 'same-key'`).rejects.toThrow(/final|never erased/);
      // A legacy row may keep its unknown date.
      await legacy("resolved", "legacy-resolved");
      await sql`update tickets set resolved_at = null, priority = 'high' where idempotency_key = 'legacy-resolved'`;
    });

    it("are reported apart, never as open or as a duration", async () => {
      await legacy("resolved", "legacy-resolved");
      await legacy("cancelled", "legacy-cancelled");
      const { facts } = await resolutionFacts(sql, {
        dataset: "live",
        asOf: new Date("2026-11-01T00:00:00Z"),
        period: "last_closed_quarter",
        agencyIds: ["agency_northbridge"],
      });
      const v = Object.fromEntries(facts.map((f) => [f.key, f.value]));
      expect(v).toMatchObject({
        "tickets_in_cohort.agency_northbridge.2026-Q3": 0,
        "open_at_as_of.agency_northbridge.2026-Q3": 0,
        "resolved_without_date.agency_northbridge.2026-Q3": 1,
        "cancelled_without_date.agency_northbridge.2026-Q3": 1,
      });
      expect(v["median_hours_to_resolve.agency_northbridge.2026-Q3"]).toBeUndefined();
    });
  });

  describe("operations port on PostgreSQL", () => {
    beforeEach(reset);

    it("open now counts live tickets in scope, emergencies, their age and pending reviews", async () => {
      const runId = await newRun();
      const review = { runId, agencyId: "agency_northbridge", tenantId: "tenant_olivia", source: "policy" as const, reason: "emergency" };
      const { ticket: open } = await repo.createTicketWithReview(ticket(runId), review);
      await sql`update tickets set created_at = now() - interval '5 hours' where id = ${open.id}`;
      const { ticket: done } = await repo.createTicketWithReview({ ...ticket(runId), idempotencyKey: "done", priority: "normal", hazards: [] }, null);
      await sql`update tickets set status = 'resolved', resolved_at = now() where id = ${done.id}`;
      // A Harbour Lane emergency outside the scope.
      await repo.createTicketWithReview({ ...ticket(runId), idempotencyKey: "hl", agencyId: "agency_harbour_lane", propertyId: "prop_bri_1", tenantId: "tenant_priya" }, null);

      const { facts } = await readOpenNow(sql, ["agency_northbridge", "agency_riverside"]);
      const v = Object.fromEntries(facts.map((f) => [f.key, f.value]));
      expect(v).toMatchObject({
        "open_now.agency_northbridge.now": 1,
        "open_now_emergency.agency_northbridge.now": 1,
        "reviews_pending.agency_northbridge.now": 1,
        "open_now.agency_riverside.now": 0,
        "open_now_emergency.all.now": 1,
      });
      expect(v["oldest_open_emergency_hours.agency_northbridge.now"]).toBeCloseTo(5, 0);
      expect(Object.keys(v).some((k) => k.includes("harbour"))).toBe(false);
    });

    it("without demonstration history, the dashboard still shows live open tickets", async () => {
      const runId = await newRun();
      await repo.createTicketWithReview(ticket(runId), { runId, agencyId: "agency_northbridge", tenantId: "tenant_olivia", source: "policy", reason: "emergency" });
      const dashboard = await operationsDashboard(sql, ["agency_northbridge"]);
      expect(dashboard.history).toBeNull();
      const v = Object.fromEntries(dashboard.openNow.facts.map((f) => [f.key, [f.value, f.unit]]));
      expect(v["open_now_emergency.agency_northbridge.now"]).toEqual([1, "tickets"]);
      expect(v["reviews_pending.agency_northbridge.now"]).toEqual([1, "reviews"]);
    });

    it("the attention queue lists open tickets in scope, emergencies first, oldest first, with the pending review", async () => {
      const runId = await newRun();
      const make = async (key: string, priority: "emergency" | "normal", hoursAgo: number, extra: Partial<NewTicket> = {}) => {
        const review = priority === "emergency"
          ? { runId, agencyId: extra.agencyId ?? "agency_northbridge", tenantId: extra.tenantId ?? "tenant_olivia", source: "policy" as const, reason: "emergencies always require human review" }
          : null;
        const { ticket: t } = await repo.createTicketWithReview({ ...ticket(runId), idempotencyKey: key, priority, ...extra }, review);
        await sql`update tickets set created_at = now() - make_interval(hours => ${hoursAgo}) where id = ${t.id}`;
        return t.id;
      };
      const routineOld = await make("routine-old", "normal", 30);
      const emergencyNew = await make("emergency-new", "emergency", 2);
      const emergencyOld = await make("emergency-old", "emergency", 10);
      const resolved = await make("resolved", "normal", 50);
      await sql`update tickets set status = 'resolved', resolved_at = now() where id = ${resolved}`;
      // Outside the scope.
      await make("hl", "emergency", 40, { agencyId: "agency_harbour_lane", propertyId: "prop_bri_1", tenantId: "tenant_priya" });

      const queue = await readAttentionQueue(sql, ["agency_northbridge"]);
      expect(queue.total).toBe(3);
      expect(queue.items.map((i) => i.ticketId)).toEqual([emergencyOld, emergencyNew, routineOld]);
      expect(queue.items[0]).toMatchObject({
        agencyName: "Northbridge Lettings",
        address: "Flat 4, 18 Mill Lane",
        tenantName: "Olivia Bennett",
        runId,
        pendingReview: "emergencies always require human review",
      });
      expect(queue.items[0].ageHours).toBeCloseTo(10, 0);
      expect(queue.items[2].pendingReview).toBeNull();
      // The limit keeps the most urgent and reports the total.
      const top = await readAttentionQueue(sql, ["agency_northbridge"], 1);
      expect([top.total, top.items.map((i) => i.ticketId)]).toEqual([3, [emergencyOld]]);
    });

    it("a run's outcome attributes escalations from the tool's recorded result, not from reviews", async () => {
      const traced = (requestId: string, script: ConstructorParameters<typeof ScriptedModel>[0]) =>
        runAgent({
          workflow: maintenanceWorkflow,
          model: new ScriptedModel(script),
          deps: { repo },
          actorId: "tenant_olivia",
          requestId,
          userMessage: "Water is pouring through my ceiling",
          trace: { store: new PostgresTraceStore(sql), meta: { source: "portal", agencyId: "agency_northbridge", tenantId: "tenant_olivia" } },
        });
      const create = (hazards: string[]) => ({
        toolCalls: [{ name: "create_maintenance_ticket", args: { property_id: "prop_mcr_1", category: "plumbing", hazards, location: null, description: "Leak" } }],
      });
      // A creates a routine ticket; B (a retry of the same request) escalates it to emergency.
      const a = await traced("req-same", [create([]), { text: "Logged." }]);
      const b = await traced("req-same", [create(["active_water_leak"]), { text: "Escalated." }]);
      const [ticketRow] = await sql`select id from tickets`;
      // C asks for a person about the (existing) ticket: a review, not an escalation.
      const c = await traced("req-other", [
        { toolCalls: [{ name: "request_human_review", args: { reason: "Tenant upset", ticket_id: ticketRow.id } }] },
        { text: "A person will call you." },
      ]);

      const byRun = Object.fromEntries((await listRuns(sql)).map((r) => [r.id, r.outcome]));
      expect(byRun[a.runId].tickets).toMatchObject([{ id: ticketRow.id, escalated: false }]);
      expect(byRun[b.runId].tickets).toMatchObject([{ id: ticketRow.id, priority: "emergency", escalated: true }]);
      expect(byRun[c.runId]).toMatchObject({ tickets: [], reviewsTotal: 1, reviewsPending: 1 });
      expect((await getRunDetail(sql, c.runId))?.tickets).toEqual([]);
      expect((await getRunDetail(sql, b.runId))?.tickets).toMatchObject([{ escalated: true, status: "open" }]);
    });

    it("the attention queue also lists people requested without a ticket", async () => {
      const runId = await newRun();
      await repo.createReview({ runId, agencyId: "agency_northbridge", tenantId: "tenant_olivia", ticketId: null, source: "agent", reason: "Asked about withholding rent" });
      const queue = await readAttentionQueue(sql, ["agency_northbridge"]);
      expect(queue.total).toBe(0);
      expect(queue.reviewsWithoutTicket).toMatchObject([
        { agencyName: "Northbridge Lettings", tenantName: "Olivia Bennett", reason: "Asked about withholding rent", runId },
      ]);
      expect(await readAttentionQueue(sql, ["agency_harbour_lane"])).toMatchObject({ total: 0, reviewsWithoutTicket: [] });
    });

    it("loads a manager's scope from the database, and null for an unknown one", async () => {
      expect(await managerScope(sql, "manager_north")).toEqual({
        managerId: "manager_north",
        name: "Alex Morgan (North region)",
        agencyIds: ["agency_northbridge", "agency_riverside"],
      });
      expect(await managerScope(sql, "manager_nobody")).toBeNull();
    });

    it("computes briefs on the synthetic history, with the cut-off read in the same snapshot", async () => {
      const operations = new PostgresOperations(sql);
      const query = { period: "last_closed_quarter" as const, agencyIds: ["agency_riverside"] };
      await expect(operations.volume(query)).rejects.toThrow(/seed:history/);
      await replaceSyntheticHistory(sql, generateHistory(demoHistoryAgencies()));

      const modes: string[] = [];
      const spy = {
        begin: (mode: string, fn: never) => {
          modes.push(mode);
          return sql.begin(mode, fn);
        },
      } as unknown as postgres.Sql;
      const report = await new PostgresOperations(spy).volume(query);
      // Cut-off and facts come from one repeatable-read transaction.
      expect(modes).toEqual(["isolation level repeatable read read only"]);
      expect([report.dataset, report.asOf.toISOString()]).toEqual(["synthetic", "2026-11-01T00:00:00.000Z"]);
      expect(report.facts.every((f) => f.agencyId === "agency_riverside" || f.agencyId === "all")).toBe(true);
      expect(report.facts[0].period).toBe("2026-Q3");
      expect(await operations.agencyNames(["agency_riverside"])).toEqual({ agency_riverside: "Riverside Homes" });
    });
  });
});
