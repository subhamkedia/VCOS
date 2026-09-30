-- 0010_fundraising.sql
-- Fundraising and investor relations: a raise and its offering terms, the
-- LP pipeline and its activity, the data room (documents, private links,
-- views), the DDQ answer library, subscriptions (the investor's
-- questionnaire, KYC and accreditation), closings and subsequent-close
-- equalization, side letters and MFN elections, the LPAC and its consents,
-- and investor requests. The math is engines/fundraising.ts and
-- engines/fund-accounting.ts. Nothing here sends or moves money.

create table raises (
  id                    uuid primary key default gen_random_uuid(),
  firm_id               uuid not null default current_firm() references firms(id) on delete cascade,
  name                  text not null,
  fund_id               uuid references funds(id),
  target_usd            numeric not null check (target_usd > 0),
  hard_cap_usd          numeric check (hard_cap_usd is null or hard_cap_usd >= target_usd),
  min_commitment_usd    numeric check (min_commitment_usd is null or min_commitment_usd >= 0),
  exemption             text not null default '3c1' check (exemption in ('3c1', '3c1_qvcf', '3c7')),
  offering              text not null default '506b' check (offering in ('506b', '506c')),
  vcoc                  boolean not null default false,
  equalization_rate_pct numeric not null default 8 check (equalization_rate_pct >= 0 and equalization_rate_pct <= 20),
  first_close_target    date,
  final_close_deadline  date,
  status                text not null default 'open' check (status in ('open', 'closed')),
  created_by            text not null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (firm_id, name)
);

create table prospects (
  id              uuid primary key default gen_random_uuid(),
  firm_id         uuid not null default current_firm() references firms(id) on delete cascade,
  raise_id        uuid not null references raises(id) on delete cascade,
  name            text not null,
  kind            text not null check (kind in ('pension', 'endowment_foundation', 'insurance', 'fund_of_funds', 'family_office', 'individual', 'corporate', 'sovereign', 'gp', 'other')),
  contact_name    text,
  emails          text[] not null default '{}',
  jurisdiction    text,
  stage           text not null default 'identified' check (stage in ('identified', 'contacted', 'meeting', 'diligence', 'soft_circle', 'committed', 'closed', 'declined')),
  probability     numeric check (probability is null or (probability >= 0 and probability <= 1)),
  ask_usd         numeric check (ask_usd is null or ask_usd >= 0),
  soft_circle_usd numeric check (soft_circle_usd is null or soft_circle_usd >= 0),
  committed_usd   numeric check (committed_usd is null or committed_usd >= 0),
  source          text,
  owner           text,
  next_step       text,
  next_step_on    date,
  decline_reason  text,
  created_by      text not null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (raise_id, name),
  -- Judgment is data: a declined prospect says why.
  check (stage <> 'declined' or length(coalesce(decline_reason, '')) > 0)
);

create table prospect_activities (
  id           uuid primary key default gen_random_uuid(),
  firm_id      uuid not null default current_firm() references firms(id) on delete cascade,
  prospect_id  uuid not null references prospects(id) on delete cascade,
  occurred_on  date not null,
  kind         text not null check (kind in ('note', 'meeting', 'call', 'email', 'stage', 'data_room', 'document', 'ddq')),
  summary      text not null,
  actor        text not null,
  created_at   timestamptz not null default now()
);

-- The data room. Marketing documents (the deck, track record, DDQ answers)
-- are reviewed by a second person before any investor can open them.
create table dataroom_docs (
  id           uuid primary key default gen_random_uuid(),
  firm_id      uuid not null default current_firm() references firms(id) on delete cascade,
  raise_id     uuid not null references raises(id) on delete cascade,
  title        text not null,
  category     text not null check (category in ('deck', 'ppm', 'lpa', 'subscription', 'ddq', 'track_record', 'financials', 'legal', 'other')),
  version      integer not null check (version > 0),
  file_name    text not null,
  mime_type    text not null,
  size_bytes   integer not null check (size_bytes > 0),
  content      bytea not null,
  sha256       text not null,
  marketing    boolean not null default true,
  status       text not null default 'draft' check (status in ('draft', 'approved', 'archived')),
  uploaded_by  text not null,
  approved_by  text,
  approved_at  timestamptz,
  created_at   timestamptz not null default now(),
  unique (raise_id, title, version),
  check (approved_by is null or approved_by <> uploaded_by)
);

create table dataroom_links (
  id               uuid primary key default gen_random_uuid(),
  firm_id          uuid not null default current_firm() references firms(id) on delete cascade,
  prospect_id      uuid not null references prospects(id) on delete cascade,
  token_hash       text not null unique,
  expires_at       timestamptz not null,
  revoked_at       timestamptz,
  acknowledged_at  timestamptz,
  last_used_at     timestamptz,
  created_by       text not null,
  created_at       timestamptz not null default now()
);

create table dataroom_views (
  id         uuid primary key default gen_random_uuid(),
  firm_id    uuid not null default current_firm() references firms(id) on delete cascade,
  link_id    uuid not null references dataroom_links(id) on delete cascade,
  doc_id     uuid not null references dataroom_docs(id) on delete cascade,
  action     text not null check (action in ('view', 'download')),
  viewed_at  timestamptz not null default now()
);

-- The DDQ answer library, by question (sections follow the ILPA DDQ 2.0).
create table ddq_answers (
  id            uuid primary key default gen_random_uuid(),
  firm_id       uuid not null default current_firm() references firms(id) on delete cascade,
  question_key  text not null,
  answer        text not null,
  sources       jsonb not null default '[]'::jsonb,
  status        text not null default 'draft' check (status in ('draft', 'approved')),
  updated_by    text not null,
  updated_at    timestamptz not null default now(),
  approved_by   text,
  approved_at   timestamptz,
  unique (firm_id, question_key),
  check (approved_by is null or approved_by <> updated_by)
);

-- A subscription: the investor's questionnaire (from its private link or
-- entered by the firm), the firm's KYC, sanctions and accreditation checks,
-- and acceptance by a partner. Bank details are never stored.
create table subscriptions (
  id                       uuid primary key default gen_random_uuid(),
  firm_id                  uuid not null default current_firm() references firms(id) on delete cascade,
  raise_id                 uuid not null references raises(id) on delete cascade,
  prospect_id              uuid references prospects(id) on delete set null,
  investor_name            text not null,
  kind                     text not null check (kind in ('pension', 'endowment_foundation', 'insurance', 'fund_of_funds', 'family_office', 'individual', 'corporate', 'sovereign', 'gp', 'other')),
  natural_person           boolean not null default false,
  commitment_usd           numeric check (commitment_usd is null or commitment_usd > 0),
  status                   text not null default 'invited' check (status in ('invited', 'submitted', 'accepted', 'rejected', 'withdrawn', 'admitted')),
  questionnaire            jsonb not null default '{}'::jsonb,
  accredited               boolean not null default false,
  accredited_basis         text,
  qualified_purchaser      boolean not null default false,
  qp_basis                 text,
  knowledgeable_employee   boolean not null default false,
  benefit_plan             boolean not null default false,
  pooled_vehicle           boolean not null default false,
  verification             text check (verification in ('self_certified', 'minimum_investment', 'third_party_letter', 'documents_reviewed', 'platform')),
  minimum_investment_reps  boolean not null default false,
  tax_form                 text check (tax_form in ('w9', 'w8ben', 'w8bene', 'w8imy', 'w8exp')),
  jurisdiction             text,
  emails                   text[] not null default '{}',
  beneficial_owners        jsonb not null default '[]'::jsonb,
  kyc_status               text not null default 'pending' check (kyc_status in ('pending', 'cleared', 'flagged')),
  kyc_note                 text,
  kyc_by                   text,
  sanctions                jsonb,
  signed_on                date,
  closing_id               uuid,
  partner_id               uuid references fund_partners(id),
  token_hash               text unique,
  token_expires_at         timestamptz,
  token_revoked_at         timestamptz,
  submitted_at             timestamptz,
  decided_by               text,
  decided_at               timestamptz,
  rejected_reason          text,
  created_by               text not null,
  created_at               timestamptz not null default now(),
  unique (raise_id, investor_name),
  check (status <> 'rejected' or length(coalesce(rejected_reason, '')) > 0)
);

create table closings (
  id            uuid primary key default gen_random_uuid(),
  firm_id       uuid not null default current_firm() references firms(id) on delete cascade,
  raise_id      uuid not null references raises(id) on delete cascade,
  number        integer not null check (number > 0),
  closing_date  date not null,
  status        text not null default 'draft' check (status in ('draft', 'approved', 'cancelled')),
  note          text,
  created_by    text not null,
  created_at    timestamptz not null default now(),
  approved_by   text,
  approved_at   timestamptz,
  unique (raise_id, number),
  check (approved_by is null or approved_by <> created_by)
);
alter table subscriptions add constraint subscriptions_closing_fk foreign key (closing_id) references closings(id);

-- What each partner pays or gets back when later investors are admitted.
create table equalization_items (
  id            uuid primary key default gen_random_uuid(),
  firm_id       uuid not null default current_firm() references firms(id) on delete cascade,
  closing_id    uuid not null references closings(id) on delete cascade,
  partner_id    uuid not null references fund_partners(id),
  capital_usd   numeric not null default 0,
  fee_usd       numeric not null default 0 check (fee_usd >= 0),
  interest_usd  numeric not null default 0,
  due_on        date not null,
  detail        jsonb not null default '[]'::jsonb,
  settled_on    date,
  unique (closing_id, partner_id)
);

create table side_letter_terms (
  id                        uuid primary key default gen_random_uuid(),
  firm_id                   uuid not null default current_firm() references firms(id) on delete cascade,
  raise_id                  uuid not null references raises(id) on delete cascade,
  subscription_id           uuid not null references subscriptions(id) on delete cascade,
  category                  text not null check (category in ('mfn', 'fee', 'reporting', 'lpac_seat', 'co_invest', 'excuse', 'esg', 'transfer', 'confidentiality', 'tax_regulatory', 'other')),
  text                      text not null,
  electable                 boolean not null default true,
  granted_on                date not null,
  elected_from              uuid references side_letter_terms(id),
  created_by                text not null,
  created_at                timestamptz not null default now()
);

create table mfn_elections (
  id               uuid primary key default gen_random_uuid(),
  firm_id          uuid not null default current_firm() references firms(id) on delete cascade,
  raise_id         uuid not null references raises(id) on delete cascade,
  subscription_id  uuid not null references subscriptions(id) on delete cascade,
  term_id          uuid not null references side_letter_terms(id) on delete cascade,
  status           text not null default 'offered' check (status in ('offered', 'elected', 'declined')),
  window_ends      date not null,
  decided_on       date,
  recorded_by      text,
  created_at       timestamptz not null default now(),
  unique (subscription_id, term_id)
);

create table lpac_members (
  id              uuid primary key default gen_random_uuid(),
  firm_id         uuid not null default current_firm() references firms(id) on delete cascade,
  fund_id         uuid not null references funds(id) on delete cascade,
  partner_id      uuid not null references fund_partners(id),
  representative  text not null,
  email           text,
  since           date not null,
  until           date,
  created_by      text not null,
  created_at      timestamptz not null default now()
);

create table lpac_consents (
  id            uuid primary key default gen_random_uuid(),
  firm_id       uuid not null default current_firm() references firms(id) on delete cascade,
  fund_id       uuid not null references funds(id) on delete cascade,
  kind          text not null check (kind in ('conflict', 'valuation', 'extension', 'key_person', 'amendment', 'other')),
  topic         text not null,
  detail        text not null,
  requested_on  date not null,
  due_on        date,
  status        text not null default 'open' check (status in ('open', 'approved', 'declined', 'withdrawn')),
  decided_on    date,
  created_by    text not null,
  decided_by    text,
  created_at    timestamptz not null default now()
);

create table lpac_votes (
  id           uuid primary key default gen_random_uuid(),
  firm_id      uuid not null default current_firm() references firms(id) on delete cascade,
  consent_id   uuid not null references lpac_consents(id) on delete cascade,
  member_id    uuid not null references lpac_members(id),
  vote         text not null check (vote in ('approve', 'decline', 'abstain')),
  voted_on     date not null,
  note         text,
  recorded_by  text not null,
  unique (consent_id, member_id)
);

create table investor_requests (
  id           uuid primary key default gen_random_uuid(),
  firm_id      uuid not null default current_firm() references firms(id) on delete cascade,
  fund_id      uuid references funds(id) on delete cascade,
  partner_id   uuid references fund_partners(id),
  prospect_id  uuid references prospects(id) on delete set null,
  from_name    text not null,
  category     text not null check (category in ('ddq', 'reporting', 'tax', 'capital_account', 'side_letter', 'transfer', 'other')),
  subject      text not null,
  detail       text,
  received_on  date not null,
  due_on       date,
  status       text not null default 'open' check (status in ('open', 'answered', 'closed')),
  answer       text,
  answered_by  text,
  answered_on  date,
  created_by   text not null,
  created_at   timestamptz not null default now()
);

create trigger prospect_activities_append_only before update or delete on prospect_activities for each row execute function forbid_mutation();
create trigger dataroom_views_append_only before update or delete on dataroom_views for each row execute function forbid_mutation();

do $$
declare
  t text;
begin
  foreach t in array array['raises', 'prospects', 'prospect_activities', 'dataroom_docs', 'dataroom_links', 'dataroom_views', 'ddq_answers', 'subscriptions',
                           'closings', 'equalization_items', 'side_letter_terms', 'mfn_elections', 'lpac_members', 'lpac_consents', 'lpac_votes', 'investor_requests'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy firm_isolation on %I using (firm_id = current_firm()) with check (firm_id = current_firm())', t);
  end loop;
end $$;

grant select, insert, update on raises, prospects, dataroom_docs, dataroom_links, ddq_answers, subscriptions, closings, equalization_items,
  side_letter_terms, mfn_elections, lpac_members, lpac_consents, lpac_votes, investor_requests to vcos_app;
grant select, insert on prospect_activities, dataroom_views to vcos_app;
grant delete on equalization_items to vcos_app;
