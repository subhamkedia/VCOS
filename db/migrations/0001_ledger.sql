-- 0001_ledger.sql
-- The entity graph and the claim ledger. Everything else reads from here.

create extension if not exists pg_trgm;

-- ---------------------------------------------------------------------------
-- Entity graph
-- ---------------------------------------------------------------------------

create table entities (
  id           uuid primary key default gen_random_uuid(),
  type         text not null check (type in
                 ('company','person','investor','fund','program','customer','lp')),
  name         text not null,
  merged_into  uuid references entities(id),
  created_at   timestamptz not null default now()
);

-- Hard identifiers. One (kind, value) maps to exactly one entity.
create table entity_identifiers (
  entity_id  uuid not null references entities(id),
  kind       text not null check (kind in
               ('domain','linkedin','pitchbook','harmonic','crunchbase',
                'dealroom','carta','affinity','cik','email','twitter')),
  value      text not null,
  source     text not null,
  created_at timestamptz not null default now(),
  primary key (kind, value)
);
create index entity_identifiers_entity on entity_identifiers(entity_id);

-- Soft names. Many per entity; used for fuzzy blocking.
create table entity_aliases (
  entity_id  uuid not null references entities(id),
  alias      text not null,
  normalized text not null,
  source     text not null,
  created_at timestamptz not null default now(),
  primary key (entity_id, normalized)
);
create index entity_aliases_trgm on entity_aliases using gin (normalized gin_trgm_ops);

create table relations (
  id          uuid primary key default gen_random_uuid(),
  from_id     uuid not null references entities(id),
  to_id       uuid not null references entities(id),
  type        text not null check (type in
                ('founded','works_at','worked_at','invested_in','graduated_from',
                 'customer_of','partner_of','co_invested','board_member_of')),
  valid_from  date,
  valid_to    date,
  evidence_id uuid,
  created_at  timestamptz not null default now()
);
create index relations_from on relations(from_id, type);
create index relations_to on relations(to_id, type);

-- ---------------------------------------------------------------------------
-- Evidence: immutable raw artifacts
-- ---------------------------------------------------------------------------

create table evidence (
  id            uuid primary key default gen_random_uuid(),
  kind          text not null check (kind in
                  ('transcript','deck','filing','web_page','api_record','email',
                   'message','document','note')),
  source        text not null,          -- connector name, e.g. 'harmonic', 'granola'
  uri           text,
  title         text,
  content       text not null,
  content_hash  text not null,
  mime_type     text not null default 'text/plain',
  occurred_at   timestamptz,            -- when the call/email/filing happened
  captured_at   timestamptz not null default now(),
  access_scope  text not null default 'internal' check (access_scope in
                  ('public','internal','confidential','nda','vendor')),
  metadata      jsonb not null default '{}'::jsonb,
  unique (source, content_hash)
);

-- ---------------------------------------------------------------------------
-- Claims: the atom. Append-only.
-- ---------------------------------------------------------------------------

create table claims (
  id            uuid primary key default gen_random_uuid(),
  subject_id    uuid not null references entities(id),
  predicate     text not null,
  value         jsonb not null,
  unit          text,
  as_of         date,
  evidence_id   uuid not null references evidence(id),
  span_start    integer,
  span_end      integer,
  cited_text    text,
  source_type   text not null check (source_type in
                  ('primary','third_party','self_reported','inference','internal')),
  confidence    real not null default 0.8 check (confidence >= 0 and confidence <= 1),
  extracted_by  text not null,          -- agent name + version, or 'human:<name>'
  access_scope  text not null,
  supersedes    uuid references claims(id),
  created_at    timestamptz not null default now(),
  check (span_start is null or span_end is null or span_end >= span_start)
);
create index claims_subject_predicate on claims(subject_id, predicate);
create index claims_evidence on claims(evidence_id);

-- Append-only enforcement for the two immutable tables.
create or replace function forbid_mutation() returns trigger
language plpgsql as $$
begin
  raise exception '% is append-only; write a new row instead', tg_table_name;
end;
$$;

create trigger claims_append_only before update or delete on claims
  for each row execute function forbid_mutation();
create trigger evidence_append_only before update or delete on evidence
  for each row execute function forbid_mutation();

-- ---------------------------------------------------------------------------
-- Contradictions
-- ---------------------------------------------------------------------------

create table contradictions (
  id               uuid primary key default gen_random_uuid(),
  subject_id       uuid not null references entities(id),
  predicate        text not null,
  claim_ids        uuid[] not null,
  fingerprint      text not null unique,   -- sorted claim ids, so a pair is flagged once
  severity         text not null check (severity in ('low','medium','high')),
  status           text not null default 'open' check (status in ('open','explained','resolved')),
  detail           text,
  resolution_note  text,
  detected_at      timestamptz not null default now(),
  resolved_at      timestamptz
);
create index contradictions_subject on contradictions(subject_id, status);

-- ---------------------------------------------------------------------------
-- Entity resolution queue
-- ---------------------------------------------------------------------------

create table merge_proposals (
  id                  uuid primary key default gen_random_uuid(),
  candidate           jsonb not null,     -- the unresolved record as the source gave it
  proposed_entity_id  uuid references entities(id),
  score               real not null,
  method              text not null,      -- 'identifier' | 'fellegi-sunter' | 'llm-select'
  explanation         text,
  status              text not null default 'pending' check (status in ('pending','accepted','rejected')),
  decided_by          text,
  created_at          timestamptz not null default now(),
  decided_at          timestamptz
);

-- ---------------------------------------------------------------------------
-- Decisions: the firm's judgment, logged as data
-- ---------------------------------------------------------------------------

create table decisions (
  id           uuid primary key default gen_random_uuid(),
  entity_id    uuid not null references entities(id),
  kind         text not null check (kind in
                 ('pass','advance','ic_vote_pre','ic_vote_post','invest',
                  'follow_on','score_override')),
  actor        text not null,
  value        jsonb not null default '{}'::jsonb,
  reason_code  text,
  rationale    text,
  created_at   timestamptz not null default now(),
  check (kind <> 'pass' or reason_code is not null),
  check (kind not in ('ic_vote_pre','ic_vote_post') or value ? 'vote')
);
create index decisions_entity on decisions(entity_id, kind);

-- ---------------------------------------------------------------------------
-- Audit log: every agent and human action that changes state
-- ---------------------------------------------------------------------------

create table audit_log (
  id      bigserial primary key,
  at      timestamptz not null default now(),
  actor   text not null,
  action  text not null,
  target  text,
  detail  jsonb not null default '{}'::jsonb
);
