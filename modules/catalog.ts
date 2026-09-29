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
    id: "execution", name: "Investment Execution", path: "/execution", status: "next", phase: 2,
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
