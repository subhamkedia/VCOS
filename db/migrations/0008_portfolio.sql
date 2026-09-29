-- 0008_portfolio.sql
-- Portfolio Management and Value Creation: KPI requests and the founder
-- portal, accounting links, valuation marks, realizations, board meetings,
-- value-creation initiatives and company contacts. KPIs themselves are
-- claims (principle 1); health ratings, reserve plans and follow-on
-- decisions are decisions (principle 5).

alter table decisions drop constraint if exists decisions_kind_check;
alter table decisions add constraint decisions_kind_check check (kind in
  ('pass', 'advance', 'ic_vote_pre', 'ic_vote_post', 'invest', 'follow_on', 'score_override', 'health_rating', 'reserve_plan'));

-- A follow-on check is another investment row on the same deal.
alter table investments add column round_kind text not null default 'initial' check (round_kind in ('initial', 'follow_on'));

-- The people at a portfolio company the firm talks to: who gets KPI
-- requests, who the firm introduces.
create table company_contacts (
  id          uuid primary key default gen_random_uuid(),
  firm_id     uuid not null default current_firm() references firms(id) on delete cascade,
  company_id  uuid not null references entities(id),
  name        text not null,
  email       text not null,
  role        text,
  reporting   boolean not null default false,   -- receives KPI requests
  created_by  text not null,
  created_at  timestamptz not null default now(),
  unique (firm_id, company_id, email)
);

-- A link a founder uses, without an account, to report numbers and
-- connect the company's accounting system. Only the token's hash is kept.
create table portal_links (
  id               uuid primary key default gen_random_uuid(),
  firm_id          uuid not null default current_firm() references firms(id) on delete cascade,
  company_id       uuid not null references entities(id),
  token_hash       text not null unique,
  expires_at       timestamptz not null,
  created_by       text not null,
  created_at       timestamptz not null default now(),
  revoked_at       timestamptz,
  last_used_at     timestamptz,
  -- An accounting OAuth flow in progress from this link.
  oauth_state      text unique,
  oauth_provider   text check (oauth_provider in ('quickbooks', 'xero')),
  oauth_verifier   text,
  oauth_expires_at timestamptz
);

-- Monthly (or quarterly) numbers the firm asked a company for.
create table kpi_requests (
  id           uuid primary key default gen_random_uuid(),
  firm_id      uuid not null default current_firm() references firms(id) on delete cascade,
  company_id   uuid not null references entities(id),
  period       text not null check (period ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  metrics      text[] not null,
  due_on       date not null,
  recipients   text[] not null default '{}',
  status       text not null default 'open' check (status in ('open', 'received', 'cancelled')),
  portal_link_id uuid references portal_links(id),
  outbox_id    uuid references outbox(id),
  evidence_id  uuid references evidence(id),
  created_by   text not null,
  created_at   timestamptz not null default now(),
  received_at  timestamptz,
  unique (firm_id, company_id, period)
);

-- A company's accounting system, connected by its founder. The refresh
-- token is encrypted (lib/secrets) and belongs to this firm only.
create table accounting_links (
  id             uuid primary key default gen_random_uuid(),
  firm_id        uuid not null default current_firm() references firms(id) on delete cascade,
  company_id     uuid not null references entities(id),
  provider       text not null check (provider in ('quickbooks', 'xero')),
  external_id    text not null,            -- QuickBooks realm id, Xero tenant id
  external_name  text,
  secret         text not null,            -- encrypted refresh token
  status         text not null default 'active' check (status in ('active', 'error', 'revoked')),
  connected_at   timestamptz not null default now(),
  portal_link_id uuid references portal_links(id),
  last_sync_at   timestamptz,
  last_error     text,
  unique (firm_id, company_id, provider)
);

-- Fair value marks. Prepared by one person, approved by another (a
-- valuation committee of at least two). Approved and rejected marks are
-- final; a new mark is a new row.
create table valuations (
  id             uuid primary key default gen_random_uuid(),
  firm_id        uuid not null default current_firm() references firms(id) on delete cascade,
  company_id     uuid not null references entities(id),
  as_of          date not null,
  method         text not null check (method in ('recent_round', 'milestone', 'revenue_multiple', 'exit', 'write_off', 'cost')),
  fair_value_usd numeric not null check (fair_value_usd >= 0),
  inputs         jsonb not null default '{}'::jsonb,
  steps          jsonb not null default '[]'::jsonb,
  warnings       jsonb not null default '[]'::jsonb,
  rationale      text not null check (length(rationale) >= 10),
  status         text not null default 'proposed' check (status in ('proposed', 'approved', 'rejected')),
  prepared_by    text not null,
  reviewed_by    text,
  reviewed_at    timestamptz,
  review_note    text,
  created_at     timestamptz not null default now(),
  check (reviewed_by is null or reviewed_by <> prepared_by)
);
create unique index valuations_one_approved on valuations(firm_id, company_id, as_of) where status = 'approved';

create or replace function valuations_final() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'valuations are kept: record a new mark instead'; end if;
  if old.status <> 'proposed' then raise exception 'this mark is final: record a new mark instead'; end if;
  if new.fair_value_usd <> old.fair_value_usd or new.method <> old.method or new.as_of <> old.as_of or new.prepared_by <> old.prepared_by
     or new.inputs <> old.inputs or new.rationale <> old.rationale then
    raise exception 'a proposed mark can only be approved or rejected';
  end if;
  return new;
end $$;
create trigger valuations_final before update or delete on valuations for each row execute function valuations_final();

-- Money back from a company: a sale, a distribution, or a write-off record.
create table realizations (
  id           uuid primary key default gen_random_uuid(),
  firm_id      uuid not null default current_firm() references firms(id) on delete cascade,
  company_id   uuid not null references entities(id),
  occurred_on  date not null,
  amount_usd   numeric not null check (amount_usd >= 0),
  kind         text not null check (kind in ('sale', 'partial_sale', 'distribution', 'dividend', 'write_off')),
  note         text,
  created_by   text not null,
  created_at   timestamptz not null default now()
);
create trigger realizations_append_only before update or delete on realizations for each row execute function forbid_mutation();

-- Board meetings the firm attends, with what was decided. When the
-- company's preferred and common holders may want different things (a
-- sale, a down round, a recap), the note on how the conflict was handled
-- is required (In re Trados, Del. Ch. 2013).
create table board_meetings (
  id              uuid primary key default gen_random_uuid(),
  firm_id         uuid not null default current_firm() references firms(id) on delete cascade,
  company_id      uuid not null references entities(id),
  held_on         date not null,
  kind            text not null default 'regular' check (kind in ('regular', 'special', 'annual', 'written_consent')),
  our_role        text not null default 'director' check (our_role in ('director', 'observer', 'none')),
  attendees       text[] not null default '{}',
  agenda          text,
  notes           text,
  resolutions     jsonb not null default '[]'::jsonb,
  conflict_review text,
  materials_evidence_id uuid references evidence(id),
  created_by      text not null,
  created_at      timestamptz not null default now()
);

-- Help the firm gives a company: hires, customer and partner intros,
-- fundraising, strategy. Measured by outcome, not activity.
create table initiatives (
  id          uuid primary key default gen_random_uuid(),
  firm_id     uuid not null default current_firm() references firms(id) on delete cascade,
  company_id  uuid not null references entities(id),
  kind        text not null check (kind in ('hiring', 'customer_intro', 'partnership', 'fundraising', 'strategy', 'operations', 'government', 'technical', 'other')),
  title       text not null,
  detail      text,
  owner       text,
  status      text not null default 'proposed' check (status in ('proposed', 'in_progress', 'done', 'dropped')),
  due_on      date,
  outcome     text,
  value_usd   numeric check (value_usd is null or value_usd >= 0),
  outbox_id   uuid references outbox(id),
  created_by  text not null,
  created_at  timestamptz not null default now(),
  updated_by  text,
  updated_at  timestamptz not null default now(),
  check (status <> 'done' or outcome is not null)
);

do $$
declare
  t text;
begin
  foreach t in array array['company_contacts', 'portal_links', 'kpi_requests', 'accounting_links', 'valuations', 'realizations', 'board_meetings', 'initiatives'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy firm_isolation on %I using (firm_id = current_firm()) with check (firm_id = current_firm())', t);
  end loop;
end $$;

grant select, insert, update on company_contacts, portal_links, kpi_requests, accounting_links, valuations, board_meetings, initiatives to vcos_app;
grant delete on company_contacts to vcos_app;
grant select, insert on realizations to vcos_app;
