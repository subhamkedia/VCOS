-- 0009_lp.sql
-- LP Reporting: funds and their terms, partners (LPs and the GP's own
-- commitment), capital calls and distributions with per-partner lines, fund
-- expenses, bank transactions for reconciliation, tax documents, quarterly
-- reports, and the LP portal. The math is in engines/fund-accounting.ts.
-- Money movements are append-only records or move through statuses with a
-- second approver; nothing here moves money.

create table funds (
  id           uuid primary key default gen_random_uuid(),
  firm_id      uuid not null default current_firm() references firms(id) on delete cascade,
  name         text not null,
  vintage      integer,
  currency     text not null default 'USD',
  inception    date not null,
  terms        jsonb not null,   -- FundTerms plus the GP commitment
  created_by   text not null,
  created_at   timestamptz not null default now(),
  updated_by   text,
  updated_at   timestamptz not null default now(),
  unique (firm_id, name)
);

create table fund_partners (
  id              uuid primary key default gen_random_uuid(),
  firm_id         uuid not null default current_firm() references firms(id) on delete cascade,
  fund_id         uuid not null references funds(id) on delete cascade,
  name            text not null,
  kind            text not null check (kind in ('pension', 'endowment_foundation', 'insurance', 'fund_of_funds', 'family_office', 'individual', 'corporate', 'sovereign', 'gp', 'other')),
  commitment_usd  numeric not null check (commitment_usd > 0),
  fee_paying      boolean not null default true,
  closing         integer not null default 1 check (closing >= 1),
  admitted_on     date not null,
  emails          text[] not null default '{}',
  tax_status      text check (tax_status in ('taxable', 'tax_exempt', 'foreign')),
  erisa           boolean not null default false,
  investor_status text check (investor_status in ('accredited', 'qualified_client', 'qualified_purchaser')),
  kyc_verified_on date,
  side_letter     text,
  created_by      text not null,
  created_at      timestamptz not null default now(),
  unique (fund_id, name),
  check (kind <> 'gp' or fee_paying = false)
);

-- A capital call: prepared by one person, approved by another before any notice is drafted.
create table capital_calls (
  id              uuid primary key default gen_random_uuid(),
  firm_id         uuid not null default current_firm() references firms(id) on delete cascade,
  fund_id         uuid not null references funds(id) on delete cascade,
  number          integer not null check (number > 0),
  notice_date     date not null,
  due_date        date not null,
  investments_usd numeric not null default 0 check (investments_usd >= 0),
  fees_usd        numeric not null default 0 check (fees_usd >= 0),
  expenses_usd    numeric not null default 0 check (expenses_usd >= 0),
  fee_detail      jsonb not null default '{}'::jsonb,
  purpose         text,
  status          text not null default 'draft' check (status in ('draft', 'approved', 'cancelled')),
  created_by      text not null,
  created_at      timestamptz not null default now(),
  approved_by     text,
  approved_at     timestamptz,
  unique (fund_id, number),
  check (due_date >= notice_date),
  check (approved_by is null or approved_by <> created_by)
);

create table call_items (
  id              uuid primary key default gen_random_uuid(),
  firm_id         uuid not null default current_firm() references firms(id) on delete cascade,
  call_id         uuid not null references capital_calls(id) on delete cascade,
  partner_id      uuid not null references fund_partners(id),
  investment_usd  numeric not null default 0,
  fee_usd         numeric not null default 0,
  expense_usd     numeric not null default 0,
  amount_usd      numeric not null check (amount_usd >= 0),
  received_usd    numeric not null default 0 check (received_usd >= 0),
  received_on     date,
  bank_txn_id     uuid,
  unique (call_id, partner_id)
);

create table distributions (
  id           uuid primary key default gen_random_uuid(),
  firm_id      uuid not null default current_firm() references firms(id) on delete cascade,
  fund_id      uuid not null references funds(id) on delete cascade,
  number       integer not null check (number > 0),
  paid_on      date not null,
  gross_usd    numeric not null check (gross_usd > 0),
  kind         text not null default 'cash' check (kind in ('cash', 'in_kind')),
  company_id   uuid references entities(id),
  purpose      text,
  carry_usd    numeric not null default 0 check (carry_usd >= 0),
  escrow_usd   numeric not null default 0 check (escrow_usd >= 0),
  waterfall    jsonb not null default '[]'::jsonb,
  status       text not null default 'draft' check (status in ('draft', 'approved', 'paid', 'cancelled')),
  created_by   text not null,
  created_at   timestamptz not null default now(),
  approved_by  text,
  approved_at  timestamptz,
  paid_by      text,
  unique (fund_id, number),
  check (approved_by is null or approved_by <> created_by)
);

create table distribution_items (
  id               uuid primary key default gen_random_uuid(),
  firm_id          uuid not null default current_firm() references firms(id) on delete cascade,
  distribution_id  uuid not null references distributions(id) on delete cascade,
  partner_id       uuid not null references fund_partners(id),
  gross_usd        numeric not null check (gross_usd >= 0),
  carry_usd        numeric not null default 0 check (carry_usd >= 0),
  net_usd          numeric not null check (net_usd >= 0),
  unique (distribution_id, partner_id)
);

-- Partnership expenses, in the ILPA reporting template's categories. A
-- correction is a reversing entry, never an edit.
create table fund_expenses (
  id            uuid primary key default gen_random_uuid(),
  firm_id       uuid not null default current_firm() references firms(id) on delete cascade,
  fund_id       uuid not null references funds(id) on delete cascade,
  incurred_on   date not null,
  amount_usd    numeric not null check (amount_usd <> 0),
  category      text not null check (category in ('organizational', 'legal', 'audit_tax', 'fund_admin', 'insurance', 'bank_interest', 'broken_deal', 'other')),
  description   text not null,
  related_party boolean not null default false,   -- a GP or affiliate charge to the fund (ILPA: internal chargeback)
  fee_offset    boolean not null default false,   -- a portfolio company fee to the GP that offsets management fees
  created_by    text not null,
  created_at    timestamptz not null default now()
);
create trigger fund_expenses_append_only before update or delete on fund_expenses for each row execute function forbid_mutation();

-- The fund's bank account, read only, for reconciling calls and distributions.
create table bank_transactions (
  id              uuid primary key default gen_random_uuid(),
  firm_id         uuid not null default current_firm() references firms(id) on delete cascade,
  fund_id         uuid not null references funds(id) on delete cascade,
  provider        text not null,
  external_id     text not null,
  posted_on       date not null,
  amount_usd      numeric not null,
  counterparty    text,
  memo            text,
  matched_item_id uuid references call_items(id),
  created_at      timestamptz not null default now(),
  unique (firm_id, provider, external_id)
);

create table tax_documents (
  id           uuid primary key default gen_random_uuid(),
  firm_id      uuid not null default current_firm() references firms(id) on delete cascade,
  fund_id      uuid not null references funds(id) on delete cascade,
  partner_id   uuid not null references fund_partners(id),
  tax_year     integer not null,
  kind         text not null check (kind in ('k1', 'k3', 'estimate')),
  status       text not null default 'pending' check (status in ('pending', 'delivered')),
  delivered_on date,
  note         text,
  updated_by   text not null,
  updated_at   timestamptz not null default now(),
  unique (partner_id, tax_year, kind)
);

-- A quarterly report: a snapshot of the numbers and the letter, prepared by
-- one person and approved by another. Approved reports are final.
create table lp_reports (
  id           uuid primary key default gen_random_uuid(),
  firm_id      uuid not null default current_firm() references firms(id) on delete cascade,
  fund_id      uuid not null references funds(id) on delete cascade,
  period       text not null check (period ~ '^\d{4}-Q[1-4]$'),
  version      integer not null check (version > 0),
  as_of        date not null,
  snapshot     jsonb not null,
  letter       jsonb not null,
  commentary   text,
  status       text not null default 'draft' check (status in ('draft', 'approved', 'withdrawn')),
  prepared_by  text not null,
  created_at   timestamptz not null default now(),
  approved_by  text,
  approved_at  timestamptz,
  unique (fund_id, period, version),
  check (approved_by is null or approved_by <> prepared_by)
);
create unique index lp_reports_one_approved on lp_reports(fund_id, period) where status = 'approved';

create or replace function lp_reports_final() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'reports are kept: withdraw one instead'; end if;
  if old.status = 'withdrawn' then raise exception 'a withdrawn report is final'; end if;
  -- An approved report can only be withdrawn; nothing in it changes.
  if old.status = 'approved' and (new.status <> 'withdrawn' or new.snapshot <> old.snapshot or new.letter <> old.letter
      or new.commentary is distinct from old.commentary or new.approved_by is distinct from old.approved_by) then
    raise exception 'an approved report is final';
  end if;
  return new;
end $$;
create trigger lp_reports_final before update or delete on lp_reports for each row execute function lp_reports_final();

-- An LP's private link to its own statements and the fund's approved reports.
create table lp_portal_links (
  id           uuid primary key default gen_random_uuid(),
  firm_id      uuid not null default current_firm() references firms(id) on delete cascade,
  partner_id   uuid not null references fund_partners(id) on delete cascade,
  token_hash   text not null unique,
  expires_at   timestamptz not null,
  created_by   text not null,
  created_at   timestamptz not null default now(),
  revoked_at   timestamptz,
  last_used_at timestamptz
);

do $$
declare
  t text;
begin
  foreach t in array array['funds', 'fund_partners', 'capital_calls', 'call_items', 'distributions', 'distribution_items', 'fund_expenses',
                           'bank_transactions', 'tax_documents', 'lp_reports', 'lp_portal_links'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy firm_isolation on %I using (firm_id = current_firm()) with check (firm_id = current_firm())', t);
  end loop;
end $$;

grant select, insert, update on funds, fund_partners, capital_calls, call_items, distributions, distribution_items, bank_transactions, tax_documents, lp_reports, lp_portal_links to vcos_app;
grant delete on call_items, distribution_items to vcos_app;
grant select, insert on fund_expenses to vcos_app;
