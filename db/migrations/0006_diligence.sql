-- 0006_diligence.sql
-- Meetings from the firm's meeting tools, matched to companies, and the
-- Diligence module: deals, their checklist, questions for the founder and
-- IC memo versions.

-- Zoom joins Google and Microsoft as an account provider for connections.
alter table oauth_states drop constraint if exists oauth_states_provider_check;
alter table oauth_states add constraint oauth_states_provider_check check (provider in ('google', 'microsoft', 'zoom'));

-- Who resolved a contradiction, next to the note they wrote.
alter table contradictions add column resolved_by text;

-- ---------------------------------------------------------------------------
-- Meetings
-- ---------------------------------------------------------------------------

-- One row per meeting a tool reported. The words (notes, transcript) are
-- Evidence; this row is the workflow around them: which company it's about,
-- and how that was decided.
create table meetings (
  id           uuid primary key default gen_random_uuid(),
  firm_id      uuid not null default current_firm() references firms(id) on delete cascade,
  source       text not null,                -- connector id
  external_id  text not null,
  title        text not null,
  started_at   timestamptz,
  ended_at     timestamptz,
  organizer    text,
  attendees    jsonb not null default '[]'::jsonb,
  join_key     text,                          -- zoom:…, meet:…, teams:… joins a recording to its invite
  url          text,
  evidence_id  uuid references evidence(id),  -- notes and transcript, when the tool has them
  company_id   uuid references entities(id),
  status       text not null default 'needs_review'
                 check (status in ('matched', 'needs_review', 'internal', 'ignored')),
  match        jsonb not null default '{}'::jsonb,  -- method, confidence, reasons, candidates
  matched_by   text,                          -- 'auto:<method>' or 'human:<email>'
  extracted    boolean not null default false,
  synced_at    timestamptz not null default now(),
  unique (firm_id, source, external_id)
);
create index meetings_status on meetings(firm_id, status, started_at desc);
create index meetings_company on meetings(company_id, started_at desc);
create index meetings_join on meetings(firm_id, join_key);

-- What people taught the matcher: this address belongs to this company.
create table meeting_contacts (
  firm_id     uuid not null default current_firm() references firms(id) on delete cascade,
  email       text not null,
  entity_id   uuid not null references entities(id),
  learned_by  text not null,
  created_at  timestamptz not null default now(),
  primary key (firm_id, email)
);

-- ---------------------------------------------------------------------------
-- Diligence
-- ---------------------------------------------------------------------------

-- A deal: the firm's diligence on one company's current raise.
create table deals (
  id              uuid primary key default gen_random_uuid(),
  firm_id         uuid not null default current_firm() references firms(id) on delete cascade,
  company_id      uuid not null references entities(id),
  stage           text not null default 'diligence'
                    check (stage in ('screening', 'diligence', 'ic', 'approved', 'passed', 'closed')),
  lead            text,                       -- human:<email>
  team            text[] not null default '{}',
  -- The firm's intended check (its judgment, not a fact about the company).
  our_check_usd   numeric,
  -- Which extra checklist sections apply: hardware, regulated, sensitive_tech.
  flags           jsonb not null default '{}'::jsonb,
  target_ic_date  date,
  created_by      text not null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
-- One open deal per company.
create unique index deals_one_open on deals(firm_id, company_id) where stage not in ('passed', 'closed');
create index deals_stage on deals(firm_id, stage, updated_at desc);

-- A person's status on a checklist item, or an item the firm added.
create table deal_items (
  id          uuid primary key default gen_random_uuid(),
  firm_id     uuid not null default current_firm() references firms(id) on delete cascade,
  deal_id     uuid not null references deals(id) on delete cascade,
  item_key    text not null,
  workstream  text not null,
  title       text,                           -- custom items only
  custom      boolean not null default false,
  status      text check (status in ('open', 'in_progress', 'done', 'na', 'red_flag')),
  assignee    text,
  note        text,
  updated_by  text not null,
  updated_at  timestamptz not null default now(),
  unique (deal_id, item_key)
);

-- Questions for the founders: generated from gaps and conflicts in the
-- ledger, or written by a person.
create table deal_questions (
  id          uuid primary key default gen_random_uuid(),
  firm_id     uuid not null default current_firm() references firms(id) on delete cascade,
  deal_id     uuid not null references deals(id) on delete cascade,
  key         text not null,
  workstream  text not null,
  text        text not null,
  origin      text not null check (origin in ('gap', 'unverified', 'contradiction', 'pilot', 'risk', 'custom')),
  claim_ids   uuid[] not null default '{}',
  status      text not null default 'open' check (status in ('open', 'asked', 'answered', 'dropped')),
  answer      text,
  updated_by  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (deal_id, key)
);

-- IC memo versions. Append-only: every draft that passed the citation
-- check is kept, with the result of that check.
create table memos (
  id          uuid primary key default gen_random_uuid(),
  firm_id     uuid not null default current_firm() references firms(id) on delete cascade,
  deal_id     uuid not null references deals(id) on delete cascade,
  version     integer not null check (version > 0),
  shareable   boolean not null default false,
  body        jsonb not null,
  check_result jsonb not null,
  drafted_by  text not null,                  -- 'writer:deterministic@…', 'agent:memo-writer@…'
  created_by  text not null,
  created_at  timestamptz not null default now(),
  unique (deal_id, version)
);
create trigger memos_append_only before update or delete on memos
  for each row execute function forbid_mutation();

-- Research runs ("gather everything") are job runs tied to a deal.
alter table job_runs add column deal_id uuid references deals(id) on delete cascade;
create index job_runs_deal on job_runs(deal_id, started_at desc);

do $$
declare
  t text;
begin
  foreach t in array array['meetings', 'meeting_contacts', 'deals', 'deal_items', 'deal_questions', 'memos'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy firm_isolation on %I using (firm_id = current_firm()) with check (firm_id = current_firm())', t);
  end loop;
end $$;

grant select, insert, update, delete on meetings, meeting_contacts, deals, deal_items, deal_questions to vcos_app;
grant select, insert on memos to vcos_app;
