-- 0004_tenancy.sql
-- Many firms, one database. Every firm-owned row carries firm_id, filled in
-- from the session setting app.firm_id, and Postgres row-level security
-- shows each firm only its own rows.
--
-- Firm-scoped code runs as the role vcos_app (lib/db.ts scopedDb does
-- `set local role vcos_app` plus app.firm_id in every transaction). Only
-- platform code (sign-in, the scheduler, migrations) uses the owner role,
-- which is not subject to these policies.

-- ---------------------------------------------------------------------------
-- Platform tables (not firm-scoped; vcos_app gets no access)
-- ---------------------------------------------------------------------------

create table firms (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  slug        text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  created_at  timestamptz not null default now()
);

create table users (
  id             uuid primary key default gen_random_uuid(),
  email          text not null unique check (email = lower(email) and email like '%@%'),
  name           text,
  created_at     timestamptz not null default now(),
  last_login_at  timestamptz
);

-- The provider account behind a user. A second provider account can't take
-- over an existing user just by reporting the same email.
create table user_identities (
  provider    text not null check (provider in ('google', 'microsoft')),
  subject     text not null,
  user_id     uuid not null references users(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (provider, subject)
);

create table memberships (
  firm_id     uuid not null references firms(id) on delete cascade,
  user_id     uuid not null references users(id) on delete cascade,
  role        text not null check (role in ('admin', 'partner', 'analyst')),
  created_at  timestamptz not null default now(),
  primary key (firm_id, user_id)
);

create table invitations (
  id           uuid primary key default gen_random_uuid(),
  firm_id      uuid not null references firms(id) on delete cascade,
  email        text not null check (email = lower(email)),
  role         text not null check (role in ('admin', 'partner', 'analyst')),
  invited_by   uuid references users(id),
  created_at   timestamptz not null default now(),
  accepted_at  timestamptz,
  unique (firm_id, email)
);

-- Tokens are stored hashed; the raw value only ever exists in the cookie or link.
create table sessions (
  token_hash  text primary key,
  user_id     uuid not null references users(id) on delete cascade,
  firm_id     uuid references firms(id) on delete set null,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null
);

create table login_tokens (
  token_hash  text primary key,
  email       text not null,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  used_at     timestamptz
);

create table oauth_states (
  state          text primary key,
  provider       text not null check (provider in ('google', 'microsoft')),
  purpose        text not null check (purpose in ('signin', 'connect')),
  code_verifier  text not null,
  user_id        uuid references users(id) on delete cascade,
  firm_id        uuid references firms(id) on delete cascade,
  connector_id   text,
  created_at     timestamptz not null default now(),
  expires_at     timestamptz not null
);

-- ---------------------------------------------------------------------------
-- Existing ledger rows (a pre-tenancy local database) move to one firm
-- ---------------------------------------------------------------------------

do $$
begin
  if exists (select 1 from entities) or exists (select 1 from evidence) then
    insert into firms (id, name, slug) values ('00000000-0000-0000-0000-000000000001', 'My fund', 'my-fund');
  end if;
end $$;

create function current_firm() returns uuid
language sql stable as $$ select nullif(current_setting('app.firm_id', true), '')::uuid $$;

-- ---------------------------------------------------------------------------
-- firm_id on every firm-owned table
-- ---------------------------------------------------------------------------

do $$
declare
  t text;
begin
  foreach t in array array['entities','entity_identifiers','entity_aliases','relations','evidence','claims',
                           'contradictions','merge_proposals','decisions','outbox','audit_log'] loop
    execute format('alter table %I add column firm_id uuid references firms(id) on delete cascade', t);
    execute format('update %I set firm_id = %L where firm_id is null', t, '00000000-0000-0000-0000-000000000001');
    execute format('alter table %I alter column firm_id set default current_firm()', t);
    if t <> 'audit_log' then
      execute format('alter table %I alter column firm_id set not null', t);
    end if;
    execute format('create index %I on %I (firm_id)', t || '_firm', t);
    execute format('alter table %I enable row level security', t);
    execute format('create policy firm_isolation on %I using (firm_id = current_firm()) with check (firm_id = current_firm())', t);
  end loop;
end $$;

-- Uniqueness is per firm: two firms can both track acme.com.
alter table entity_identifiers drop constraint entity_identifiers_pkey;
alter table entity_identifiers add primary key (firm_id, kind, value);
alter table evidence drop constraint evidence_source_content_hash_key;
alter table evidence add constraint evidence_firm_source_hash unique (firm_id, source, content_hash);

-- ---------------------------------------------------------------------------
-- The application role
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'vcos_app') then
    create role vcos_app nologin;
  end if;
  begin
    execute format('grant vcos_app to %I', current_user);
  exception when others then
    raise notice 'Could not grant vcos_app to %: grant it manually so the app can SET ROLE', current_user;
  end;
end $$;

grant usage on schema public to vcos_app;
grant select, insert, update, delete on entities, entity_identifiers, entity_aliases, relations,
  contradictions, merge_proposals, decisions, outbox to vcos_app;
-- Append-only tables: the app role can add rows and read them, nothing else.
grant select, insert on claims, evidence, audit_log to vcos_app;
grant usage on all sequences in schema public to vcos_app;
grant execute on function current_firm() to vcos_app;
