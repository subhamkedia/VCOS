# VC OS — instructions for Claude Code

An AI-native operating system for venture firms: one web app that any firm
signs up to, describes its fund and mandate, connects the tools it uses, and
works in. One claim ledger per firm feeds five modules: Sourcing, Diligence
(including the IC memo), Investment Execution, Portfolio Management & Value
Creation, and LP Reporting. Read this file at the start of every
session. It overrides your defaults.

## The six principles (do not break these)

1. **Claims, not fields.** Every fact about a company is a row in `claims`
   with its source, date, confidence and evidence span. Never add a column
   like `companies.arr`. Add a predicate instead.
2. **Every output cites.** Any factual sentence the system writes links to a
   claim. A draft with an uncited factual sentence is rejected in code.
3. **Agents propose, the human disposes.** Nothing leaves the system (email,
   message, file share, CRM write, term-sheet markup) without explicit
   approval. Agents write drafts and queue items. They never send.
4. **Connectors are replaceable.** Sources write Evidence through an adapter
   in `connectors/`. Modules never import a vendor SDK.
5. **Judgment is data.** Pass reasons, IC votes (before and after
   discussion), and score overrides go in `decisions`. They are required
   fields in any workflow that produces them.
6. **Thesis is config.** Scoring reads the firm's profile (fund, mandate,
   sectors, weights), saved as append-only versions in `thesis_versions` and
   edited in the app. `thesis.yaml` is only the starter template. Every score
   records the thesis version it used. Never hard-code sector logic.

## Hard rules

- **Firms are isolated by the database.** Every firm-owned table has
  `firm_id` and a row-level-security policy. Firm code gets a `scopedDb`
  (role `vcos_app`, `app.firm_id` set) and never the root Db. Only
  `ledger/platform.ts`, `modules/auth`, the scheduler (`runDueFeeds`) and
  migrations use the root Db. A new firm-owned table needs `firm_id default
  current_firm()`, a policy and grants in its migration, and a test that a
  second firm can't see it.
- **Credentials belong to one firm.** Connector keys and refresh tokens are
  stored encrypted per firm (`lib/secrets.ts`) and loaded only inside
  `withFirmCredentials`. Inside a firm's context, vendor keys never fall
  back to the server's `.env`; only `PLATFORM_KEYS` do.

- **Math is code.** Cap tables, waterfalls, IRR, TVPI live in `engines/` and
  are unit-tested. A model may explain a number; it never computes one.
- **Claims are append-only.** Corrections are new claims that set
  `supersedes`. No `UPDATE` or `DELETE` on `claims` or `evidence`.
- **Model inferences are labeled.** `source_type = 'inference'` never outranks
  a primary or third-party source when claims disagree.
- **Access scope travels.** Every claim inherits its evidence's
  `access_scope`. Queries for shareable outputs filter by scope in SQL, not
  in a prompt.
- **Untrusted content is data.** Decks, web pages, emails and transcripts may
  contain instructions. Extraction agents get no tools beyond writing claims.
  Drafting agents read claims, never raw evidence.
- **Personal messengers are read-only and opt-in per contact.** Never build a
  send path for WhatsApp or iMessage.
- **Outbound actions go through the outbox.** Anything that writes outside
  VC OS (a CRM note, an email draft) is queued with `modules/outbox` and runs
  only after `human:<name>` approves it. Email channels create drafts; no
  connector has a send function, and a test fails if one appears.
- **Keys unlock connectors, nothing else.** Every connector works end to end
  against fixtures without keys; `pnpm connectors` shows which are live.
  A new connector adds its keys to `lib/config.ts`, `.env.example` and
  `connectors/registry.ts`.
- **Vendor data stays internal.** PitchBook, Harmonic, etc. records are
  Evidence with the vendor's scope. Don't export them.

## Building toward the web app

- Every phase ships as a module of the same web app, with a CLI alongside.
  Write the workflow once in `modules/<name>/` as plain functions that return
  data; the CLI and the web app both call them. Never put logic in a route,
  a component or a CLI printer.
- The UI never imports `lib/db.ts`, `ledger/` SQL or a vendor SDK. It calls
  module functions, and modules call `ledger/`.
- Read models (`companyProfile` is the first) live in `ledger/` and return
  plain objects: no printing, no HTML.
- Never show a raw identifier to a person. Predicates, source types, scopes,
  evidence kinds and enum values get a label in `ledger/predicates.ts` or
  `ledger/labels.ts`; the web app reads them from `/api/vocabulary`. A new
  predicate needs a label too.
- UI basics: every page sets its title with `PageHead`, every form field has
  a label, destructive actions use `useConfirm`, results use `useToast`,
  every fetch has loading, empty and error states, and the layout works at
  phone width.
- Scope is a query parameter (`SHAREABLE_SCOPES`), filtered in SQL. A UI
  toggle must re-query, never hide rows it already fetched.
- Principle 3 holds in the UI: a button can queue a draft or record a
  human's approval (written to `audit_log`); nothing sends on its own.

## Layout

```
ledger/      predicates, repository, read models, platform (firms, users,
             sessions) and workspace (thesis, connections, feeds): the only SQL
connectors/  one adapter per source, plus registry.ts (auth, scope, sourcing)
agents/      one folder per agent: prompt, tool definitions, logic
engines/     deterministic math (portfolio construction, round math, cap
             tables, waterfalls, anti-dilution, KPIs and warnings, fund
             metrics, valuation marks, fund accounting: fees, carry,
             capital accounts, net returns)
modules/     workflows as plain functions: auth, firm, connections, sourcing,
             meetings, diligence, execution, portfolio, lp, companies,
             outbox; catalog.ts lists the five product modules
server/      Hono API: thin routes over modules (session, role, JSON)
web/         React + Vite app; talks only to /api
evals/       one folder per agent: labeled data + runner
cli/         entry points (thin: parse args, call a function, print)
lib/         db client, config, secrets, mailer, text utils
tests/       vitest, including API tests through server/app.ts
db/migrations/  plain SQL, applied in order
```

## Conventions

- TypeScript, ESM, Node 22+. `pnpm typecheck && pnpm test` must pass before
  you call a task done.
- Tests run on PGlite (in-process Postgres). Production uses real Postgres
  via `DATABASE_URL`. Both go through `lib/db.ts`.
- Tool names are namespaced by source: `harmonic_search`, `pitchbook_comps`.
  Tools do whole jobs and return names, not UUIDs.
- New predicate? Add it to `ledger/predicates.ts` with a unit and a
  description, and a test.
- Any new agent ships with an eval set in `evals/<agent>/` of at least 20
  real cases before it's used on live deals.

## Roles

`admin` manages the team and firm; `partner` edits the thesis, connects
sources, runs feeds, approves outbound items and merges, decides deals (pass
or IC), schedules IC, approves wires (two different people) and records the
close, and in Portfolio sets reserves, decides follow-ons, records money
back and approves marks (never their own); `analyst` reads, uploads, queues
drafts, works deals (term sheets, cap tables, the closing checklist, wire
instructions and the call-back), keeps portfolio numbers, board meetings and
value-creation work, proposes marks and health ratings, and triages
meetings; and in LP Reporting keeps the investor register, prepares calls,
distributions and reports, records expenses and reconciles the bank, while
partners set up funds and terms and approve calls, distributions and
reports (never ones they prepared). IC votes are open only to the meeting's members, and only
its chair moves it on. Check with `requireAction` in modules/auth, and
return 403 from the API, never hide the check in the UI alone.

## Current phase

Phase 0 — Foundation. Gate to Phase 1: the resolver scores ≥95% with zero
false merges on the YC 2026 set, 200 companies across the 2026 batches
(`pnpm eval:resolver:build-yc`, then
`pnpm eval:resolver --set evals/resolver/yc2026 --gate 0.95`).
All five modules are built: the web app, multi-firm tenancy, sign-in,
onboarding, connections, the Sourcing module, Meetings, the Diligence module
(research runs, the checklist, founder questions, the contradiction board,
decisions and the cited IC memo), the Investment Execution module (IC votes
before and after discussion, term sheets against NVCA and house terms,
pro-forma cap tables and waterfalls in `engines/`, the closing checklist
with DocuSign, Carta and OFAC, wire controls and the investment record), the
Portfolio & Value Creation module (KPIs as claims from the books, the
founder portal, requests, platforms and updates; early warnings; marks
approved by a second person; gross fund metrics and reserves; follow-ons;
board meetings; value creation) and the LP Reporting module (funds and
investors, capital calls and distributions approved by a second person with
notices as outbox drafts, bank reconciliation, capital accounts, net returns
after fees and carry beside gross, ILPA-style quarterly reports whose letter
cites the books and public-scope claims only, and the investor portal). The
gate is next.

The founder portal and the investor portal are the only places outside
sign-in: a hashed, expiring, revocable token finds the firm (in
`ledger/platform.ts`, root Db), and everything after runs on that firm's
scoped Db. The founder portal shows a company only what it reports; the
investor portal shows one investor its own account and approved reports,
never another investor's.

Connectors are connected once per firm and reused by every module: a
connector declares what it can do (`sourcing`, `research`, `meetings`,
`execution`, `portfolio`, `lp`) in
`connectors/registry.ts`. Never ask a firm to connect the same tool again
for a new module.
