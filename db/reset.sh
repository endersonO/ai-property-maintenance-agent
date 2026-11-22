#!/usr/bin/env bash
# Usage: DATABASE_URL=postgres://... db/reset.sh
# Drops only HomeFix tables (safe on Supabase), then applies migrations and seed.
set -euo pipefail
: "${DATABASE_URL:?DATABASE_URL is required}"
cd "$(dirname "$0")"

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -c \
  "drop table if exists review_queue, tickets, run_events, runs, tenants, properties, policies, agencies cascade;"

for f in migrations/*.sql; do
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f "$f"
done
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f seed.sql

echo "Database reset: $(psql "$DATABASE_URL" -Atc 'select count(*) from tenants') tenants seeded"
