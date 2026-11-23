-- Details a tenant adds to an open ticket ("it's still leaking", "there's no hot water either").
-- Before this, a follow-up could only become a new ticket. An update never downgrades the
-- ticket; when it raises the priority (new hazards), raised_priority records it and the
-- priority change is logged by the existing tickets trigger.
create table ticket_updates (
  id               uuid primary key default gen_random_uuid(),
  ticket_id        uuid not null references tickets(id),
  run_id           uuid references runs(id),
  tenant_id        text not null references tenants(id),
  -- add_details_to_ticket allows 2000 characters; a create redirected by the duplicate guard
  -- stores "location: description" (200 + 2 + 2000), so the column allows that and a margin.
  details          text not null check (length(details) between 1 and 2400),
  hazards          text[] not null default '{}',
  raised_priority  boolean not null default false,
  -- Retries of the same request add the details once.
  idempotency_key  text not null unique,
  created_at       timestamptz not null default now()
);

create index ticket_updates_ticket_idx on ticket_updates (ticket_id, created_at);
create index ticket_updates_run_idx on ticket_updates (run_id);

alter table ticket_updates enable row level security;
