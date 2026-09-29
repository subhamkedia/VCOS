-- 0005_firm_workspace.sql
-- What a firm configures: its thesis (versioned), its connections to outside
-- tools, and the sourcing feeds that run on a cadence.

-- The firm profile: fund, mandate, sectors, scoring. Append-only: each save
-- is a new version, so every score can name the thesis it was scored against.
create table thesis_versions (
  firm_id     uuid not null default current_firm() references firms(id) on delete cascade,
  version     integer not null check (version > 0),
  profile     jsonb not null,
  created_by  text not null,
  created_at  timestamptz not null default now(),
  primary key (firm_id, version)
);

-- One row per connected tool. Credentials are encrypted by the app
-- (AES-256-GCM, key from VCOS_SECRET_KEY) before they reach this table.
create table connections (
  firm_id          uuid not null default current_firm() references firms(id) on delete cascade,
  connector_id     text not null,
  status           text not null default 'connected' check (status in ('connected', 'error', 'disconnected')),
  credentials      text,                 -- ciphertext, never plaintext
  account_label    text,                 -- "partner@fund.com", "Affinity: Alpha Ventures"
  connected_by     text not null,
  connected_at     timestamptz not null default now(),
  last_checked_at  timestamptz,
  last_error       text,
  primary key (firm_id, connector_id)
);

-- A sourcing feed: pull new companies from one connector on a cadence.
create table sourcing_feeds (
  id            uuid primary key default gen_random_uuid(),
  firm_id       uuid not null default current_firm() references firms(id) on delete cascade,
  connector_id  text not null,
  name          text not null,
  params        jsonb not null default '{}'::jsonb,
  cadence       text not null check (cadence in ('hourly', 'daily', 'weekly', 'monthly', 'manual')),
  enabled       boolean not null default true,
  next_run_at   timestamptz,
  created_by    text not null,
  created_at    timestamptz not null default now()
);
create index sourcing_feeds_due on sourcing_feeds(next_run_at) where enabled;

create table job_runs (
  id           uuid primary key default gen_random_uuid(),
  firm_id      uuid not null default current_firm() references firms(id) on delete cascade,
  feed_id      uuid references sourcing_feeds(id) on delete cascade,
  kind         text not null,
  status       text not null default 'running' check (status in ('running', 'done', 'failed')),
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  stats        jsonb not null default '{}'::jsonb,
  error        text,
  triggered_by text not null
);
create index job_runs_feed on job_runs(feed_id, started_at desc);

-- Companies a sourcing run touched, with their thesis fit at that moment.
create table sourcing_hits (
  id              uuid primary key default gen_random_uuid(),
  firm_id         uuid not null default current_firm() references firms(id) on delete cascade,
  run_id          uuid not null references job_runs(id) on delete cascade,
  feed_id         uuid references sourcing_feeds(id) on delete cascade,
  entity_id       uuid not null references entities(id),
  is_new          boolean not null,
  fit_score       integer,
  fit_verdict     text,
  thesis_version  integer,
  fit             jsonb,
  created_at      timestamptz not null default now()
);
create index sourcing_hits_entity on sourcing_hits(entity_id, created_at desc);
create index sourcing_hits_recent on sourcing_hits(firm_id, created_at desc);

do $$
declare
  t text;
begin
  foreach t in array array['thesis_versions', 'connections', 'sourcing_feeds', 'job_runs', 'sourcing_hits'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy firm_isolation on %I using (firm_id = current_firm()) with check (firm_id = current_firm())', t);
  end loop;
end $$;

grant select, insert on thesis_versions to vcos_app;
grant select, insert, update, delete on connections, sourcing_feeds, job_runs, sourcing_hits to vcos_app;
