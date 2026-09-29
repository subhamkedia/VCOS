# VC OS

An AI-native operating system for venture firms. Any firm signs up,
describes its fund and mandate, connects the tools it already uses, and
works in one web app with five modules: **Sourcing**, **Diligence**,
**Investment Execution**, **Portfolio Management & Value Creation** and **LP
Reporting**.

Underneath, every fact about a company is stored once as a **claim**, with
its source, date, confidence and the exact characters it came from. Scores,
diligence flags, memos and LP letters are all queries over that ledger. Each
firm's data is isolated by Postgres row-level security.

**Built so far:** the ledger, entity resolver and cited extractor; 28
connectors; multi-firm workspaces with Google, Microsoft and email sign-in;
onboarding (firm, fund, mandate, sectors, scoring) with live portfolio
construction math; connections you set up once and every module reuses;
the **Sourcing** module (scheduled feeds, portfolio websites, thesis fit);
**Meetings** (Google Calendar and Meet, Outlook and Teams, Zoom, Granola,
Fireflies, each call matched to the right company); the **Diligence**
module (research across every connected and public source, a checklist
that fills in from the ledger, founder questions, a contradiction board,
reference and customer call notes, round math against the fund, pass and
IC decisions, and an IC memo whose citations are checked in code); and an
approval queue for anything outbound.
**Next:** Investment Execution.

### How Diligence works

1. **Start a deal** on any company (from Sourcing, the Companies page, or by
   name and website).
2. **Gather everything.** One run pulls from each source the firm has
   connected (connect a tool once, in setup or Connections; sourcing,
   diligence and meetings all use it): meeting tools, Affinity, Gmail or
   Outlook, Drive, PitchBook, Harmonic, Crunchbase, Dealroom; and public
   sources that need no account: the company's website, news (GDELT), USPTO
   patents, SBIR awards, federal contracts and grants (USAspending), its job
   board, and SEC Form D filings. Public lookups by name keep only exact
   company-name matches, so a namesake's patents or contracts never land on
   the wrong company. Sources that aren't connected are listed as skipped,
   with the reason.
3. **Meetings match themselves.** Calendar invites carry attendee emails;
   recordings and notetakers carry the words. Invites and recordings join
   through the conference link, and a meeting is filed under a company by
   its attendees' email domains or addresses a person assigned before.
   Anything ambiguous waits on the Meetings screen, and the answer is
   remembered. The matcher's eval (`pnpm eval:meetings`) holds it to zero
   wrong automatic matches.
4. **The checklist fills in.** Team, market, product and technology,
   customers and traction, unit economics, round and terms, legal and
   compliance, and fit, with extra sections for hardware (TRL, MRL, bill of
   materials, pilots), regulated markets and sensitive technology (export
   controls, CFIUS, Treasury's outbound investment rules). Items show as
   missing, company-says, evidenced or verified from the ledger; people can
   mark done, not applicable or red flag, with a reason.
5. **Questions and conflicts.** Questions for the founders come from gaps,
   unverified numbers, conflicting sources and stalled pilots, and close
   themselves when evidence arrives. Send them as an email draft through
   the approval queue. On the contradiction board, explain a disagreement
   or settle it; settling writes a new fact and supersedes the old one.
6. **Round math and the memo.** Round terms become claims; the firm's check
   is checked against the mandate, target ownership and concentration
   limits in code (`engines/round-math.ts`). The IC memo is drafted from
   claims (or by Claude, beta), and a citation check drops any sentence
   that doesn't cite, or whose numbers don't match what it cites
   (`pnpm eval:memo`). A shareable version uses public facts only.
7. **Decide.** Pass with a reason code and a sentence, or send to IC
   (with a written reason if diligence isn't complete). Both are recorded
   as decisions with the state of diligence at that moment.

## Run the web app

```bash
pnpm install
pnpm build:web
pnpm seed:demo --email you@example.com   # optional: a workspace of fictional companies
pnpm web                                 # http://localhost:8787
```

Sign in with your email. Without Google or Microsoft configured, the
sign-in link is printed in the server log. A new email address gets an
empty workspace and the setup wizard. `pnpm dev` runs the API with Vite hot
reload on http://localhost:5173. `pnpm worker` runs scheduled sourcing feeds
for every firm.

For production:

| Variable | What it's for |
| --- | --- |
| `DATABASE_URL` | Postgres. The migrations create the `vcos_app` role that firm queries run as; the connecting user must be allowed to `SET ROLE vcos_app` (the migration grants it when it can). |
| `VCOS_SECRET_KEY` | 32 random bytes, base64 (`openssl rand -base64 32`). Encrypts every firm's connector credentials. Losing it means firms reconnect their tools. |
| `APP_URL` | The public URL. OAuth redirect URI is `APP_URL/api/auth/callback`. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | One Google OAuth app for sign-in, Gmail, Drive, Calendar and Meet. |
| `MS_CLIENT_ID`, `MS_CLIENT_SECRET`, `MS_TENANT` | One Microsoft Entra app for sign-in, Outlook, Outlook Calendar and Teams transcripts. |
| `ZOOM_CLIENT_ID`, `ZOOM_CLIENT_SECRET` | One Zoom user-managed OAuth app, so firms can connect Zoom cloud recordings. |
| `PATENTSVIEW_API_KEY` | Free USPTO PatentsView key for patent lookups in diligence. |
| `RESEND_API_KEY`, `MAIL_FROM` | Sends sign-in links and invitations. Without it they're printed to the log. |
| `ANTHROPIC_API_KEY` | Claim extraction from decks, calls and email. |
| `SEC_USER_AGENT` | Contact string SEC requires for Form D feeds. |

Vendor keys (Harmonic, PitchBook, Crunchbase, Dealroom, Affinity, Granola,
Fireflies) are not server settings: each firm adds its own under
Connections, and they're encrypted and used only for that firm.

## Try the ledger in two minutes

```bash
pnpm demo        # offline walk-through on fictional data, no keys needed
pnpm test        # 200+ tests on in-process Postgres
pnpm eval:meetings   # meeting-to-company matcher: zero wrong automatic matches
pnpm eval:memo       # IC memo citation check on labeled sentences
```

The demo ingests a company from Harmonic, an SEC Form D, a press article and
a founder call. It resolves all four to one entity and prints every claim
with its source. It flags that the founder says 34 people while Harmonic said
21 twelve days earlier. Add `ANTHROPIC_API_KEY` to `.env` and the demo uses
live Claude for extraction instead of scripted replies.

## The command line

The CLI works on one firm (`--firm <slug>`, or the only firm in a local
database) and reads vendor keys from `.env`, which is handy for trying a
connector before using it in the app.

```bash
cp .env.example .env            # add the keys you have (setup notes inside)
pnpm connectors                 # which sources are ready, and what each needs
pnpm connectors --check         # one cheap live call per configured source
pnpm db:migrate                 # local PGlite in .data/, or Postgres via DATABASE_URL

pnpm ingest harmonic acme.com --dry-run          # check a vendor mapping first
pnpm ingest harmonic acme.com                    # also: pitchbook, crunchbase, dealroom
pnpm ingest formd "Acme Robotics" --from 2025-01-01
pnpm ingest yc W26 --founders                    # a YC batch from the public directory
pnpm ingest web https://acme.com/about --company "Acme Robotics" --domain acme.com
pnpm ingest affinity "Acme Robotics"             # CRM record and its notes
pnpm ingest affinity-list 12345 --notes          # a whole pipeline list
pnpm ingest gmail "from:@acme.com newer_than:90d"   # or: outlook "acme"
pnpm ingest drive-search "Acme deck"             # then: ingest drive <file id> --company ...
pnpm ingest document ~/Downloads/acme.pdf --company "Acme Robotics" --url https://docsend.com/view/...
pnpm ingest transcript ~/Downloads/acme-call.vtt --company "Acme Robotics" --domain acme.com --date 2026-10-02
pnpm ingest granola <meeting-id> --company "Acme Robotics"

pnpm show acme.com              # everything the ledger knows, with sources and open contradictions
pnpm show acme.com --shareable  # only what a shareable output may cite (public sources)
pnpm resolve                    # merge proposals waiting for you
pnpm resolve accept <id>
pnpm outbox                     # CRM notes and email drafts waiting for your approval
pnpm outbox approve <id>        # creates the draft or note; nothing is ever sent
```

For production, `docker compose up -d` and set
`DATABASE_URL=postgres://vcos:vcos@localhost:5432/vcos`.

## What's here

| Path | What it does |
| --- | --- |
| `db/migrations/` | Entities, identifiers, aliases, relations, evidence, claims, contradictions, merge proposals, decisions, audit log. Evidence and claims are append-only, enforced by triggers (UPDATE, DELETE and TRUNCATE). |
| `ledger/predicates.ts` | The controlled vocabulary: 40 predicates with kind, unit, cardinality, tolerance and comparison window. Includes the pilot ladder (conversation → unpaid trial → paid pilot → production contract → expansion). |
| `ledger/repository.ts` | The only code that touches the database. Validates every claim, checks cited spans against the evidence, inherits access scope. Holds the read models (`companyProfile`) the CLI and the web app share, with access-scope filtering in SQL. |
| `ledger/contradictions.ts` | Finds claims that can't both be true. A self-reported number far from an independent source is high severity. |
| `agents/resolver/` | Entity resolution: hard identifiers first, then Fellegi-Sunter scoring on name, domain, founders and city. Ambiguous cases become merge proposals; Claude can suggest a pick, a human accepts. |
| `agents/extractor/` | Claim extraction with the Claude Citations API. Every claim carries the exact quote and character offsets. Lines without a valid citation are rejected. |
| `connectors/` | Harmonic, PitchBook, Crunchbase, Dealroom, SEC EDGAR Form D, the YC directory, web pages, Affinity, Gmail, Outlook, Google Drive, DocSend and local files, transcripts (files or Granola MCP). All flow through one `ingest()` pipeline; `registry.ts` lists each one's keys and scope. |
| `ledger/labels.ts` | Readable names for everything the app shows: predicates ("Team headcount"), source types ("Self-reported"), scopes, evidence kinds, identifiers and enum values. Served at `/api/vocabulary`; the CLI uses the same labels. |
| `engines/portfolio-construction.ts` | Fund math from the profile: fees over the fund's life, investable capital, reserves, new-to-reserve ratio, implied number of companies, average check and entry ownership. Unit-tested; the setup wizard shows it live. |
| `connectors/portfolio-pages.ts` | Follow any public portfolio page. Reads outbound company links and JSON-LD, respects robots.txt, refuses private addresses, and records each company as a claim citing the page. |
| `modules/firm/` | The firm profile: firm, fund (size, structure, closes, term, fees, carry, reserves, target count, checks, LPs, IC), mandate, sectors and scoring weights, validated across fields and saved as versions. |
| `modules/meetings/` | Meeting sync and the matcher (`match.ts`): attendee domains, learned contacts and conference links decide which company a call was with; the rest waits for a person. |
| `modules/diligence/` | Deals, the checklist (`checklist.ts`), founder questions (`questions.ts`), research runs (`gather.ts`), the contradiction board, decisions, and the IC memo with its citation check (`memo.ts`, `memo-check.ts`). |
| `agents/memo-writer/` | Claude drafts memo prose from claims only (never raw evidence); the same citation check applies. Beta until it has 20 real cases in `evals/memo-writer/`. |
| `engines/round-math.ts` | Post-money, entry ownership, check plus reserves as a share of the fund, and checks against the mandate. |
| `modules/outbox/` | The approval queue for anything that leaves VC OS. Agents queue; a person approves; then it runs once. |
| `evals/resolver/` | Resolver eval and the Phase 0 gate. |
| `evals/extraction/` | Extraction eval: precision, recall, citation validity, pass^k. |
| `CLAUDE.md` | Rules for Claude Code in this repo. Read it before changing anything. |

## The Phase 0 gate

```bash
pnpm eval:resolver:build-yc                              # 200 YC 2026 companies
pnpm eval:resolver --set evals/resolver/yc2026 --gate 0.95
```

Pass requires ≥95% accuracy and zero false merges on the YC 2026 set: 200
real companies across the 2026 batches, with real Launch HN names, former
names and look-alike YC companies. The bundled synthetic set scores 100%,
but it was written alongside the resolver, so treat it as a smoke test.
`evals/resolver/README.md` explains both sets.

## Known limits

- Vendor mappings (Harmonic, PitchBook, Crunchbase, Dealroom, Affinity)
  follow each vendor's documentation and are tested against fixtures, not
  live accounts. Run `--dry-run` once per vendor before trusting one.
  PitchBook's docs are licence-gated, so its paths sit in `PITCHBOOK_PATHS`.
- DocSend has no API for people viewing a shared link: download the deck
  and ingest the file with `--url`. Scanned PDFs need OCR, which isn't built.
- Granola tool names come from Granola's docs. `pnpm ingest granola-tools`
  lists the live ones; pass `--tool` if they differ.
- Resolver weights are hand-set. Re-estimate them from labeled pairs once
  you have a few thousand, or move batch dedupe to Splink (same model).
- Web pages rendered by JavaScript come back nearly empty. A headless-browser
  fetcher is a Phase 1 task.
- Thesis fit is v0: sector keywords (stemmed), geography and stage, with
  every reason cited. The weighted dimensions (team, moat, GTM) are scored
  in Diligence from evidence.
- Diligence, Execution, Portfolio and LP Reporting have their pages and
  scope in the app; their workflows are the next phases.
