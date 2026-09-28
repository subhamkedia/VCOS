-- 0003_outbox.sql
-- Everything that would leave the system waits here for a human.
-- Agents insert 'pending' rows; only a person moves them to 'approved', and
-- only then does the executor act. Channels are drafts and CRM notes: there
-- is deliberately no channel that sends a message.

create table outbox (
  id           uuid primary key default gen_random_uuid(),
  channel      text not null check (channel in ('affinity_note', 'gmail_draft', 'outlook_draft')),
  entity_id    uuid references entities(id),
  summary      text not null,
  payload      jsonb not null,
  status       text not null default 'pending'
               check (status in ('pending', 'approved', 'rejected', 'done', 'failed')),
  proposed_by  text not null,
  decided_by   text,
  decided_at   timestamptz,
  result       jsonb,
  error        text,
  created_at   timestamptz not null default now(),
  check (status in ('pending') or decided_by is not null),
  check (decided_by is null or decided_by like 'human:%')
);
create index outbox_status on outbox(status, created_at);
