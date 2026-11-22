import { getSql } from "@/infra/db";
import { replaceSyntheticHistory } from "@/infra/operations-store";
import { DEFAULT_HISTORY, demoHistoryAgencies, generateHistory } from "@/operations/history";

// `pnpm seed:history` — (re)generates the synthetic operations history in DATABASE_URL.
// Deterministic (fixed seed and asOf); replaces only synthetic rows, in one transaction.

async function main() {
  try {
    process.loadEnvFile(".env.local");
  } catch {}
  const sql = getSql();
  try {
    const history = generateHistory(demoHistoryAgencies(), DEFAULT_HISTORY);
    const { tickets } = await replaceSyntheticHistory(sql, history);
    console.log(
      `Synthetic history: ${tickets} tickets, ${DEFAULT_HISTORY.months} closed months before ${DEFAULT_HISTORY.asOf.toISOString().slice(0, 10)} (seed ${DEFAULT_HISTORY.seed})`,
    );
  } finally {
    await sql.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
