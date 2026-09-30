-- 0012_exits.sql
-- Exits and liquidity, inside Portfolio: each company's exit plan and
-- readiness; exit processes (a sale, an IPO, a secondary sale, a tender, a
-- wind-down) with their bids and the fund's consent; what a closed sale
-- leaves to collect (escrows, holdbacks, earnouts); listed shares with
-- their prices; QSBS reviews; each fund's life, extensions and wind-down;
-- and continuation vehicle elections. Money back stays in `realizations`,
-- which now records shares, the exit and the receivable it came from.

alter table decisions drop constraint if exists decisions_kind_check;
alter table decisions add constraint decisions_kind_check check (kind in
  ('pass', 'advance', 'ic_vote_pre', 'ic_vote_post', 'invest', 'follow_on', 'score_override', 'health_rating', 'reserve_plan', 'exit_consent'));

alter table valuations drop constraint if exists valuations_method_check;
alter table valuations add constraint valuations_method_check check (method in ('recent_round', 'milestone', 'revenue_multiple', 'exit', 'public_price', 'write_off', 'cost'));

create table exit_plans (
  id               uuid primary key default gen_random_uuid(),
  firm_id          uuid not null default current_firm() references firms(id) on delete cascade,
  company_id       uuid not null references entities(id),
  path             text not null check (path in ('acquisition', 'ipo', 'secondary', 'hold', 'wind_down')),
  target_year      integer check (target_year between 2000 and 2100),
  low_usd          numeric check (low_usd >= 0),
  base_usd         numeric check (base_usd >= 0),
  high_usd         numeric check (high_usd >= 0),
  probability_pct  numeric check (probability_pct between 0 and 100),
  buyers           text[] not null default '{}',
  readiness        jsonb not null default '{}'::jsonb,
  note             text,
  updated_by       text not null,
  updated_at       timestamptz not null default now(),
  unique (firm_id, company_id)
);

create table exits (
  id                   uuid primary key default gen_random_uuid(),
  firm_id              uuid not null default current_firm() references firms(id) on delete cascade,
  company_id           uuid not null references entities(id),
  kind                 text not null check (kind in ('acquisition', 'ipo', 'secondary', 'tender', 'buyback', 'wind_down')),
  stage                text not null default 'exploring' check (stage in ('exploring', 'preparing', 'marketing', 'offers', 'signed', 'closed', 'abandoned')),
  counterparty         text,
  expected_close       date,
  equity_value_usd     numeric check (equity_value_usd >= 0),
  our_expected_usd     numeric check (our_expected_usd >= 0),
  shares               numeric check (shares > 0),
  price_per_share      numeric check (price_per_share > 0),
  terms                jsonb not null default '{}'::jsonb,
  note                 text,
  consent_decision_id  uuid references decisions(id),
  closed_on            date,
  closing              jsonb,
  abandoned_reason     text,
  created_by           text not null,
  created_at           timestamptz not null default now(),
  updated_by           text,
  updated_at           timestamptz not null default now(),
  check (stage <> 'abandoned' or abandoned_reason is not null),
  check (stage <> 'closed' or closed_on is not null)
);

create table exit_bids (
  id           uuid primary key default gen_random_uuid(),
  firm_id      uuid not null default current_firm() references firms(id) on delete cascade,
  exit_id      uuid not null references exits(id) on delete cascade,
  bidder       text not null,
  kind         text not null check (kind in ('ioi', 'loi', 'final')),
  value_usd    numeric not null check (value_usd > 0),
  consideration text,
  received_on  date not null,
  note         text,
  created_by   text not null,
  created_at   timestamptz not null default now()
);

create table exit_receivables (
  id            uuid primary key default gen_random_uuid(),
  firm_id       uuid not null default current_firm() references firms(id) on delete cascade,
  exit_id       uuid not null references exits(id) on delete cascade,
  company_id    uuid not null references entities(id),
  kind          text not null check (kind in ('escrow', 'adjustment_escrow', 'holdback', 'expense_fund', 'earnout', 'deferred')),
  description   text not null,
  amount_usd    numeric not null check (amount_usd >= 0),
  expected_pct  numeric not null check (expected_pct between 0 and 100),
  due_on        date not null,
  status        text not null default 'pending' check (status in ('pending', 'partial', 'released', 'earned', 'claimed', 'forfeited')),
  settled_usd   numeric not null default 0 check (settled_usd >= 0),
  settled_on    date,
  note          text,
  created_by    text not null,
  created_at    timestamptz not null default now(),
  updated_by    text,
  updated_at    timestamptz not null default now(),
  check (settled_usd <= amount_usd)
);

create table public_holdings (
  id                  uuid primary key default gen_random_uuid(),
  firm_id             uuid not null default current_firm() references firms(id) on delete cascade,
  company_id          uuid not null references entities(id),
  exit_id             uuid references exits(id),
  ticker              text not null,
  exchange            text,
  listed_on           date not null,
  acquired_on         date not null,
  shares              numeric not null check (shares > 0),
  shares_outstanding  numeric check (shares_outstanding > 0),
  lockup_days         integer not null default 180 check (lockup_days between 0 and 1000),
  affiliate           boolean not null default false,
  created_by          text not null,
  created_at          timestamptz not null default now(),
  updated_by          text,
  updated_at          timestamptz not null default now(),
  unique (firm_id, ticker)
);

create table share_prices (
  id         uuid primary key default gen_random_uuid(),
  firm_id    uuid not null default current_firm() references firms(id) on delete cascade,
  ticker     text not null,
  on_date    date not null,
  close_usd  numeric not null check (close_usd > 0),
  volume     numeric check (volume >= 0),
  source     text not null default 'manual',
  created_by text not null,
  created_at timestamptz not null default now(),
  unique (firm_id, ticker, on_date)
);

-- Money back now says what it came from and, for shares, how many.
alter table realizations drop constraint if exists realizations_kind_check;
alter table realizations add constraint realizations_kind_check check (kind in
  ('sale', 'partial_sale', 'distribution', 'dividend', 'write_off', 'escrow_release', 'earnout', 'secondary', 'tender', 'public_sale', 'in_kind'));
alter table realizations add column exit_id uuid references exits(id);
alter table realizations add column receivable_id uuid references exit_receivables(id);
alter table realizations add column shares numeric;
alter table realizations add column price_usd numeric;
alter table realizations add column lp_distribution_id uuid references distributions(id);
alter table realizations add column detail jsonb not null default '{}'::jsonb;

-- An in-kind distribution waits in LP Reporting for a second person's
-- approval; the shares leave the fund's books when it's approved.
create table in_kind_plans (
  distribution_id    uuid primary key references distributions(id) on delete cascade,
  firm_id            uuid not null default current_firm() references firms(id) on delete cascade,
  public_holding_id  uuid not null references public_holdings(id),
  shares             numeric not null check (shares > 0),
  price_usd          numeric not null check (price_usd > 0),
  method             jsonb not null,
  allocation         jsonb not null,
  created_by         text not null,
  created_at         timestamptz not null default now()
);

create table qsbs_reviews (
  id             uuid primary key default gen_random_uuid(),
  firm_id        uuid not null default current_firm() references firms(id) on delete cascade,
  investment_id  uuid not null references investments(id),
  checks         jsonb not null,
  status         text not null check (status in ('eligible', 'not_eligible', 'unclear')),
  note           text,
  reviewed_by    text not null,
  created_at     timestamptz not null default now()
);

create table fund_life (
  fund_id              uuid primary key references funds(id) on delete cascade,
  firm_id              uuid not null default current_firm() references firms(id) on delete cascade,
  term_years           numeric not null check (term_years > 0 and term_years <= 30),
  max_extension_years  numeric not null default 2 check (max_extension_years >= 0 and max_extension_years <= 10),
  updated_by           text not null,
  updated_at           timestamptz not null default now()
);

create table fund_extensions (
  id                uuid primary key default gen_random_uuid(),
  firm_id           uuid not null default current_firm() references firms(id) on delete cascade,
  fund_id           uuid not null references funds(id) on delete cascade,
  years             numeric not null check (years > 0 and years <= 5),
  approved_via      text not null check (approved_via in ('gp', 'lpac', 'investors')),
  lpac_consent_id   uuid references lpac_consents(id),
  fee_change        text,
  note              text,
  created_by        text not null,
  created_at        timestamptz not null default now()
);

create table wind_down_items (
  firm_id     uuid not null default current_firm() references firms(id) on delete cascade,
  fund_id     uuid not null references funds(id) on delete cascade,
  key         text not null,
  status      text not null check (status in ('open', 'done', 'na')),
  note        text,
  updated_by  text not null,
  updated_at  timestamptz not null default now(),
  primary key (fund_id, key)
);

create table cv_processes (
  id                  uuid primary key default gen_random_uuid(),
  firm_id             uuid not null default current_firm() references firms(id) on delete cascade,
  fund_id             uuid not null references funds(id) on delete cascade,
  name                text not null,
  lead_buyer          text not null,
  company_ids         uuid[] not null default '{}',
  price_pct_of_nav    numeric not null check (price_pct_of_nav > 0 and price_pct_of_nav <= 200),
  reference_nav_usd   numeric not null check (reference_nav_usd > 0),
  launched_on         date not null,
  deadline            date not null,
  status_quo_offered  boolean not null,
  fairness_opinion    text,
  lpac_consent_id     uuid references lpac_consents(id),
  status              text not null default 'open' check (status in ('open', 'closed', 'abandoned')),
  created_by          text not null,
  created_at          timestamptz not null default now(),
  check (deadline > launched_on)
);

create table cv_elections (
  firm_id     uuid not null default current_firm() references firms(id) on delete cascade,
  process_id  uuid not null references cv_processes(id) on delete cascade,
  partner_id  uuid not null references fund_partners(id),
  choice      text not null check (choice in ('roll', 'sell', 'status_quo')),
  recorded_by text not null,
  recorded_at timestamptz not null default now(),
  primary key (process_id, partner_id)
);

create trigger exit_bids_append_only before update or delete on exit_bids for each row execute function forbid_mutation();
create trigger qsbs_reviews_append_only before update or delete on qsbs_reviews for each row execute function forbid_mutation();
create trigger fund_extensions_append_only before update or delete on fund_extensions for each row execute function forbid_mutation();

do $$
declare
  t text;
begin
  foreach t in array array['exit_plans', 'exits', 'exit_bids', 'exit_receivables', 'public_holdings', 'share_prices', 'in_kind_plans', 'qsbs_reviews', 'fund_life', 'fund_extensions',
                           'wind_down_items', 'cv_processes', 'cv_elections'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy firm_isolation on %I using (firm_id = current_firm()) with check (firm_id = current_firm())', t);
  end loop;
end $$;

grant select, insert, update on exit_plans, exits, exit_receivables, public_holdings, share_prices, fund_life, wind_down_items, cv_processes, cv_elections to vcos_app;
grant select, insert on exit_bids, in_kind_plans, qsbs_reviews, fund_extensions to vcos_app;
