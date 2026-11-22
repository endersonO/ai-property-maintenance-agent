# HomeFix AI Agent

Portfolio prototype: AI agent for UK residential lettings maintenance, built on a reusable agent runtime with evals and tracing.

Before making design or scope decisions, read `memory/` if present (start at `memory/README.md`). It holds local working notes and is not committed.

Core rules:
- **All files must be written in English** (code, comments, docs, `memory/`, diagrams, commit messages).
- The LLM proposes; deterministic code decides (permissions, priority, idempotency, agency policy); humans approve risky cases.
- Keep the runtime (orchestrator, executor, tracing, evals) separate from workflow definitions.
- Agency policies are data, not code.
- All data is synthetic. UK context: £, UK addresses, letting agent / landlord / tenant.
