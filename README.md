# VC OS

An AI-native operating system for venture firms. Any firm signs up,
describes its fund and mandate, connects the tools it already uses, and
works in one web app with six modules: **Sourcing**, **Diligence**,
**Investment Execution**, **Portfolio Management & Value Creation**, **LP
Reporting** and **Fundraising & Investor Relations**, with **Compliance**
as a layer they all share.

Underneath, every fact about a company is stored once as a **claim**, with
its source, date, confidence and the exact characters it came from. Scores,
diligence flags, memos and LP letters are all queries over that ledger. Each
firm's data is isolated by Postgres row-level security.

**Built so far:** the ledger, entity resolver and cited extractor; 37
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
board meetings; value-creation work; exits and liquidity: exit plans and
processes, the fund's consent, escrows and earnouts, listed shares under the
lock-up and Rule 144, in-kind distributions, QSBS, a liquidity forecast and
each fund's term, continuation vehicle and wind-down); the **LP Reporting** module (the
investor register from your fund administrator, capital calls and
distributions allocated to the cent with the carry waterfall, receipts
reconciled from Mercury or any bank's statement, capital accounts for the
quarter, year and inception, net IRR and TVPI after fees and carry beside
gross, quarterly reports after the ILPA templates with a letter that cites
the books and public sources only, and a private portal for each
investor); the **Fundraising & IR** module (the LP pipeline with weighted
coverage of the target, a tracked data room, a DDQ library drafted from the
firm's records, investor onboarding without an account, closings checked
against the offering's legal limits that feed LP Reporting's register,
equalization for later closings, side letters and MFN elections, the LPAC
and investor requests); **Compliance** across all of them (the regulatory
calendar built from the other modules' records, screening of each deal for
outbound investment, CFIUS and export controls before it can close, the
code of ethics with the restricted list, personal trading reports and
pre-clearance, pay-to-play and gifts, the conflicts register, annual
attestations, and Marketing Rule reviews of data room material); and an
approval queue for anything outbound.
**Next:** the Phase 0 gate on the YC 2026 set.

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
6. **Exits and liquidity.** Each company has an exit plan: the likely path
   (a sale, an IPO, a secondary sale, holding, a wind-down), when, low, base
   and high cases to the fund, likely buyers and a readiness checklist (cap
   table, IP assignments, audited financials, change-of-control clauses,
   409A, QSBS statements, board alignment). An exit process (a sale, IPO,
   secondary sale, tender, buyback or wind-down) moves through its stages
   with bids; the fund's consent as a shareholder is a partner's decision
   with its reasons. Closing is previewed, then a partner records it
   (`engines/exits.ts`):
   - **A sale** splits the fund's consideration into cash at closing,
     indemnity and price adjustment escrows, holdbacks, the sellers'
     representative expense fund, earnouts (carried at their probability,
     never their maximum) and deferred payments, and any of the buyer's
     shares. A partner records each release, claim or missed earnout
     (anything short needs a reason); the company's status becomes a cited
     claim.
   - **An IPO** records the listed shares. Lock-up (180 days by default) and
     Rule 144 date the first sale; an affiliate's sales are held to the
     volume limit (the greater of 1% of the shares outstanding and the
     average weekly volume) with the Form 144 reminder. Listed shares are
     valued at the closing price with no discount for the lock-up (ASC 820 as
     amended by ASU 2022-03), and 5% and insider holdings put Schedule 13G
     and Form 3 on the compliance calendar and the company on the restricted
     list suggestions.
   - **A secondary sale or tender** records the shares sold, the price and
     the gain over cost; the mark is scaled to the shares left.
   - Listed shares are sold (a partner records it) or **distributed in kind**:
     priced by the LPA's method (the closing price, or an average over
     trading days), split into whole shares by investor and the GP's carry,
     and prepared as a draft in LP Reporting; the shares leave the books
     when a second person approves it, and the notices give each investor's
     share count. Cash received and not yet distributed is flagged, a click
     from a draft distribution.
   - **QSBS** (Section 1202) is reviewed per investment and dated: stock
     issued after July 4, 2025 excludes 50%, 75% and 100% of the gain after
     three, four and five years, up to $15 million or ten times basis per
     investor; earlier stock needs five years (up to $10 million). A sale
     inside a year of the next step up is flagged.
   - The **liquidity page** adds it up: processes under way, what's due back
     and when, listed shares and when they can be sold, and expected cash by
     year from receivables, listed shares and planned exits.
   - **Each fund's tail**: its term and extensions (past the GP's discretion,
     the LPAC's approved consent must be on record), what it still holds,
     the options (an extension, selling or distributing listed shares,
     direct and strip secondaries, a continuation vehicle, winding up), a
     continuation vehicle process checked against ILPA's 2023 guidance (a
     status quo option, at least 30 calendar and 20 business days to elect,
     silence treated as a sale, a fairness opinion and the LPAC's approval
     before it closes) with each investor's election, and the wind-down
     checklist.

   Sources: SRS Acquiom's M&A Deal Terms Study (escrow size and survival,
   earnout prevalence), SEC Rule 144 and Form 144, Exchange Act Rules 13d-1
   (as amended in 2023) and Section 16, Rule 14e-1 for tender offers, ASC 820
   and ASU 2022-03, Internal Revenue Code Sections 1202 and 1045 as amended by
   the One Big Beautiful Bill Act (July 4, 2025), and ILPA's continuation fund
   guidance (2023).

### How LP Reporting works

A fund is set up from the firm profile's fund: its management fee and
step-down, carried interest, hurdle, catch-up, waterfall and GP commitment
are copied to the fund and kept there (the LPA governs; later profile edits
don't rewrite its history). All the math is `engines/fund-accounting.ts`,
unit-tested; nothing here moves money or sends anything.

1. **Investors.** Add limited partners by hand or import the register your
   fund administrator exports (Carta, Juniper Square, AngelList or a
   spreadsheet; their APIs aren't open to firms). Each has a commitment,
   closing, notice emails, tax and investor status, KYC date and side
   letter terms. The GP's own commitment pays no fee or carry.
2. **Capital calls.** Enter what the call is for (investments, expenses,
   a management fee period) and preview each investor's share before
   saving: split by commitment to the cent, the fee charged by day count on
   fee-paying commitments in the investment period and on invested or
   committed capital after it, less fee offsets (fees the GP received from
   portfolio companies), with a warning under ILPA's 10 business days'
   notice and a block on calling more than an investor has left. A partner
   who didn't prepare it approves it; then one notice per investor is
   drafted in your mailbox, with a warning that bank details never change by
   email (wire fraud targets exactly these notices).
3. **Receipts.** Mercury (a read-only API token) or a statement export from
   any bank: incoming wires are matched to what each investor owes by
   amount, then by the sender's name when two owe the same; the rest waits
   for a person to match. Re-importing a statement adds nothing twice.
4. **Distributions.** The engine splits the amount by commitment and runs
   the waterfall on the fee-paying investors' share: return of capital, the
   preferred return (compounding), the GP catch-up, then the carry split.
   Whole of fund (ILPA's preferred model) or deal by deal against each
   investment's own cost, with carry held in escrow (ILPA Principles 3.0 ask
   for at least 30%). Approved by a second person, notices drafted, then
   recorded as paid once the money has gone.
5. **Capital accounts and returns.** Every partner's statement for the
   quarter, the year and inception to date, in the ILPA Reporting
   Template's order: beginning balance, contributions, distributions,
   management fees net of offsets, partnership expenses (in the template's
   categories, related-party charges flagged), realized and unrealized
   gains, carried interest allocated, ending balance. Gains come from
   Execution's investment records, Portfolio's approved marks and
   realizations. Accrued carry is what a sale at today's marks would pay;
   clawback exposure is shown each period. Net IRR, TVPI and DPI to
   fee-paying investors (from their own cash flows and ending balances) sit
   beside gross returns on the portfolio with equal prominence, as the SEC
   Marketing Rule and the ILPA Performance Template ask.
6. **Quarterly reports.** Preparing one snapshots the quarter's numbers and
   drafts a letter. Every factual sentence cites the books or a public
   claim about a portfolio company (filtered to shareable scopes in SQL);
   the GP's commentary is labeled as opinion, and any figure in it must
   match the report or it's rejected. A different person approves it; an
   approved report is final (enforced in the database) and a correction is
   a new version. Exports: capital accounts, fees and expenses, the
   performance cash flows, and the schedule of investments, as CSV.
7. **The investor portal.** Each investor gets a private, expiring,
   revocable link (drafted into a notice when a report is approved) showing
   its own statement, the approved reports, its calls, distributions and
   K-1 status, and nothing about any other investor.
8. **Deadlines and tax.** Quarterly reports within 45 days (the annual one
   within 90), audited financial statements within 120 days under the
   custody rule's audit provision, Schedules K-1 by March 15 (September 15
   with an extension), and the annual Form ADV amendment within 90 days of
   year end; K-1 and K-3 delivery tracked by investor.

Sources: ILPA Reporting Template v2.0 and Performance Template (2025), ILPA
Principles 3.0 and its capital call and distribution notice guidance, the
SEC Marketing Rule (206(4)-1) and its March 2025 FAQ on extracted
performance, the custody rule's audit provision (206(4)-2), IRS
instructions for Form 1065 Schedules K-1 and K-3, Form ADV instructions,
and Mercury's API reference. The SEC's 2023 private fund adviser rules,
including the quarterly statement rule, were vacated by the Fifth Circuit
in June 2024, so the ILPA templates and the LPA set the standard.

### How Fundraising & Investor Relations works

A raise starts from the firm profile's fund (name, target, hard cap, closing
dates); a partner sets the offering's terms with counsel: the Investment
Company Act exemption (3(c)(1), a qualifying venture capital fund, or
3(c)(7)), Regulation D (506(b) or 506(c)), the minimum commitment, whether
the fund operates as a VCOC, and the LPA's equalization rate.

1. **The pipeline.** Prospective LPs by stage (identified, contacted, first
   meeting, in diligence, soft-circled, committed, closed, declined), with
   the ask, soft circle, odds, owner and next step, and every change logged.
   Coverage of the target is closed commitments plus the weighted pipeline.
   A decline needs its reason. Prospects come in by hand, from a CSV or CRM
   export, or from an Affinity list.
2. **The data room.** Documents are versioned, and a second person reviews
   each before any investor sees it (for marketing material, that's the
   Marketing Rule review). Each prospect gets a private, expiring, revocable
   link; it acknowledges confidentiality first, and every view and download
   is recorded on its record: the best signal of real interest.
3. **The DDQ.** A library in the ILPA DDQ 2.0's sections. What the firm's
   records support is drafted from them with the source named: the firm,
   team and strategy from the profile, terms from the fund, the IC process,
   the valuation, reporting and wire controls VC OS runs, and performance
   only from an approved LP report, net beside gross. A second person
   approves each answer; only approved answers are exported, and answers
   over a year old are flagged.
4. **Subscriptions.** A committed investor gets a private link to the
   questionnaire (no account, never bank details): its Rule 501(a)
   accredited basis, qualified purchaser basis for a 3(c)(7) fund, benefit
   plan and pooled-vehicle status, tax form, FOIA status, and for an entity
   its 25% owners. The firm screens the investor and its owners against
   OFAC's lists, checks Parallel Markets where connected, clears KYC (a
   potential match needs a written reason), records how accreditation was
   verified (a 506(c) offering needs more than self-certification; SEC
   staff accept a $200,000 or $1 million minimum investment with written
   representations), and sends the subscription documents as a DocuSign
   draft. A partner accepts, or rejects with a reason.
5. **Closings.** A draft closing is checked against everyone admitted so far
   plus the newcomers (hard cap, 100 or 250 beneficial owners, $12 million
   for a qualifying venture fund, qualified purchasers, 506(c) verification,
   the 25% benefit plan test, pooled investors that may need a look-through)
   and each investor (KYC, sanctions, signatures). A different person
   approves it. Approval admits the investors to LP Reporting's register,
   creating the fund at the first closing, and gives the Form D date (15
   days after the first sale). At a later closing, equalization
   (`engines/fund-accounting.ts`) re-splits earlier calls: newcomers pay in
   their share and their fee from the first closing, with interest at the
   LPA's rate to earlier investors, who get their excess back (callable
   again). Capital accounts show the interest on its own line; NAV doesn't
   move.
6. **Side letters and MFN.** Negotiated terms are recorded by kind. After the
   final closing, each MFN holder is offered the electable terms granted to
   investors with equal or smaller commitments (LPAC seats never), with a
   window; elected terms join its side letter. Terms that oblige the firm
   (reporting, excuse rights, confidentiality, tax) are listed to keep.
7. **Investor relations.** The LP advisory committee: seats, consent
   requests (conflicts, valuations, extensions), each member's vote, and an
   outcome checked against a majority of current members. Investor requests
   are logged with a due date (10 days by default) and flagged when late.

Sources: ILPA DDQ 2.0 and Diversity Metrics Template, Regulation D Rules
501(a) (as amended in 2020), 503 and 506, the SEC staff's March 12, 2025
no-action letter on 506(c) verification, Investment Company Act sections
3(c)(1), 3(c)(7) and 2(a)(51) and the SEC's 2024 qualifying venture capital
fund adjustment, the Department of Labor's plan asset regulation (the 25%
test and the VCOC exception), and common LPA and side letter practice for
equalization and MFN elections.

### How Compliance works

Compliance isn't a separate product module: every module feeds it and two
of them stop at it. An admin sets the adviser's regulatory status
(registered with the SEC, an exempt reporting adviser, state-registered, or
not an adviser), the CCO, the fiscal year end and the gift limit. Rules are
code in `engines/compliance.ts`, unit-tested, with the citation in each
result; the system flags and dates, and the CCO and counsel decide.

1. **The calendar.** Built from the records, not typed in: Form ADV within
   90 days of the fiscal year end; for a registered adviser, Form PF at $150
   million in private fund assets (sized from LP Reporting's funds), the
   audit within 120 days, the annual compliance review and code of ethics
   reports; Form D 15 days after a fund's first closing and its annual
   amendment while the offering continues, and a state notice for each
   state an investor was admitted from (from Fundraising's closings);
   Treasury's outbound notice 30 days after a notifiable deal closes (from
   Execution). A recorded filing closes an obligation; code of ethics
   reports close when everyone on the team has filed, and until then the
   item names who hasn't. A fund's Form D can be looked up on EDGAR.
2. **Deal screening.** Before a deal closes, someone answers the screening:
   outbound investment under 31 CFR Part 850 (a covered foreign person in
   AI, semiconductors or quantum; prohibited or notifiable by the rule's
   thresholds), export control classification, and CFIUS (a TID business
   and a foreign investor getting board, information or decision rights),
   with counsel's view required whenever CFIUS may apply. When the firm
   requires it, Execution won't record the close without a screening, and
   a prohibited result can never close.
3. **Code of ethics.** The restricted list, with suggestions from the
   portfolio (board seats, companies that listed); holdings reports
   (initial and annual) and quarterly transaction reports, private to the
   person and the reviewers; and pre-clearance of IPOs and private
   placements (the rule requires it) and listed securities, flagged when
   they hit the restricted list. Someone other than the requester decides,
   and a denial or a restricted-list approval needs a note.
4. **Pay to play and gifts.** Each state or local political contribution is
   pre-cleared against the Rule 206(4)-5 de minimis ($350 per election where
   the person can vote, $150 where they can't) and flagged when it would
   trigger the two-year time-out. Gifts and entertainment are logged; over
   the firm's limit, a reviewer decides.
5. **Conflicts.** A register, filled from the records (a company held by
   more than one fund, related-party charges to a fund, LPAC conflict
   consents) or by hand, each with its mitigation and status.
6. **Attestations and marketing.** Each person acknowledges the code of
   ethics and insider trading policy (and the compliance manual, for a
   registered adviser) each year. Marketing material in the data room
   (the deck, track record, DDQ, financials) is approved with the Marketing
   Rule checklist: net beside gross, the required periods, hypothetical and
   extracted performance, testimonials, fair and balanced. A registered
   adviser must confirm every check; the review is kept either way.

Sources: Advisers Act Rules 204-1, 204(b)-1, 204A-1, 206(4)-1, 206(4)-2,
206(4)-5 and 206(4)-7; Regulation D Rule 503 and state notice filing
practice; 31 CFR Part 850 (effective January 2, 2025) and 31 CFR Part 800;
Exchange Act Sections 13(d) and 16. Dates reflect rule changes as of
September 2026: the amended Form PF's compliance date is July 1, 2027, the
investment adviser AML rule is delayed to January 1, 2028, and the SEC has
proposed rescinding the pay-to-play rule, which applies until it's
rescinded.

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
pnpm portfolio liquidity        # exits under way, escrows and earnouts due, listed shares, the forecast
pnpm portfolio exits "SiteGrid" # one company's exit plan, processes, receivables and QSBS
pnpm portfolio fund-life "Demo Fund II"         # a fund's term, extensions and options for the tail
pnpm lp                         # every fund: committed, called, NAV, net TVPI and IRR
pnpm lp accounts "Demo Fund II" # each investor's capital account and net returns
pnpm lp calendar "Demo Fund II" 2026            # reports, K-1s, audit and Form ADV deadlines
pnpm lp bank "Demo Fund II" --file statement.csv  # match receipts (or --since 2026-01-01 for Mercury)
pnpm lp report "Demo Fund II" 2026-Q3           # prepare a report for a second person to approve
pnpm lp export <report id> capital-accounts     # or fees-expenses, performance, investments
pnpm fundraising                                # every raise: target, closed, weighted pipeline, coverage
pnpm fundraising pipeline "Demo Fund III"       # prospects by stage with next steps and data room activity
pnpm fundraising investors "Demo Fund III"      # subscriptions and what each still needs before a closing
pnpm fundraising ddq --out ddq.md               # the approved DDQ answers as a document
pnpm fundraising requests                       # investor requests, oldest due first
pnpm compliance                                 # the obligations calendar: due, overdue and filed
pnpm compliance screenings                      # each deal's regulatory screening, and deals in closing without one
pnpm compliance restricted                      # the restricted list, and companies that may belong on it
pnpm compliance conflicts --detect              # find conflicts in the records, then list the register
pnpm compliance requests                        # pre-clearances, contributions and gifts waiting for review
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
| `engines/exits.ts` | A sale's consideration (cash, escrows, holdbacks, earnouts, stock), lock-up and Rule 144 sale windows, in-kind pricing and whole-share allocation, QSBS tiers, fund life, tail options, continuation vehicle elections and the liquidity forecast. Unit-tested. |
| `modules/portfolio/exits.ts`, `value.ts` | Exit plans and processes, the fund's consent, closings, receivables, listed shares and prices, in-kind and cash distributions, QSBS reviews, the liquidity overview and each fund's tail; `value.ts` values a holding across private shares, receivables and listed shares. |
| `connectors/accounting.ts`, `portfolio-platforms.ts` | QuickBooks Online and Xero (OAuth, monthly reports), Standard Metrics and Visible. |
| `engines/fund-accounting.ts` | Allocation to the cent, management fees by day count with step-down and offsets, the carry waterfall (whole of fund or deal by deal, hurdle, catch-up, escrow), capital accounts, accrued carry and clawback, net returns, the reporting calendar. Unit-tested. |
| `modules/lp/` | Funds, investors and register imports (`funds.ts`), calls, receipts, bank reconciliation, distributions and expenses (`capital.ts`), the books and statements (`books.ts`), quarterly reports, the cited letter and exports (`reports.ts`), and the investor portal (`portal.ts`). `pnpm lp` on the command line. |
| `engines/fundraising.ts` | The weighted pipeline, the offering's limits (investor counts, qualified purchasers, 506(c) verification, the 25% ERISA test, hard cap, look-through) and MFN eligibility. Unit-tested. |
| `modules/fundraising/` | Raises and the pipeline (`pipeline.ts`), the data room (`dataroom.ts`), the DDQ library (`ddq.ts`), subscriptions and onboarding (`subscriptions.ts`), closings and equalization (`closings.ts`), side letters and MFN (`sideletters.ts`), the LPAC and investor requests (`ir.ts`). `pnpm fundraising` on the command line. |
| `engines/compliance.ts` | The obligations calendar by adviser status, the pay-to-play de minimis, outbound investment and CFIUS classification, and the Marketing Rule checklist. Unit-tested. |
| `modules/compliance/` | The shared compliance layer: the calendar, filings and Form D lookup, deal screening, the code of ethics, pay to play, gifts, conflicts and attestations (`index.ts`), and the gates Execution and Fundraising call (`gate.ts`). `pnpm compliance` on the command line. |
| `connectors/parallel.ts` | Parallel Markets: accreditation and KYC status, read only. |
| `connectors/bank.ts` | Mercury (read only) and bank statement CSVs. No payment or transfer function exists. |
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
- LP Reporting's fund accounting covers the common venture LPA: fees on
  commitments then a step-down, pro rata calls, and whole-of-fund or
  deal-by-deal carry. It doesn't yet model subscription credit lines (the
  ILPA Performance Template's with-and-without-line returns), recallable
  distributions, fee waivers, or multi-currency funds. Tax documents are tracked, not prepared: K-1s come
  from the fund's tax preparer. Mercury follows its API reference and is
  tested against fixtures; other banks come in as statement CSVs.
- QuickBooks, Xero, Standard Metrics and Visible follow each vendor's API
  documentation and are tested against fixtures, not live accounts.
  Standard Metrics' and Visible's paths sit in `STANDARD_METRICS_PATHS` and
  `VISIBLE_PATHS`; check them with `pnpm connectors --check`. Accounting
  figures are accrual-basis income statement totals and bank balances;
  capital expenditure and working capital aren't in net burn unless the
  company reports burn itself.
- Fundraising flags the offering's legal limits; it doesn't replace fund
  counsel. Parallel Markets' paths follow its public documentation and sit
  in `PARALLEL_PATHS` (check them with `pnpm connectors --check`). Data room
  files aren't watermarked, and the subscription agreement itself is signed
  in DocuSign, not in VC OS. Equalization covers capital, the newcomer's
  fee and interest; LPAs that also re-allocate earlier distributions or
  realized gains need an adjustment by hand.
- Exits record what happened and prepare drafts; they don't trade or move
  shares. Share prices come in by hand or as a CSV from a broker or data
  site (there's no market data feed). Consideration comes from the funds
  flow a person enters; the escrow's release odds are the person's
  judgment. QSBS dates and caps are a guide for tax counsel, not advice; a
  continuation vehicle's investor elections are recorded as they come in,
  not collected in VC OS.
- Compliance screens and dates; it doesn't give legal advice, file
  anything with a regulator, or connect to a brokerage for trade feeds
  (people report their own holdings and trades). The outbound, CFIUS and
  export answers are a first pass from the facts a person enters; counsel
  decides covered transactions. Pay-to-play checks the de minimis for each
  contribution; the two-year look-back for new hires is a manual step.
- Portfolio performance is gross, on invested capital; net returns to LPs
  (after fees, expenses and carry) are in LP Reporting.
- Term sheets are entered as fields; reading one from a PDF is not built.
  Carta's API is partner-only (invite): without access, import the export.
  DocuSign status and drafts follow DocuSign's eSignature REST docs and are
  tested against fixtures. OFAC screening is name matching: a potential
  match needs a person to clear it, and it doesn't replace counsel's
  review.
