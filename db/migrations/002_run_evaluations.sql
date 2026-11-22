-- Horizontal evaluation verdicts: one row per run × evaluator × evaluator version.
-- Versioned so a logic change never mixes old and new verdicts; upserted so re-evaluating
-- (online hook, backfill retry) is idempotent.
create table run_evaluations (
  run_id            uuid not null references runs(id) on delete cascade,
  evaluator_id      text not null,
  evaluator_version int  not null,
  verdict           text not null check (verdict in ('pass', 'fail', 'n/a', 'error')),
  evidence          text not null default '',
  evaluated_at      timestamptz not null default now(),
  primary key (run_id, evaluator_id, evaluator_version)
);

-- Triage: "show me the runs this evaluator flagged".
create index run_evaluations_flagged_idx on run_evaluations (evaluator_id, evaluator_version)
  where verdict in ('fail', 'error');

-- Same as every other table: no Data API access, the app connects as owner.
alter table run_evaluations enable row level security;
