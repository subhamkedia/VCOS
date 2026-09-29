-- 0007_execution.sql
-- Investment Execution: term sheets, pro-forma cap tables, IC meetings,
-- the closing checklist, wire controls and the investment record.

-- DocuSign joins the account providers a firm can connect with OAuth.
alter table oauth_states drop constraint if exists oauth_states_provider_check;
alter table oauth_states add constraint oauth_states_provider_check check (provider in ('google', 'microsoft', 'zoom', 'docusign'));

-- A new outbox channel: a DocuSign envelope saved as a draft for a person
-- to review and send. Still no channel that sends anything.
alter table outbox drop constraint if exists outbox_channel_check;
alter table outbox add constraint outbox_channel_check check (channel in ('affinity_note', 'gmail_draft', 'outlook_draft', 'docusign_draft'));

-- A deal moves diligence -> ic -> approved -> closing -> closed.
alter table deals drop constraint if exists deals_stage_check;
alter table deals add constraint deals_stage_check check (stage in ('screening', 'diligence', 'ic', 'approved', 'closing', 'passed', 'closed'));
drop index if exists deals_one_open;
create unique index deals_one_open on deals(firm_id, company_id) where stage not in ('passed', 'closed');

-- Term sheet versions as structured terms. A new draft is a new version;
-- only the status of a version changes.
create table term_sheets (
  id           uuid primary key default gen_random_uuid(),
  firm_id      uuid not null default current_firm() references firms(id) on delete cascade,
  deal_id      uuid not null references deals(id) on delete cascade,
  version      integer not null check (version > 0),
  status       text not null default 'draft' check (status in ('draft', 'proposed', 'negotiating', 'signed', 'superseded')),
  terms        jsonb not null,
  source       text not null default 'entered' check (source in ('entered', 'extracted')),
  evidence_id  uuid references evidence(id),
  note         text,
  created_by   text not null,
  created_at   timestamptz not null default now(),
  unique (deal_id, version)
);

-- The company's capitalization before the round, as entered or imported.
create table cap_tables (
  id           uuid primary key default gen_random_uuid(),
  firm_id      uuid not null default current_firm() references firms(id) on delete cascade,
  deal_id      uuid not null references deals(id) on delete cascade,
  version      integer not null check (version > 0),
  holdings     jsonb not null,
  safes        jsonb not null default '[]'::jsonb,
  notes        jsonb not null default '[]'::jsonb,
  series_terms jsonb not null default '[]'::jsonb,   -- existing preferred series' preferences, for waterfalls
  source       text not null default 'entered' check (source in ('entered', 'csv', 'carta')),
  evidence_id  uuid references evidence(id),
  created_by   text not null,
  created_at   timestamptz not null default now(),
  unique (deal_id, version)
);

-- An investment committee meeting. Votes are rows in `decisions`
-- (ic_vote_pre before discussion, ic_vote_post after), per principle 5.
create table ic_meetings (
  id            uuid primary key default gen_random_uuid(),
  firm_id       uuid not null default current_firm() references firms(id) on delete cascade,
  deal_id       uuid not null references deals(id) on delete cascade,
  scheduled_for timestamptz,
  members       text[] not null,                  -- human:<email>
  chair         text not null,
  rule          text not null,                    -- the approval rule in force when the meeting was set
  memo_version  integer,
  term_sheet_version integer,
  phase         text not null default 'pre_vote' check (phase in ('pre_vote', 'discussion', 'post_vote', 'decided', 'cancelled')),
  outcome       text check (outcome in ('approved', 'declined')),
  notes         text,
  created_by    text not null,
  created_at    timestamptz not null default now(),
  decided_at    timestamptz
);
create index ic_meetings_deal on ic_meetings(deal_id, created_at desc);

-- The closing checklist: documents, filings, screenings and funding steps.
create table closing_items (
  id           uuid primary key default gen_random_uuid(),
  firm_id      uuid not null default current_firm() references firms(id) on delete cascade,
  deal_id      uuid not null references deals(id) on delete cascade,
  key          text not null,
  category     text not null,
  title        text not null,
  required     boolean not null default true,
  status       text not null default 'open' check (status in ('open', 'requested', 'received', 'signed', 'filed', 'done', 'waived', 'na', 'red_flag')),
  owner        text,
  due_date     date,
  evidence_id  uuid references evidence(id),
  envelope_id  text,                               -- a DocuSign envelope, when signing happens there
  note         text,
  custom       boolean not null default false,
  updated_by   text not null,
  updated_at   timestamptz not null default now(),
  unique (deal_id, key)
);

-- Wire controls. VC OS never moves money: it records the instructions
-- received, the call-back to a known number, two approvals, and the bank's
-- reference once a person has sent the wire from the bank.
create table wires (
  id                     uuid primary key default gen_random_uuid(),
  firm_id                uuid not null default current_firm() references firms(id) on delete cascade,
  deal_id                uuid not null references deals(id) on delete cascade,
  amount_usd             numeric not null check (amount_usd > 0),
  beneficiary            text not null,
  bank_name              text not null,
  account_last4          text not null check (account_last4 ~ '^[0-9]{4}$'),
  instructions_evidence_id uuid references evidence(id),
  instructions_received_at timestamptz not null default now(),
  callback_by            text,
  callback_number_source text,
  callback_at            timestamptz,
  approvals              text[] not null default '{}',
  status                 text not null default 'received' check (status in ('received', 'verified', 'approved', 'sent', 'confirmed', 'cancelled')),
  bank_reference         text,
  sent_at                timestamptz,
  confirmed_at           timestamptz,
  created_by             text not null,
  created_at             timestamptz not null default now()
);

-- The investment, once closed: what the Portfolio module starts from.
-- Append-only; a correction is a new row that names the one it replaces.
create table investments (
  id               uuid primary key default gen_random_uuid(),
  firm_id          uuid not null default current_firm() references firms(id) on delete cascade,
  deal_id          uuid not null references deals(id),
  company_id       uuid not null references entities(id),
  fund_name        text not null,
  security         text not null,
  series_name      text,
  close_date       date not null,
  amount_usd       numeric not null check (amount_usd > 0),
  shares           numeric,
  price_per_share  numeric,
  post_money_usd   numeric,
  ownership_fd_pct numeric,
  board_role       text,
  rights           jsonb not null default '{}'::jsonb,
  supersedes       uuid references investments(id),
  created_by       text not null,
  created_at       timestamptz not null default now()
);
create trigger investments_append_only before update or delete on investments
  for each row execute function forbid_mutation();

do $$
declare
  t text;
begin
  foreach t in array array['term_sheets', 'cap_tables', 'ic_meetings', 'closing_items', 'wires', 'investments'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy firm_isolation on %I using (firm_id = current_firm()) with check (firm_id = current_firm())', t);
  end loop;
end $$;

grant select, insert, update on term_sheets, ic_meetings, closing_items, wires to vcos_app;
grant delete on closing_items to vcos_app;
grant select, insert on cap_tables, investments to vcos_app;
