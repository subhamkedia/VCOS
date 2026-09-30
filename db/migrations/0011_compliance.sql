-- 0011_compliance.sql
-- Compliance, shared across modules: the adviser's regulatory profile, the
-- filings register, regulatory screenings of deals (outbound investment,
-- CFIUS, export controls), the code of ethics (restricted list, personal
-- holdings and transaction reports, pre-clearance), political contributions,
-- gifts and entertainment, the conflicts register, annual attestations, and
-- Marketing Rule reviews. Reports and screenings are append-only; requests
-- are decided by someone other than the person who made them.

create table compliance_profiles (
  firm_id             uuid primary key default current_firm() references firms(id) on delete cascade,
  adviser_status      text not null default 'era' check (adviser_status in ('registered', 'era', 'state', 'none')),
  cco_email           text,
  fiscal_year_end     text not null default '12-31' check (fiscal_year_end ~ '^(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$'),
  require_screening   boolean not null default true,
  gift_limit_usd      numeric not null default 250 check (gift_limit_usd >= 0),
  updated_by          text not null,
  updated_at          timestamptz not null default now()
);

create table filings (
  id              uuid primary key default gen_random_uuid(),
  firm_id         uuid not null default current_firm() references firms(id) on delete cascade,
  form            text not null check (form in ('form_adv', 'form_d', 'blue_sky', 'form_pf', 'audit', 'annual_review', 'coe_holdings', 'coe_transactions',
                                                'outbound_notice', 'cfius', 'schedule_13g', 'schedule_13d', 'form_345', 'form_13f', 'other')),
  obligation_key  text,
  subject         text,
  filed_on        date not null,
  reference       text,
  note            text,
  created_by      text not null,
  created_at      timestamptz not null default now()
);

create table screenings (
  id              uuid primary key default gen_random_uuid(),
  firm_id         uuid not null default current_firm() references firms(id) on delete cascade,
  deal_id         uuid not null references deals(id) on delete cascade,
  company_id      uuid not null references entities(id),
  answers         jsonb not null,
  outbound        text not null check (outbound in ('not_covered', 'notifiable', 'prohibited')),
  cfius           text not null check (cfius in ('none', 'review', 'declaration_likely')),
  export_control  text not null check (export_control in ('none', 'ear', 'itar')),
  reasons         jsonb not null default '[]'::jsonb,
  counsel_note    text,
  screened_by     text not null,
  created_at      timestamptz not null default now()
);

create table restricted_list (
  id          uuid primary key default gen_random_uuid(),
  firm_id     uuid not null default current_firm() references firms(id) on delete cascade,
  company_id  uuid references entities(id),
  name        text not null,
  ticker      text,
  reason      text not null,
  added_on    date not null,
  added_by    text not null,
  removed_on  date,
  removed_by  text
);

create table personal_reports (
  id           uuid primary key default gen_random_uuid(),
  firm_id      uuid not null default current_firm() references firms(id) on delete cascade,
  person       text not null,
  kind         text not null check (kind in ('holding', 'transaction', 'no_activity')),
  security     text,
  ticker       text,
  action       text check (action in ('buy', 'sell', 'hold', 'other')),
  quantity     numeric,
  traded_on    date,
  account      text,
  period       text not null,
  created_at   timestamptz not null default now()
);

create table preclearances (
  id              uuid primary key default gen_random_uuid(),
  firm_id         uuid not null default current_firm() references firms(id) on delete cascade,
  person          text not null,
  kind            text not null check (kind in ('ipo', 'private_placement', 'public_security')),
  security        text not null,
  ticker          text,
  amount_usd      numeric,
  reason          text,
  restricted_hit  boolean not null default false,
  status          text not null default 'pending' check (status in ('pending', 'approved', 'denied')),
  decided_by      text,
  decided_at      timestamptz,
  note            text,
  created_at      timestamptz not null default now(),
  check (decided_by is null or decided_by <> person)
);

create table political_contributions (
  id                 uuid primary key default gen_random_uuid(),
  firm_id            uuid not null default current_firm() references firms(id) on delete cascade,
  person             text not null,
  recipient          text not null,
  office             text not null,
  jurisdiction       text not null,
  election           text not null,
  amount_usd         numeric not null check (amount_usd > 0),
  can_vote           boolean not null,
  influences_gov     boolean not null,
  contribute_on      date not null,
  result             jsonb not null,
  status             text not null default 'pending' check (status in ('pending', 'approved', 'denied')),
  decided_by         text,
  decided_at         timestamptz,
  note               text,
  created_at         timestamptz not null default now(),
  check (decided_by is null or decided_by <> person)
);

create table gifts (
  id            uuid primary key default gen_random_uuid(),
  firm_id       uuid not null default current_firm() references firms(id) on delete cascade,
  person        text not null,
  direction     text not null check (direction in ('given', 'received')),
  kind          text not null check (kind in ('gift', 'entertainment')),
  counterparty  text not null,
  description   text not null,
  value_usd     numeric not null check (value_usd >= 0),
  occurred_on   date not null,
  over_limit    boolean not null,
  status        text not null default 'logged' check (status in ('logged', 'approved', 'denied')),
  decided_by    text,
  decided_at    timestamptz,
  note          text,
  created_at    timestamptz not null default now(),
  check (decided_by is null or decided_by <> person)
);

create table conflicts (
  id               uuid primary key default gen_random_uuid(),
  firm_id          uuid not null default current_firm() references firms(id) on delete cascade,
  kind             text not null check (kind in ('cross_fund', 'related_party', 'allocation', 'personal', 'outside_activity', 'other')),
  title            text not null,
  detail           text not null,
  mitigation       text,
  status           text not null default 'open' check (status in ('open', 'mitigated', 'closed')),
  fund_id          uuid references funds(id),
  company_id       uuid references entities(id),
  lpac_consent_id  uuid references lpac_consents(id),
  detect_key       text,
  created_by       text not null,
  created_at       timestamptz not null default now(),
  closed_by        text,
  closed_at        timestamptz
);
create unique index conflicts_detect_key on conflicts(firm_id, detect_key) where detect_key is not null;

create table attestations (
  id           uuid primary key default gen_random_uuid(),
  firm_id      uuid not null default current_firm() references firms(id) on delete cascade,
  person       text not null,
  policy       text not null check (policy in ('code_of_ethics', 'compliance_manual', 'insider_trading')),
  year         integer not null,
  attested_on  date not null,
  unique (firm_id, person, policy, year)
);

create table marketing_reviews (
  id            uuid primary key default gen_random_uuid(),
  firm_id       uuid not null default current_firm() references firms(id) on delete cascade,
  subject_kind  text not null check (subject_kind in ('dataroom_doc', 'ddq', 'report', 'other')),
  subject_id    uuid,
  title         text not null,
  answers       jsonb not null,
  reviewer      text not null,
  created_at    timestamptz not null default now()
);

create trigger filings_append_only before update or delete on filings for each row execute function forbid_mutation();
create trigger screenings_append_only before update or delete on screenings for each row execute function forbid_mutation();
create trigger personal_reports_append_only before update or delete on personal_reports for each row execute function forbid_mutation();
create trigger marketing_reviews_append_only before update or delete on marketing_reviews for each row execute function forbid_mutation();

do $$
declare
  t text;
begin
  foreach t in array array['compliance_profiles', 'filings', 'screenings', 'restricted_list', 'personal_reports', 'preclearances', 'political_contributions',
                           'gifts', 'conflicts', 'attestations', 'marketing_reviews'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy firm_isolation on %I using (firm_id = current_firm()) with check (firm_id = current_firm())', t);
  end loop;
end $$;

grant select, insert, update on compliance_profiles, restricted_list, preclearances, political_contributions, gifts, conflicts to vcos_app;
grant select, insert on filings, screenings, personal_reports, attestations, marketing_reviews to vcos_app;
