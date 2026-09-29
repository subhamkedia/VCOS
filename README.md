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

**Built so far:** the ledger, entity resolver and cited extractor; 33
connectors; multi-firm workspaces with Google, Microsoft and email sign-in;
onboarding (firm, fund, mandate, sectors, scoring) with live portfolio
construction math; connections you set up once and every module reuses;
the **Sourcing** module (scheduled feeds, portfolio websites, thesis fit);
**Meetings** (Google Calendar and Meet, Outlook and Teams, Zoom, Granola,
Fireflies, each call matched to the right company); the **Diligence**
module (research across every connected and public source, a checklist
that fills in from the ledger, founder questions, a contradiction board,
reference and customer call notes, round math against the fund, pass and
IC decisions, and an IC memo whose citations are checked in code); the
**Investment Execution** module (IC votes before and after discussion under
the firm's approval rule, term sheets checked against NVCA and house terms,
pro-forma cap tables with SAFE and note conversion, returns through the
waterfall, a closing checklist with DocuSign, Carta and OFAC, wire controls,
and the investment record); the **Portfolio & Value Creation** module
(numbers from each company's QuickBooks or Xero, a founder portal with no
login, KPI requests, Standard Metrics, Visible, spreadsheets and update
emails; runway, burn and plan warnings; fair value marks approved by a
second person; gross MOIC, IRR, DPI and TVPI; reserves and follow-ons;
board meetings; value-creation work); and an approval queue for anything
outbound.
**Next:** LP Reporting.

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

### How Investment Execution works

1. **IC meeting.** A partner sets up the meeting with its voting members
   and a chair. Each member votes yes, no or abstain with a conviction from
   1 to 5 and a reason, **before discussion and without seeing anyone
   else's vote**; the chair opens discussion only when everyone has voted
   or recused. Members vote again after discussion. The firm's rule
   (simple majority, two thirds, unanimous, a champion with full conviction
   and no veto, or the managing partner) is applied to the final votes in
   code (`modules/execution/ic.ts`), with a quorum of more than half.
   Both rounds are kept as decisions, and the page shows who moved. A
   decline needs a pass reason, like any pass.
2. **Term sheet.** Terms are entered as structured fields and kept as
   versions. Each term is compared with the NVCA model (October 2025
   update) and market norms, and with the firm's **house terms** (Firm
   settings → House terms): liquidation preference and participation,
   dividends, anti-dilution, redemption, pay-to-play, the option pool,
   board, protective provisions, pro rata and information rights, the
   management rights letter (required when the fund has ERISA investors),
   founder vesting, no-shop, OISP representations for AI, semiconductor and
   quantum companies, and QSBS. Marking a version signed records the round
   as facts cited to it.
3. **Cap table and returns.** Import the company's cap table (a Carta,
   Pulley or spreadsheet CSV, or Carta's investor API) and add SAFEs, notes
   and earlier series. `engines/cap-table.ts` computes the pro forma:
   price per share with the option pool in the pre-money, post-money SAFEs
   at their cap over company capitalization (excluding the round's pool
   increase, as the YC SAFE defines it), pre-money SAFEs and notes with
   simple interest, discounts and MFN. `engines/waterfall.ts` runs each
   exit through seniority, participation caps and each class's convert
   decision, with converted SAFEs in a shadow series preferred at their own
   price. `engines/anti-dilution.ts` does broad- and narrow-based weighted
   average and full ratchet.
4. **Closing.** The checklist is built from the signed terms: the NVCA
   document set for a priced round (SPA and disclosure schedule, charter,
   IRA, voting and ROFR/co-sale agreements, consents, the charter filing,
   a certified cap table) or the SAFE or note; compliance (OFAC sanctions
   screening of the company, founders, legal name and lead against the SDN
   and Consolidated lists, KYC, conflicts, the OISP determination, export
   controls and CFIUS); funding; and after closing (closing set, shares
   issued, Form D within 15 days, QSBS statement, OISP notice within 30
   days, board onboarding). DocuSign status syncs onto the items; a
   DocuSign envelope is only ever created as a **draft**, through the
   approval queue, and a person sends it from DocuSign.
5. **Wire and close.** Following the FBI's guidance on business email
   compromise: instructions come through a secure channel, someone calls
   the company back at a number they already had (not one from the
   instructions), and two people approve; the person who entered and
   confirmed the instructions can't approve first, and new instructions
   start over. VC OS keeps only the account's last four digits and never
   moves money: a partner sends the wire and records the bank's reference.
   Once every required item is done, a partner records the close: the
   investment (amount, shares, price, ownership, rights) becomes the record
   Portfolio starts from.

### How Portfolio & Value Creation works

A company joins the portfolio when its deal closes in Execution (or a
follow-on is recorded). Every number is a claim with its source, so the
same month from two sources never double counts: the company's books win
over what a founder typed, which wins over a model's reading of an email.

1. **Numbers in, every way firms get them.**
   - The founder connects **QuickBooks Online or Xero** (read only) from a
     private link the firm sends: no VC OS account. VC OS reads the monthly
     income statement and balance sheet (revenue, total expenses, cash in
     bank) for the last twelve closed months. Refresh tokens rotate on every
     call and are stored encrypted for that firm.
   - The same **founder portal** takes a month's numbers typed in, with the
     metrics the firm asked for first. It shows the company only what it
     reports, never the firm's marks, ratings or notes, and links expire and
     can be turned off.
   - **KPI requests**: pick the month, the due date and a handful of
     metrics; VC OS drafts the email with the portal link in your own
     mailbox for you to approve and send (or gives you the text to copy).
   - The firm's **Standard Metrics** or **Visible** account, a **spreadsheet**
     export, figures typed in from a board deck, and **founder update emails**
     in Gmail or Outlook (read by the extractor when Claude is configured).
2. **Early warnings.** `engines/kpi.ts` works out net burn (reported, else
   expenses minus revenue, else the change in cash, and says which), runway
   on the last three months, growth, the burn multiple (net burn over net new
   ARR), plan versus actual, headcount changes, net revenue retention and
   fleet uptime. Warnings cite the figures they rest on: runway under 12
   months (raise now; Carta puts the median seed-to-Series A gap near 20
   months) or under 6 (at risk), stale data, revenue behind plan, burn over
   plan, expensive growth, shrinking teams. A partner or analyst sets the
   company's health rating with a reason; the signals' suggestion is kept
   next to it.
3. **Fair value marks.** By the methods the IPEV Valuation Guidelines
   (December 2025 edition, in effect from 1 April 2026) and ASC 820
   recognize: calibrated to a recent round (the price of a recent round is
   not a default, and a round over a year old is flagged), milestone
   adjustment, a revenue multiple with cash and debt and the company's
   preferences applied through the waterfall (`engines/valuation.ts`),
   exit, write-off, and cost only near the investment date. Inputs the
   ledger knows are filled in and cited; each mark shows its steps and needs
   a written reason; a different person approves it (enforced in the
   database too), and approved marks can't be edited.
4. **Performance and reserves.** `engines/fund-metrics.ts`: gross MOIC,
   IRR (XIRR on dated flows), DPI, RVPI and TVPI on invested capital, the
   share of capital below cost and the largest position. The reserve pool
   (fund size x reserves %) against what's deployed in follow-ons and still
   planned per company. Reserve plans and follow-on decisions (invest, invest
   less, pass) are decisions with reasons; an investment records the check.
   Sales, distributions and write-offs record money back.
5. **Board and value creation.** Board meetings with resolutions; when the
   board decides a sale, financing or recapitalization, the record must say
   how the preferred and common holders' different interests were handled
   (In re Trados, Del. Ch. 2013). The help the firm gives (hires, customer
   and partner introductions, fundraising, government programs) is tracked to
   an outcome; introductions are double opt-in email drafts.

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
pnpm portfolio                  # every holding: value, MOIC, runway, warnings
pnpm portfolio sync "Weldloop"  # refresh one company's numbers from its books and your tools
```

For production, `docker compose up -d` and set
`DATABASE_URL=postgres://vcos:vcos@localhost:5432/vcos`.

## What's here

| Path | What it does |
| --- | --- |
| `db/migrations/` | Entities, identifiers, aliases, relations, evidence, claims, contradictions, merge proposals, decisions, audit log. Evidence and claims are append-only, enforced by triggers (UPDATE, DELETE and TRUNCATE). |
| `ledger/predicates.ts` | The controlled vocabulary: 59 predicates with kind, unit, cardinality, tolerance and comparison window. Includes the pilot ladder (conversation → unpaid trial → paid pilot → production contract → expansion). |
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
| `engines/cap-table.ts`, `waterfall.ts`, `anti-dilution.ts` | The pro-forma cap table (option pool shuffle, SAFE and note conversion), exit waterfalls and anti-dilution adjustments. Unit-tested against worked examples. |
| `modules/execution/` | IC meetings and the approval rules (`ic.ts`), term sheets and house terms (`terms.ts`), the closing checklist (`closing.ts`), wire controls and the close. |
| `engines/kpi.ts`, `fund-metrics.ts`, `valuation.ts` | Monthly KPI series, net burn, runway, burn multiple and early warnings; gross MOIC, XIRR, DPI, RVPI, TVPI and the reserve pool; fair value marks by IPEV-recognized methods. Unit-tested. |
| `modules/portfolio/` | The portfolio overview and company view, KPI entry and imports and the sync (`kpis.ts`), the founder portal and KPI requests (`portal.ts`), marks (`marks.ts`), and health, reserves, follow-ons, realizations, board meetings and value creation (`work.ts`). `pnpm portfolio` on the command line. |
| `connectors/accounting.ts`, `portfolio-platforms.ts` | QuickBooks Online and Xero (OAuth, monthly reports), Standard Metrics and Visible. |
| `connectors/docusign.ts`, `carta.ts`, `ofac.ts` | Signature status and draft envelopes, cap tables from Carta or any export, and Treasury's sanctions lists. |
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
- LP Reporting has its page and scope in the app; its workflow is next.
- QuickBooks, Xero, Standard Metrics and Visible follow each vendor's API
  documentation and are tested against fixtures, not live accounts.
  Standard Metrics' and Visible's paths sit in `STANDARD_METRICS_PATHS` and
  `VISIBLE_PATHS`; check them with `pnpm connectors --check`. Accounting
  figures are accrual-basis income statement totals and bank balances;
  capital expenditure and working capital aren't in net burn unless the
  company reports burn itself.
- Portfolio performance is gross, on invested capital. Net returns to LPs
  (after fees, expenses and carry) belong to LP Reporting.
- Term sheets are entered as fields; reading one from a PDF is not built.
  Carta's API is partner-only (invite): without access, import the export.
  DocuSign status and drafts follow DocuSign's eSignature REST docs and are
  tested against fixtures. OFAC screening is name matching: a potential
  match needs a person to clear it, and it doesn't replace counsel's
  review.
