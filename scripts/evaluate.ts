import { evaluators } from "@/evaluators";
import { getSql } from "@/infra/db";
import { backfillEvaluations } from "@/infra/evaluation-store";
import { parseSince, sinceArg } from "./evaluate-args";

// `pnpm evaluate [--since 24h|7d|all]` — evaluates stored runs that have no usable verdict for
// the current evaluator versions: missed by the online hook, evaluated by an older version, or
// `error`. Idempotent: running it twice evaluates nothing the second time.

async function main() {
  const since = parseSince(sinceArg(process.argv.slice(2)));
  try {
    process.loadEnvFile(".env.local");
  } catch {}
  const sql = getSql();
  try {
    const report = await backfillEvaluations(sql, evaluators, since);
    const v = report.verdicts;
    console.log(
      `Evaluated ${report.runs} run(s) with ${evaluators.map((e) => `${e.id}@v${e.version}`).join(", ")}\n` +
        `  pass ${v.pass} · fail ${v.fail} · n/a ${v["n/a"]} · error ${v.error}`,
    );
  } finally {
    await sql.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
