#!/usr/bin/env bash
# Usage: DATABASE_URL=postgres://... db/reset.sh
# Drops only HomeFix tables (safe on Supabase), then applies migrations and seed.
set -euo pipefail
: "${DATABASE_URL:?DATABASE_URL is required}"
cd "$(dirname "$0")"

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -c \
  "drop view if exists ops.operations_tickets; drop function if exists tickets_require_transition_dates() cascade; drop function if exists tickets_record_priority_change() cascade; drop table if exists history_tracking, ticket_priority_changes, synthetic_history_meta, synthetic_portfolio, synthetic_tickets, manager_agencies, managers, run_evaluations, review_queue, tickets, run_events, runs, tenants, properties, policies, agencies cascade;"

# Each migration is atomic (-1): it applies completely or not at all, and nothing it installs
# (e.g. a trigger and the mark of when it started recording) can be seen half-done.
for f in migrations/*.sql; do
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -1 -f "$f"
done
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f seed.sql

echo "Database reset: $(psql "$DATABASE_URL" -Atc 'select count(*) from tenants') tenants seeded"
