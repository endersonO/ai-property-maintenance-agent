---
description: Run the evals, separate real regressions from noise, and report
argument-hint: [executor|agent] [case ids]
---

Run HomeFix evals and review the results. Arguments: `$ARGUMENTS` (default: executor).

1. **Executor evals** (deterministic, scripted model): `pnpm evals`.
   - Any FAIL is a regression in our code. Read the printed trace: which stage stopped the call, expected vs actual. Find the cause in the code; do not loosen the check to make it pass.
2. **Agent evals** (real model, spend API quota — Gemini free tier: 15 requests/minute, 500/day): `pnpm evals --layer agent [--case A1,A8] [--repeats N]`.
   - Use `--repeats 1` while iterating; 3 for a measurement.
   - Infra errors (quota, network, timeout) are reported separately and are not model failures.
   - For each failing attempt, classify it: **model decision** (wrong tool, missed hazard, unsupported claim), **eval bug** (the check rejects a correct reply or accepts a wrong one — fix the check and add a heuristic test), or **infrastructure**.
3. Report a table: case, result, classification, and the one-line evidence from the trace. Never report a pass rate without saying how many runs it is based on and how many were excluded as infra errors.
