# modules/

One folder per module, each a set of workflows and queries over the ledger:

- `outbox/` — built: the approval queue every module uses for anything that leaves VC OS

- `diligence/` — Phase 1: claims by workstream, verification status, contradiction board, question list for the next call
- `sourcing/` — Phase 2: program crawler, thesis scorer, weekly digest, coverage metric
- `ic-memo/` — Phase 2: drafting with the citation check, red team
- `execution/` — Phase 3: term sheet parser against NVCA baselines, uses `engines/`
- `portfolio/` — Phase 3: KPI collection, early warnings, initiatives
- `lp-reporting/` — Phase 4: ILPA Reporting and Performance templates

Modules read facts only through `ledger/repository.ts` and never import a
vendor SDK.
