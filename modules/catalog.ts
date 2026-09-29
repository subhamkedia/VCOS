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
    id: "diligence", name: "Diligence", path: "/diligence", status: "next", phase: 1,
    summary: "Turns decks, calls and data-room files into cited claims, and shows where sources disagree.",
    does: [
      "Claims by workstream: team, technology, market, customers, financials",
      "Contradiction board: self-reported numbers against independent sources",
      "Questions for the next founder call, drawn from gaps and conflicts",
      "IC memo draft where every factual sentence cites a claim",
    ],
    reads: ["The ledger", "Decks, transcripts, email", "Your thesis dimensions"],
  },
  {
    id: "execution", name: "Investment Execution", path: "/execution", status: "planned", phase: 2,
    summary: "From term sheet to close: terms compared with your standards, and the math done in code.",
    does: [
      "Parse term sheets and flag departures from NVCA and your house terms",
      "Pro-forma cap tables and ownership after the round",
      "Closing checklist with document status",
      "IC votes recorded before and after discussion",
    ],
    reads: ["Term sheets and legal documents", "Fund size, reserves and ownership targets"],
  },
  {
    id: "portfolio", name: "Portfolio & Value Creation", path: "/portfolio", status: "planned", phase: 3,
    summary: "Tracks every portfolio company's KPIs and flags trouble early; plans and logs the help you give.",
    does: [
      "KPI collection from founder updates, with each number cited",
      "Early warnings on runway, burn and missed plans",
      "Value-creation initiatives: hires, customer intros, follow-on prep",
      "Reserves planning against the fund model",
    ],
    reads: ["Founder updates and board decks", "Cap tables", "Fund model"],
  },
  {
    id: "lp-reporting", name: "LP Reporting", path: "/lp-reporting", status: "planned", phase: 4,
    summary: "Quarterly reports and capital account statements in ILPA formats, with numbers from code.",
    does: [
      "ILPA reporting and performance templates",
      "TVPI, DPI and IRR computed by tested code, never by a model",
      "Portfolio commentary drafted from cited claims, shareable scope only",
      "Every LP-facing document goes out only after approval",
    ],
    reads: ["Fund structure and commitments", "Portfolio valuations", "Public-scope claims only"],
  },
];
