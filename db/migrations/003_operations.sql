-- Who acted in a run. Tenants also fill runs.tenant_id; managers (operations brief) act
-- across agencies and only have an actor id.
alter table runs add column actor_id text;
update runs set actor_id = tenant_id where actor_id is null;

-- Agency lifecycle, for agencies joined by acquisition: when the business was acquired, from
-- when its history is available, and when it was onboarded onto the platform.
alter table agencies
  add column acquired_on       date,
  add column history_starts_on date,
  add column onboarded_on      date;

-- When a ticket was resolved or cancelled, so reports can rebuild the state at any cut-off
-- date. Live tickets have no resolution process yet (that needs the agency review screen).
-- A date always implies its status (checks). The reverse — "becoming resolved/cancelled
-- requires a date" — is a trigger on the transition, not a check: tickets resolved or
-- cancelled before these columns existed keep an unknown date (reported apart, never as a
-- duration) and their other fields stay updatable, e.g. a priority escalation.
alter table tickets
  add column resolved_at  timestamptz,
  add column cancelled_at timestamptz,
  add constraint tickets_resolved_after_created check (resolved_at is null or resolved_at >= created_at),
  add constraint tickets_cancelled_after_created check (cancelled_at is null or cancelled_at >= created_at),
  add constraint tickets_dated_means_resolved check (resolved_at is null or status = 'resolved'),
  add constraint tickets_dated_means_cancelled check (cancelled_at is null or status = 'cancelled');

create function tickets_require_transition_dates() returns trigger
language plpgsql set search_path = pg_catalog as $$
-- Resolved and cancelled are terminal: without a transitions log, leaving them would destroy
-- the history a report at an earlier cut-off needs (reopening belongs with the agency review
-- iteration, as recorded events). A missing date is only acceptable where it was already
-- missing (a legacy row keeping its status); becoming resolved/cancelled needs a date, and a
-- known date can't be erased.
begin
  if tg_op = 'UPDATE' and old.status in ('resolved', 'cancelled') and new.status is distinct from old.status then
    raise exception 'ticket % is %: resolved and cancelled are final', old.id, old.status
      using errcode = 'check_violation';
  end if;
  if new.status = 'resolved' and new.resolved_at is null
     and (tg_op = 'INSERT' or old.status is distinct from 'resolved' or old.resolved_at is not null) then
    raise exception 'a resolved ticket needs resolved_at (set when it is resolved, never erased)'
      using errcode = 'check_violation';
  end if;
  if new.status = 'cancelled' and new.cancelled_at is null
     and (tg_op = 'INSERT' or old.status is distinct from 'cancelled' or old.cancelled_at is not null) then
    raise exception 'a cancelled ticket needs cancelled_at (set when it is cancelled, never erased)'
      using errcode = 'check_violation';
  end if;
  -- A recorded date is final too: moving it would silently change past reports. Rectifications
  -- need an event log (agency review iteration).
  if tg_op = 'UPDATE' and (
       (old.resolved_at is not null and new.resolved_at is distinct from old.resolved_at)
    or (old.cancelled_at is not null and new.cancelled_at is distinct from old.cancelled_at)) then
    raise exception 'ticket %: a recorded resolution or cancellation date is final', old.id
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger tickets_transition_dates
  before insert or update of status, resolved_at, cancelled_at on tickets
  for each row execute function tickets_require_transition_dates();

-- Every priority change, recorded by the database whatever code makes it (e.g. an escalation by
-- a repeated report), so a report can use the priority a ticket had at its cut-off date.
create table ticket_priority_changes (
  id            bigint generated always as identity primary key,
  ticket_id     uuid not null references tickets(id) on delete cascade,
  from_priority text not null,
  to_priority   text not null,
  -- clock_timestamp(), not now(): now() is the transaction start, so two escalations in
  -- concurrent transactions could be recorded out of order. Ties are broken by id.
  changed_at    timestamptz not null default clock_timestamp()
);

create index ticket_priority_changes_ticket_idx on ticket_priority_changes (ticket_id, changed_at, id);

create function tickets_record_priority_change() returns trigger
language plpgsql set search_path = public, pg_catalog as $$
begin
  insert into ticket_priority_changes (ticket_id, from_priority, to_priority, changed_at)
  values (new.id, old.priority, new.priority, clock_timestamp());
  return new;
end;
$$;

-- Block writes to tickets for the rest of this transaction before the trigger exists.
lock table tickets in share row exclusive mode;

create trigger tickets_priority_history
  after update of priority on tickets
  for each row when (new.priority is distinct from old.priority)
  execute function tickets_record_priority_change();

-- Since when each kind of history is recorded. Before it, a ticket's priority at a cut-off is
-- unknown unless a recorded change explains it (changes before this migration weren't logged).
-- The mark is only true if no write slips between it and the trigger: the migration runs in one
-- transaction (db/reset.sh applies each file with psql -1), the trigger above holds a lock that
-- blocks writes to tickets until commit, and the mark is the clock time after taking it.
create table history_tracking (
  subject text primary key,
  since   timestamptz not null
);
insert into history_tracking (subject, since) values ('ticket_priority', clock_timestamp());

-- Managers see aggregates for the agencies they are authorised for. Set by the server from
-- the (simulated) session; a tool argument can narrow this scope, never widen it.
create table managers (
  id   text primary key,
  name text not null
);

create table manager_agencies (
  manager_id text not null references managers(id),
  agency_id  text not null references agencies(id),
  primary key (manager_id, agency_id)
);

-- Generated history for the operations view. Its own table, so no interactive flow (portal,
-- ticket-status, repository) can ever read it by accident. Policy decisions are stored on the
-- row (priority, estimated cost, sent_to_review): no fake reviews or runs, no references
-- into interactive tables. Regenerated as a whole by `pnpm seed:history`.
create table synthetic_tickets (
  id                 bigint generated always as identity primary key,
  agency_id          text not null references agencies(id),
  category           text not null
                     check (category in ('plumbing', 'electrical', 'heating', 'appliance',
                                         'structural', 'pest', 'other')),
  hazards            text[] not null default '{}'
                     check (hazards <@ array['active_water_leak', 'gas_smell', 'no_heating',
                                             'no_hot_water', 'electrical_hazard',
                                             'security_risk']::text[]),
  priority           text not null check (priority in ('emergency', 'high', 'normal', 'low')),
  estimated_cost_gbp numeric(10, 2) not null,
  sent_to_review     boolean not null,
  status             text not null check (status in ('open', 'resolved', 'cancelled')),
  created_at         timestamptz not null,
  resolved_at        timestamptz,
  cancelled_at       timestamptz,
  check (resolved_at is null or resolved_at >= created_at),
  check (cancelled_at is null or cancelled_at >= created_at),
  check ((status = 'resolved') = (resolved_at is not null)),
  check ((status = 'cancelled') = (cancelled_at is not null))
);

create index synthetic_tickets_agency_created_idx on synthetic_tickets (agency_id, created_at);

-- Homes managed per agency and month, the exposure behind "tickets per 100 properties".
create table synthetic_portfolio (
  agency_id  text not null references agencies(id),
  month      date not null check (month = date_trunc('month', month)),
  properties int  not null check (properties > 0),
  primary key (agency_id, month)
);

-- What the synthetic history represents: generated with this seed, observed up to as_of.
-- Reports never infer states beyond as_of (what happened after it is unknown).
create table synthetic_history_meta (
  id           boolean primary key default true check (id),
  seed         int not null,
  as_of        timestamptz not null,
  generated_at timestamptz not null default now()
);

-- One shape for both datasets. Operations queries always choose the dataset explicitly.
-- In its own schema: Supabase's Data API only exposes `public`, and a view there would run with
-- its owner's rights and bypass RLS on the base tables. The app reads it as the owner.
create schema if not exists ops;

create view ops.operations_tickets as
  select 'live'::text as dataset, t.id as ticket_id, t.agency_id, t.category, t.priority, t.estimated_cost_gbp,
         exists (select 1 from review_queue r where r.ticket_id = t.id) as sent_to_review,
         case when t.status in ('open', 'in_progress') then 'open' else t.status end as status,
         t.created_at, t.resolved_at, t.cancelled_at
  from tickets t
  union all
  select 'synthetic', null::uuid, s.agency_id, s.category, s.priority, s.estimated_cost_gbp, s.sent_to_review,
         s.status, s.created_at, s.resolved_at, s.cancelled_at
  from synthetic_tickets s;

alter table ticket_priority_changes enable row level security;
alter table history_tracking        enable row level security;
alter table managers            enable row level security;
alter table manager_agencies    enable row level security;
alter table synthetic_tickets   enable row level security;
alter table synthetic_portfolio enable row level security;
alter table synthetic_history_meta enable row level security;
