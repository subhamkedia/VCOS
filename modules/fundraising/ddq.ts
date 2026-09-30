import type { Db } from "../../lib/db.js";
import { answers, approveAnswer, getProspect, insertActivity, upsertAnswer } from "../../ledger/fundraising.js";
import { funds, reports } from "../../ledger/lp.js";
import { getProfile, PROFILE_OPTIONS } from "../firm/profile.js";
import { FundraisingInvalid, text, today, usd } from "./common.js";

/**
 * The due diligence questionnaire library. Sections follow the ILPA Due
 * Diligence Questionnaire 2.0 (firm, team, strategy, investment process,
 * portfolio construction, fund terms, track record, valuation, reporting,
 * operations, legal and compliance, ESG, diversity, technology and
 * cybersecurity); the questions are our own wording of the topics LPs ask
 * about. Answers the firm's records can support are drafted from them, each
 * naming its source; everything else a person writes. Any change goes back
 * to draft, a second person approves, and only approved answers are shared.
 * A DDQ is marketing material under the SEC Marketing Rule, which is why
 * performance answers come only from approved reports, net beside gross.
 */

export interface Question { key: string; section: string; question: string }

export const DDQ_SECTIONS = [
  "Firm", "Team", "Strategy", "Investment process", "Portfolio construction", "Fund terms", "Track record", "Valuation", "Reporting",
  "Operations", "Legal and compliance", "ESG", "Diversity, equity and inclusion", "Technology and cybersecurity",
] as const;

export const DDQ_QUESTIONS: Question[] = [
  { key: "firm.overview", section: "Firm", question: "Describe the firm: legal name, founding, headquarters and offices." },
  { key: "firm.ownership", section: "Firm", question: "Who owns the general partner and the management company, and in what shares?" },
  { key: "firm.aum", section: "Firm", question: "What are the firm's assets under management and the funds it has raised?" },
  { key: "firm.succession", section: "Firm", question: "What is the succession plan for the firm's leadership?" },
  { key: "team.investment", section: "Team", question: "Who is on the investment team, and how long have they worked together?" },
  { key: "team.key_person", section: "Team", question: "Who are the key persons, and what happens under the key person provision?" },
  { key: "team.compensation", section: "Team", question: "How is carried interest shared across the team, and how does it vest?" },
  { key: "team.turnover", section: "Team", question: "Which investment professionals have joined or left in the last five years, and why?" },
  { key: "strategy.thesis", section: "Strategy", question: "What is the fund's strategy: stages, sectors, geographies and check sizes?" },
  { key: "strategy.edge", section: "Strategy", question: "What gives the firm an advantage in sourcing, selecting and supporting companies?" },
  { key: "process.sourcing", section: "Investment process", question: "How does the firm source investments?" },
  { key: "process.decision", section: "Investment process", question: "How are investment decisions made and recorded?" },
  { key: "process.value_creation", section: "Investment process", question: "How does the firm support portfolio companies after investing?" },
  { key: "construction.plan", section: "Portfolio construction", question: "What is the portfolio construction plan: number of companies, initial checks, reserves and concentration limits?" },
  { key: "construction.co_invest", section: "Portfolio construction", question: "How are co-investment opportunities allocated?" },
  { key: "terms.economics", section: "Fund terms", question: "What are the fund's key terms: size, GP commitment, management fee, carried interest, hurdle, waterfall and term?" },
  { key: "terms.credit_facility", section: "Fund terms", question: "Does the fund use a subscription credit facility, and how is its effect on returns reported?" },
  { key: "track.performance", section: "Track record", question: "What is the performance of the firm's funds, net and gross?" },
  { key: "track.attribution", section: "Track record", question: "Which investments drove performance, and which were written off?" },
  { key: "valuation.policy", section: "Valuation", question: "How are portfolio investments valued, by whom, and how often?" },
  { key: "reporting.lp", section: "Reporting", question: "What do investors receive, in what format, and how soon after each quarter?" },
  { key: "ops.service_providers", section: "Operations", question: "Who are the fund's administrator, auditor, legal counsel and bank?" },
  { key: "ops.controls", section: "Operations", question: "How are capital calls, distributions and wires controlled?" },
  { key: "legal.registration", section: "Legal and compliance", question: "Is the adviser registered with the SEC or an exempt reporting adviser? Describe the compliance program." },
  { key: "legal.litigation", section: "Legal and compliance", question: "Has the firm or any of its principals been subject to litigation, regulatory action or investigation?" },
  { key: "legal.conflicts", section: "Legal and compliance", question: "How are conflicts of interest identified, disclosed and resolved?" },
  { key: "esg.policy", section: "ESG", question: "Describe the firm's responsible investment policy and how it's applied in diligence and ownership." },
  { key: "dei.team", section: "Diversity, equity and inclusion", question: "Describe the diversity of the firm's team and its approach to inclusive hiring." },
  { key: "tech.cyber", section: "Technology and cybersecurity", question: "How does the firm protect investor and portfolio data?" },
];

const Q = new Map(DDQ_QUESTIONS.map((q) => [q.key, q]));
const pct = (x: number | null) => (x === null ? "not yet meaningful" : `${(x * 100).toFixed(1)}%`);
const mult = (x: number | null) => (x === null ? "not yet meaningful" : `${x.toFixed(2)}x`);

/** Drafts the firm's own records can support, with the source of each. */
async function fromRecords(db: Db): Promise<Map<string, { answer: string; sources: string[] }>> {
  const out = new Map<string, { answer: string; sources: string[] }>();
  const saved = await getProfile(db);
  if (saved) {
    const { firm, fund, mandate } = saved.profile;
    const src = `Firm profile, version ${saved.version}`;
    const where = [firm.hq, ...(firm.offices ?? [])].filter(Boolean).join("; ");
    out.set("firm.overview", { answer: `${firm.legalName ?? firm.name}${firm.foundedYear ? `, founded in ${firm.foundedYear}` : ""}${where ? `, with offices in ${where}` : ""}. ${firm.description ?? ""}`.trim(), sources: [src] });
    if (firm.aumUsd || firm.fundsRaised) out.set("firm.aum", { answer: `${firm.aumUsd ? `Assets under management: ${usd(firm.aumUsd)}.` : ""} ${firm.fundsRaised ? `Funds raised: ${firm.fundsRaised}.` : ""}`.trim(), sources: [src] });
    if (firm.teamSize || firm.investmentTeamSize) out.set("team.investment", { answer: `The firm has ${firm.teamSize ?? "—"} people, ${firm.investmentTeamSize ?? "—"} of them on the investment team.${fund.icMembers ? ` The investment committee has ${fund.icMembers} members.` : ""}`, sources: [src] });
    const stages = mandate.stages.map((s) => PROFILE_OPTIONS.stages.labels[s as keyof typeof PROFILE_OPTIONS.stages.labels] ?? s).join(", ");
    out.set("strategy.thesis", {
      answer: [
        mandate.thesis ? mandate.thesis.trim().replace(/\.?$/, ".") : null,
        `Stages: ${stages}. Sectors: ${mandate.sectors.map((s) => s.label).join(", ")}. Geographies: ${mandate.geographies.join(", ")}.`,
        `Initial checks from ${usd(mandate.checkSizeUsd.min)} to ${usd(mandate.checkSizeUsd.max)}.`,
      ].filter(Boolean).join(" "),
      sources: [src],
    });
    if (fund.targetInvestments || fund.reservesPct || fund.maxConcentrationPct) {
      out.set("construction.plan", {
        answer: [
          fund.targetInvestments ? `About ${fund.targetInvestments} companies.` : null,
          fund.avgInitialCheckUsd ? `Average initial check ${usd(fund.avgInitialCheckUsd)}.` : null,
          fund.reservesPct !== undefined ? `${fund.reservesPct}% of the fund held in reserve for follow-ons.` : null,
          fund.maxConcentrationPct ? `No more than ${fund.maxConcentrationPct}% of the fund in any one company.` : null,
        ].filter(Boolean).join(" "),
        sources: [src],
      });
    }
    if (fund.icApproval) {
      const rule = PROFILE_OPTIONS.icApproval.labels[fund.icApproval as keyof typeof PROFILE_OPTIONS.icApproval.labels];
      out.set("process.decision", {
        answer: `The investment committee decides by this rule: ${rule}. Members vote independently before discussion and again after it, and both votes are kept; every factual statement in the investment memo cites its source, and a pass records its reasons.`,
        sources: [src, "VC OS investment committee workflow"],
      });
    }
  }
  const fs = await funds(db);
  const f = fs[0];
  const pf = saved?.profile.fund;
  if (f || pf) {
    const t = (f?.terms ?? {}) as Record<string, number | string | undefined>;
    const fee = t.managementFeePct ?? pf?.managementFeePct;
    const step = t.feeStepDownPct ?? pf?.feeStepDownPct;
    const carry = t.carryPct ?? pf?.carryPct;
    const hurdle = t.hurdlePct ?? pf?.hurdlePct;
    const wf = (t.waterfall ?? pf?.waterfall) === "american" ? "deal by deal (American)" : "whole of fund (European)";
    out.set("terms.economics", {
      answer: [
        pf?.targetSizeUsd ? `Target size ${usd(pf.targetSizeUsd)}${pf.hardCapUsd ? `, hard cap ${usd(pf.hardCapUsd)}` : ""}.` : null,
        (t.gpCommitmentPct ?? pf?.gpCommitmentPct) !== undefined ? `GP commitment ${t.gpCommitmentPct ?? pf?.gpCommitmentPct}% of commitments.` : null,
        fee !== undefined ? `Management fee ${fee}% a year during the investment period${step !== undefined ? `, then ${step}%` : ""}.` : null,
        carry !== undefined ? `Carried interest ${carry}%${hurdle ? ` over an ${hurdle}% preferred return` : ", no preferred return"}, ${wf} waterfall.` : null,
        pf?.termYears ? `Term ${pf.termYears} years${pf.extensionYears ? ` plus up to ${pf.extensionYears} years of extensions` : ""}; investment period ${pf.investmentPeriodYears ?? "—"} years.` : null,
      ].filter(Boolean).join(" "),
      sources: [f ? `Fund terms: ${f.name}` : `Firm profile, version ${saved!.version}`],
    });
  }
  // Performance only from an approved report: never a draft, and net beside gross.
  for (const fund of fs) {
    const r = (await reports(db, fund.id, { status: "approved" }))[0];
    if (!r) continue;
    const s = r.snapshot as { performance?: { net: { irr: number | null; tvpi: number | null; dpi: number | null }; gross: { irr: number | null; moic: number | null }; marketingNote: string } };
    if (!s.performance) continue;
    const n = s.performance.net;
    const g = s.performance.gross;
    const prev = out.get("track.performance");
    const line = `${fund.name}, as of ${r.as_of}: net IRR ${pct(n.irr)}, net TVPI ${mult(n.tvpi)}, DPI ${mult(n.dpi)}; gross IRR ${pct(g.irr)}, gross multiple ${mult(g.moic)}. ${s.performance.marketingNote}`;
    out.set("track.performance", { answer: prev ? `${prev.answer}\n${line}` : line, sources: [...(prev?.sources ?? []), `${fund.name}: approved ${r.period.replace("-", " ")} report`] });
  }
  out.set("valuation.policy", {
    answer: "Each holding is marked at fair value every quarter, by methods the IPEV Valuation Guidelines and ASC 820 recognize: calibration to a recent financing (never simply the last round's price), milestone adjustments, revenue multiples with the company's preferences applied, and exit values. Each mark shows its steps and a written rationale, and a partner who didn't prepare it approves it; approved marks can't be edited.",
    sources: ["VC OS valuation workflow"],
  });
  out.set("reporting.lp", {
    answer: "Quarterly reports within 45 days of quarter end (the annual one within 90) in the ILPA Reporting Template's layout: a capital account statement for the quarter, year and inception to date; management fees, offsets and partnership expenses by category; carried interest paid and accrued. Net returns are shown beside gross, with the cash flows behind them as in the ILPA Performance Template. Each investor has a private portal with its statements, notices and tax documents.",
    sources: ["VC OS LP reporting workflow"],
  });
  out.set("ops.controls", {
    answer: "Capital calls and distributions are allocated to the cent by code, prepared by one person and approved by another before any notice is drafted; notices warn that the fund never changes bank details by email. Investment wires are confirmed by a call-back on a number already on file and approved by two people. Receipts are reconciled against the bank.",
    sources: ["VC OS capital call, distribution and wire controls"],
  });
  out.set("tech.cyber", {
    answer: "Firm data is separated in the database by row-level security. Credentials for connected services are encrypted and used only within the firm's own context. Sign-in is through Google or Microsoft single sign-on or a one-time email link; nothing leaves the system without a person's approval, and every approval is logged.",
    sources: ["VC OS security controls"],
  });
  return out;
}

export async function ddqView(db: Db) {
  const saved = new Map((await answers(db)).map((a) => [a.question_key, a]));
  const yearAgo = new Date(Date.now() - 365 * 86_400_000).toISOString();
  return DDQ_SECTIONS.map((section) => ({
    section,
    questions: DDQ_QUESTIONS.filter((q) => q.section === section).map((q) => {
      const a = saved.get(q.key);
      return { ...q, answer: a ?? null, stale: Boolean(a && a.status === "approved" && a.approved_at && a.approved_at < yearAgo) };
    }),
  }));
}

/** Draft answers from the firm's records for questions that have none, or only a draft. Approved answers are never overwritten. */
export async function draftFromRecords(db: Db, by: string) {
  const saved = new Map((await answers(db)).map((a) => [a.question_key, a]));
  let drafted = 0;
  for (const [key, a] of await fromRecords(db)) {
    if (saved.get(key)?.status === "approved") continue;
    if (!a.answer.trim()) continue;
    await upsertAnswer(db, key, a.answer, a.sources, by);
    drafted++;
  }
  return { drafted };
}

export async function saveAnswer(db: Db, key: string, input: { answer?: unknown; sources?: unknown }, by: string) {
  if (!Q.has(key)) throw new FundraisingInvalid("No such question.");
  const answer = text(input.answer);
  if (!answer) throw new FundraisingInvalid("Write the answer.");
  const sources = Array.isArray(input.sources) ? input.sources.map(String).filter(Boolean) : [];
  await upsertAnswer(db, key, answer, sources.length ? sources : [`Written by ${by.replace(/^human:/, "")}`], by);
}

export async function approveDdqAnswer(db: Db, key: string, by: string) {
  const a = (await answers(db)).find((x) => x.question_key === key);
  if (!a) throw new FundraisingInvalid("No answer to approve.");
  if (a.status === "approved") throw new FundraisingInvalid("Already approved.");
  if (a.updated_by === by) throw new FundraisingInvalid("Someone other than the person who wrote it approves an answer.");
  await approveAnswer(db, key, by);
}

/** The approved answers as a document for one prospect (logged on its record). Unapproved answers are marked to follow. */
export async function exportDdq(db: Db, opts: { prospectId?: string; format?: "markdown" | "csv" }, by: string) {
  const view = await ddqView(db);
  const firm = (await getProfile(db))?.profile.firm.name ?? "The firm";
  let filename = "ddq.md";
  let out: string;
  if (opts.format === "csv") {
    const esc = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
    out = ["Section,Question,Answer,Sources,Approved on", ...view.flatMap((s) => s.questions.map((q) => [s.section, q.question, q.answer?.status === "approved" ? q.answer.answer : "To follow", q.answer?.status === "approved" ? q.answer.sources.join("; ") : "", q.answer?.approved_at?.slice(0, 10) ?? ""].map(esc).join(",")))].join("\n") + "\n";
    filename = "ddq.csv";
  } else {
    out = [
      `# ${firm}: due diligence questionnaire`, "",
      `Prepared ${today()}. Sections follow the ILPA Due Diligence Questionnaire 2.0. Confidential; for the recipient's evaluation of the fund only.`, "",
      ...view.flatMap((s) => [`## ${s.section}`, "", ...s.questions.flatMap((q) => [`**${q.question}**`, "", q.answer?.status === "approved" ? q.answer.answer : "_To follow._", ...(q.answer?.status === "approved" && q.answer.sources.length ? ["", `_Source: ${q.answer.sources.join("; ")}_`] : []), ""])]),
    ].join("\n");
  }
  if (opts.prospectId) {
    const p = await getProspect(db, opts.prospectId);
    if (!p) throw new FundraisingInvalid("No such prospect.");
    const n = view.flatMap((s) => s.questions).filter((q) => q.answer?.status === "approved").length;
    await insertActivity(db, { prospectId: p.id, occurredOn: today(), kind: "ddq", summary: `DDQ exported with ${n} approved answers` }, by);
    filename = `${p.name.replace(/[^A-Za-z0-9]+/g, "-")}-${filename}`;
  }
  return { filename, text: out };
}
