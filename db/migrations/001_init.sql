-- HomeFix initial schema.
-- Domain: agencies, policies, properties, tenants, tickets
-- Humans: review_queue
-- Observability: runs, run_events

create table agencies (
  id          text primary key,
  name        text not null,
  created_at  timestamptz not null default now()
);

-- Versioned per-agency policy. Rules are JSON validated with Zod in the app.
create table policies (
  id          uuid primary key default gen_random_uuid(),
  agency_id   text not null references agencies(id),
  version     int  not null,
  rules       jsonb not null,
  active      boolean not null default false,
  created_at  timestamptz not null default now(),
  unique (agency_id, version)
);

-- At most one active policy per agency.
create unique index policies_one_active_per_agency
  on policies (agency_id) where active;

create table properties (
  id          text primary key,
  agency_id   text not null references agencies(id),
  address     text not null,
  city        text not null,
  postcode    text not null
);

create table tenants (
  id           text primary key,
  name         text not null,
  email        text not null unique,
  property_id  text not null references properties(id)
);

-- Created at the start of each run (status 'running'), finalised at the end.
create table runs (
  id             uuid primary key default gen_random_uuid(),
  workflow_id    text not null,
  agency_id      text references agencies(id),
  tenant_id      text references tenants(id),
  -- Stable per tenant message; retries of the same request reuse it.
  request_id     text not null,
  source         text not null check (source in ('portal', 'eval')),
  eval_case_id   text,
  model          text not null,
  temperature    numeric(3, 2),
  status         text not null default 'running'
                 check (status in ('running', 'completed', 'failed')),
  input          jsonb not null,
  output         text,
  steps          int not null default 0,
  input_tokens   int,
  output_tokens  int,
  cost_usd       numeric(10, 6),
  duration_ms    int,
  error          text,
  created_at     timestamptz not null default now()
);

create index runs_created_at_idx on runs (created_at desc);

create table run_events (
  id           bigint generated always as identity primary key,
  run_id       uuid not null references runs(id) on delete cascade,
  seq          int  not null,
  type         text not null
               check (type in ('model_call', 'tool_call', 'policy_decision', 'error')),
  tool_name    text,
  -- Where the executor stopped or acted.
  stage        text
               check (stage in ('validate', 'authorize', 'policy', 'idempotency', 'execute')),
  status       text not null check (status in ('ok', 'rejected', 'error')),
  payload      jsonb not null default '{}'::jsonb, -- redacted before insert
  duration_ms  int,
  created_at   timestamptz not null default now(),
  unique (run_id, seq)
);

create table tickets (
  id                  uuid primary key default gen_random_uuid(),
  agency_id           text not null references agencies(id),
  property_id         text not null references properties(id),
  tenant_id           text not null references tenants(id),
  run_id              uuid references runs(id),
  category            text not null
                      check (category in ('plumbing', 'electrical', 'heating', 'appliance',
                                          'structural', 'pest', 'other')),
  hazards             text[] not null default '{}'
                      check (hazards <@ array['active_water_leak', 'gas_smell', 'no_heating',
                                              'no_hot_water', 'electrical_hazard',
                                              'security_risk']::text[]),
  location            text,
  description         text not null,
  priority            text not null check (priority in ('emergency', 'high', 'normal', 'low')),
  status              text not null default 'open'
                      check (status in ('open', 'in_progress', 'resolved', 'cancelled')),
  estimated_cost_gbp  numeric(10, 2),
  policy_version      int not null,
  -- sha256(request_id | property_id | category): dedupes retries, never merges separate requests.
  idempotency_key     text not null unique,
  created_at          timestamptz not null default now()
);

create index tickets_tenant_idx on tickets (tenant_id, created_at desc);

-- Every review has an owner, with or without a ticket.
create table review_queue (
  id          uuid primary key default gen_random_uuid(),
  run_id      uuid not null references runs(id),
  agency_id   text not null references agencies(id),
  tenant_id   text not null references tenants(id),
  ticket_id   uuid references tickets(id),
  source      text not null check (source in ('policy', 'agent')),
  reason      text not null,
  status      text not null default 'pending'
              check (status in ('pending', 'approved', 'rejected')),
  created_at  timestamptz not null default now()
);

create index review_queue_pending_idx on review_queue (created_at) where status = 'pending';

-- Supabase exposes the public schema through its Data API (anon key).
-- The app connects as the table owner via postgres.js, which bypasses RLS.
-- RLS enabled with no policies = the Data API cannot read or write these tables;
-- every write goes through the Tool Executor.
alter table agencies     enable row level security;
alter table policies     enable row level security;
alter table properties   enable row level security;
alter table tenants      enable row level security;
alter table runs         enable row level security;
alter table run_events   enable row level security;
alter table tickets      enable row level security;
alter table review_queue enable row level security;
