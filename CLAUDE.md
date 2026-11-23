# HomeFix Agent

Portfolio prototype: AI maintenance assistant for UK residential lettings, built on a reusable agent runtime with deterministic guardrails, evals and tracing. See `README.md` for the design.

Before making design or scope decisions, read `memory/` if present (start at `memory/README.md`). It holds local working notes and is not committed.

## Core rules

- **All files must be written in English** (code, comments, docs, `memory/`, diagrams, commit messages).
- The LLM proposes; deterministic code decides (permissions, priority, idempotency, agency policy); humans approve risky cases.
- `src/runtime/` is generic: it must not import from `src/domain/` or `src/workflows/`. New workflows go in `src/workflows/<id>/` — use `/add-workflow`.
- Agency policies are data, not code. Platform invariants (e.g. every emergency is reviewed by a person) live in code.
- Tool input schemas are strict; optional fields are nullable. Identity comes from the session, never from tool arguments.
- All data is synthetic. UK context: £, UK addresses, letting agent / landlord / tenant. Public files never name a real company.
- Next.js 16 with Cache Components: read `node_modules/next/dist/docs/` before writing Next code; database reads in pages need `<Suspense>` (and `connection()` when nothing else is request-time).

## Commands

- `pnpm typecheck && pnpm lint && pnpm test` — unit, contract and integration tests (integration needs `TEST_DATABASE_URL`) plus executor evals.
- `pnpm evals` — executor evals report (scripted model, deterministic, gates CI).
- `pnpm evals --layer agent [--case A1,A8] [--repeats N]` — agent evals with the real model. They spend API quota (Gemini free tier: 15 requests/minute, 500/day): iterate with `--repeats 1`. Use `/run-evals` to triage.
- `pnpm try "<message>" [tenant_id]` — one real-model run with its trace.
- `pnpm evaluate [--since 24h|7d|all]` — horizontal evaluation backfill: evaluates stored runs missing a verdict for the current evaluator versions (or with `error`). Idempotent. Evaluators live in `src/evaluators/`; bump `version` when their logic changes.
- `pnpm db:reset` — migrate and seed the database in `.env.local`.
