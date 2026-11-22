---
description: Add a new agent workflow on the existing runtime, following the ticket-status pattern
argument-hint: <workflow-id> <one-line purpose>
---

Add a new workflow `$ARGUMENTS` to HomeFix **without changing `src/runtime/`**. If you believe the runtime must change, stop and explain why instead.

Use `src/workflows/ticket-status/` as the reference implementation. Read `CLAUDE.md` first.

1. **Tools** — `src/workflows/<id>/tools.ts`
   - Define each tool with `defineTool`. Input schemas are `z.strictObject`; optional fields are `.nullable()`, not `.optional()`.
   - Identity comes from `ctx.tenantId`, never from arguments.
   - Put permission checks in `authorize` (reuse `authorizeTicketOwnership` from `src/workflows/shared.ts` where it fits). Never reveal whether another tenant's record exists.
   - Anything the system must decide (priority, cost, escalation) goes in `applyPolicy`, not in the schema the model sees.
   - Writes that must be idempotent derive a key in `idempotencyKey` from `ctx.requestId`.
2. **Workflow** — `src/workflows/<id>/index.ts`: `{ id, systemPrompt, tools }`. The prompt states scope, what the model must never claim, and that it only reports facts returned by tools.
3. **Registry** — add the workflow to `src/workflows/index.ts`. `/api/chat` accepts it automatically through `workflowIds`.
4. **Evals** — `src/workflows/<id>/evals.ts`
   - Executor evals (scripted model) for every guardrail: invalid arguments, unauthorised access, idempotency, tool failure. Check executor stage/status and repository state, not just text.
   - At least one agent eval (real model) for the main happy path.
   - Register both in `evals/run.ts` and the executor evals in `src/workflows/maintenance/evals.test.ts`.
5. **Verify** — `pnpm typecheck && pnpm lint && pnpm test && pnpm evals`. Then run only the new agent evals: `pnpm evals --layer agent --case <ids> --repeats 1` (they spend API quota).
6. Report: files added, what each eval proves, and confirm `git diff --stat src/runtime` is empty.
