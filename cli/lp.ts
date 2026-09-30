import "dotenv/config";
import { readFileSync, writeFileSync } from "node:fs";
import { calendar, exportCsv, fundView, importBankCsv, overview, prepareReport, report, syncBank, type ExportKind } from "../modules/lp/index.js";
import { openDb, parseArgs, run } from "./common.js";

// pnpm lp                                   every fund: commitments, called, NAV, net TVPI and IRR
// pnpm lp accounts <fund>                   each investor's capital account and net returns
// pnpm lp calendar <fund> [year]            reports, K-1s, audit and Form ADV deadlines
// pnpm lp bank <fund> [--since YYYY-MM-DD]  pull the fund's Mercury transactions and match receipts
// pnpm lp bank <fund> --file statement.csv  or match from any bank's CSV export
// pnpm lp report <fund> <YYYY-Qn>           prepare the quarter's report (a draft for a second person to approve)
// pnpm lp export <report id> <kind> [--out file.csv]   capital-accounts | fees-expenses | performance | investments
run(async () => {
  const { positional, str } = parseArgs();
  const [action, a, b] = positional;
  const by = `human:${str("by") ?? process.env.USER ?? "unknown"}`;
  const db = await openDb();
  const usd = (n: number) => `$${(n / 1e6).toFixed(2)}M`;
  const x = (n: number | null) => (n === null ? "—" : `${n.toFixed(2)}x`);
  const pct = (n: number | null) => (n === null ? "—" : `${(n * 100).toFixed(1)}%`);
  try {
    const o = await overview(db);
    const fund = () => {
      const f = o.funds.find((y) => y.name.toLowerCase() === (a ?? "").toLowerCase()) ?? (o.funds.length === 1 && !a ? o.funds[0] : undefined);
      if (!f) throw new Error(`No fund named "${a ?? ""}". Funds: ${o.funds.map((y) => y.name).join(", ") || "none yet"}.`);
      return f;
    };
    if (!action) {
      if (!o.funds.length) return console.log("No funds yet. Set one up in the app (LP Reporting) from your firm profile.");
      for (const f of o.funds) {
        console.log(`${f.name} (${f.vintage ?? "—"}): ${f.investors} investors, ${usd(f.commitments)} committed, ${f.calledPct.toFixed(1)}% called, NAV ${usd(f.nav)}`);
        console.log(`    Net TVPI ${x(f.net.tvpi)}, DPI ${x(f.net.dpi)}, IRR ${pct(f.net.irr)}. Last report: ${f.lastReport ?? "none"}. Waiting for approval: ${f.pending.calls} calls, ${f.pending.distributions} distributions, ${f.pending.reports} reports.`);
      }
      return;
    }
    if (action === "accounts") {
      const v = await fundView(db, fund().id);
      console.log(`${v.fund.name} as of ${v.asOf}: NAV ${usd(v.summary.nav)}; GP carry accrued ${usd(v.gpCarry.accrued)}, paid ${usd(v.gpCarry.paid)}\n`);
      for (const i of v.investors) {
        console.log(`${i.name.padEnd(36)} committed ${usd(i.commitment_usd).padStart(8)}  paid in ${usd(i.contributed).padStart(8)}  out ${usd(i.distributed).padStart(8)}  balance ${usd(i.balance).padStart(8)}  TVPI ${x(i.returns?.tvpi ?? null)}`);
      }
      return;
    }
    if (action === "calendar") {
      const year = Number(b ?? new Date().getUTCFullYear());
      for (const d of await calendar(db, fund().id, year)) console.log(`${d.due}  ${d.state.padEnd(8)}  ${d.title}${d.progress ? ` (${d.progress})` : ""}\n            ${d.basis}`);
      return;
    }
    if (action === "bank") {
      const file = str("file");
      const r = file ? await importBankCsv(db, fund().id, { name: file, text: readFileSync(file, "utf8") }, by) : await syncBank(db, fund().id, { since: str("since") }, by);
      console.log(`${"added" in r ? `${r.added} new transactions. ` : ""}Matched ${r.matched} receipts; ${r.unmatched} incoming transactions need a person to match them.`);
      return;
    }
    if (action === "report") {
      const r = await prepareReport(db, fund().id, { period: b, commentary: str("commentary") }, by);
      console.log(`Prepared ${r.period} version ${r.version} (${r.id}). A different person approves it in the app before investors see it.`);
      return;
    }
    if (action === "export") {
      const r = await report(db, a ?? "");
      const out = exportCsv(r, (b ?? "capital-accounts") as ExportKind);
      writeFileSync(str("out") ?? out.filename, out.text);
      console.log(`Wrote ${str("out") ?? out.filename}.`);
      return;
    }
    throw new Error(`Unknown action "${action}". Use: pnpm lp [accounts|calendar|bank|report|export] ...`);
  } finally {
    await db.close();
  }
});
