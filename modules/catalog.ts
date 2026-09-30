/**
 * The modules of VC OS, in the order a deal moves through them. The web
 * app's navigation and module pages render from this list, so a module's
 * status and scope are stated once.
 */
export interface ModuleInfo {
  id: string;
  name: string;
  path: string;
  status: "live" | "next" | "planned";
  phase: number;
  summary: string;
  does: string[];
  reads: string[];
}

export const MODULES: ModuleInfo[] = [
  {
    id: "sourcing", name: "Sourcing", path: "/sourcing", status: "live", phase: 1,
    summary: "Finds companies that fit your mandate, from the sources you connect, on the cadence you set.",
    does: [
      "Pull companies from YC batches, Form D filings, your CRM pipeline and your inbox",
      "Enrich what it finds from Harmonic, PitchBook, Crunchbase or Dealroom",
      "Score each company against your thesis, with the reason for every point",
      "Resolve duplicates, so a company found twice is one record",
    ],
    reads: ["Firm profile and thesis", "Connected sources"],
  },
  {
    id: "diligence", name: "Diligence", path: "/diligence", status: "live", phase: 1,
    summary: "Everything your tools and public sources know about a company, its calls, a checklist that fills in from the ledger, and a cited IC memo.",
    does: [
      "Gather from every connected tool once: meetings, CRM, email, Drive, PitchBook, Harmonic and more",
      "Public sources: the company's site, news, patents, SBIR and federal awards, job boards, filings",
      "Meetings from Zoom, Teams, Meet, Granola and Fireflies matched to the right company",
      "Checklist by workstream, questions for the founders, and a board for conflicting sources",
      "IC memo where every factual sentence cites a claim, checked in code",
    ],
    reads: ["The ledger", "Meetings and notes", "Connected tools", "Your fund model and thesis"],
  },
  {
    id: "execution", name: "Investment Execution", path: "/execution", status: "live", phase: 2,
    summary: "From IC to a closed investment: committee votes, terms against your standards, the round modelled in code, and a controlled close.",
    does: [
      "IC meetings: independent votes before discussion, final votes after, your approval rule applied in code",
      "Term sheets checked term by term against the NVCA model and your house terms",
      "Pro-forma cap table with SAFE and note conversion and the option pool, and your returns at each exit",
      "Closing checklist by security, with DocuSign status, OFAC screening, OISP and QSBS steps",
      "Wire controls: call-back on a known number and two approvers; VC OS never moves money",
    ],
    reads: ["The IC memo and diligence", "Cap table (Carta or a CSV export)", "House terms and your fund's LPs"],
  },
  {
    id: "portfolio", name: "Portfolio & Value Creation", path: "/portfolio", status: "live", phase: 3,
    summary: "Every company the fund holds: its numbers from the books and founders, early warnings, fair value marks, reserves and follow-ons, board meetings, and the help you give.",
    does: [
      "Numbers from the company's QuickBooks or Xero, a founder portal with no login, KPI requests, spreadsheets, Standard Metrics or Visible, and founder update emails; each figure cited",
      "Early warnings: runway, burn above plan, revenue behind plan, burn multiple, shrinking teams, stale data",
      "Fair value marks by IPEV-recognized methods, prepared by one person and approved by another",
      "Gross MOIC, IRR, DPI, RVPI and TVPI; the reserve pool; follow-on decisions with their reasons",
      "Board meetings with resolutions and conflict review; value-creation work measured by outcome",
    ],
    reads: ["Investment records from Execution", "The company's books and founder updates", "Fund size and reserves"],
  },
  {
    id: "lp-reporting", name: "LP Reporting", path: "/lp-reporting", status: "live", phase: 4,
    summary: "Your investors, capital calls and distributions, capital accounts, and quarterly reports in ILPA formats, with every number computed in code.",
    does: [
      "Investor register imported from your fund administrator, with the GP's commitment, closings, tax and investor status",
      "Capital calls and distributions allocated to the cent, the carry waterfall applied, approved by a second person, notices drafted for you to send",
      "Receipts reconciled from Mercury or any bank's statement export; VC OS never moves money",
      "Capital accounts for the quarter, year and inception to date; net IRR, TVPI and DPI after fees and carry beside gross",
      "Quarterly reports after the ILPA templates, a letter that cites the books and public sources only, and a private portal for each investor",
    ],
    reads: ["Fund terms from your firm profile", "Investments from Execution", "Marks and realizations from Portfolio", "Public-scope claims only"],
  },
  {
    id: "fundraising", name: "Fundraising & IR", path: "/fundraising", status: "live", phase: 4,
    summary: "Raise the fund and look after its investors: the LP pipeline, a tracked data room, the DDQ, investor onboarding, closings, side letters, the LPAC and investor requests.",
    does: [
      "LP pipeline by stage with soft circles, weighted coverage of the target, next steps and the reason for every decline",
      "A data room with private links, confidentiality acknowledgement and view tracking; documents reviewed by a second person first",
      "A DDQ library in the ILPA DDQ 2.0's sections, drafted from your records with sources, approved before it's shared",
      "Investor onboarding without an account: accreditation, qualified purchaser status, ERISA, tax and beneficial owners; OFAC and KYC checks",
      "Closings checked against the hard cap, investor-count limits, 506(c) verification and the 25% ERISA test; equalization for later closings",
      "Side letters with MFN elections, the LPAC's consents and votes, and investor requests with due dates",
    ],
    reads: ["Your firm profile and fund terms", "LP Reporting's approved reports", "Affinity, DocuSign, Parallel Markets, Gmail or Outlook"],
  },
];
