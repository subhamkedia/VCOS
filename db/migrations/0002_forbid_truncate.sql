-- 0002_forbid_truncate.sql
-- TRUNCATE skips row-level triggers, so 0001's append-only guard didn't
-- cover it. Statement-level triggers close the gap.

create trigger claims_no_truncate before truncate on claims
  for each statement execute function forbid_mutation();
create trigger evidence_no_truncate before truncate on evidence
  for each statement execute function forbid_mutation();
