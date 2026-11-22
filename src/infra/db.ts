import postgres from "postgres";

// One client per process, reused across hot reloads in development.
// `prepare: false` keeps it compatible with Supabase's transaction pooler.
const globalForDb = globalThis as unknown as { sql?: postgres.Sql };

export function getSql(): postgres.Sql {
  if (globalForDb.sql) return globalForDb.sql;

  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");

  globalForDb.sql = postgres(url, { prepare: false, max: 5 });
  return globalForDb.sql;
}
