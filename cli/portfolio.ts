import "dotenv/config";
import { companyExits, fundLifeView, liquidityOverview, overview, syncCompany } from "../modules/portfolio/index.js";
import { overview as lpOverview } from "../modules/lp/index.js";
import { openDb, parseArgs, run } from "./common.js";

// pnpm portfolio                   every holding: value, MOIC, runway, warnings
// pnpm portfolio sync <company>    refresh a company's numbers from its books and your tools
// pnpm portfolio liquidity         exits under way, escrows and earnouts due, listed shares, the forecast, QSBS dates
// pnpm portfolio exits <company>   one company's exit plan, processes, receivables, listed shares and QSBS
// pnpm portfolio fund-life <fund>  a fund's term, extensions, what it still holds, and options for the tail
run(async () => {
  const { positional, str } = parseArgs();
  const [action, name] = positional;
  const by = `human:${str("by") ?? process.env.USER ?? "unknown"}`;
  const db = await openDb();
  const usd = (n: number | null) => (n === null ? "—" : `$${(n / 1e6).toFixed(2)}M`);
  try {
    const o = await overview(db);
    if (!action) {
      if (!o.companies.length) return console.log("No investments yet. They come from closing a deal in Investment Execution.");
      const m = o.metrics;
      console.log(`${o.fund.name}: invested ${usd(m.invested)}, value ${usd(m.totalValue)}, gross MOIC ${m.moic?.toFixed(2) ?? "—"}x, DPI ${m.dpi?.toFixed(2) ?? "—"}, gross IRR ${m.irr === null ? "—" : `${(m.irr * 100).toFixed(1)}%`}`);
      console.log(`Reserves: ${usd(o.reserves.budget)} budget, ${usd(o.reserves.deployed)} deployed, ${usd(o.reserves.unallocated)} unallocated\n`);
      for (const c of o.companies) {
        const rating = c.status === "exited" ? "Exited" : c.status === "public" ? "Listed" : o.healthLabels[c.health?.rating ?? c.suggested];
        const runway = c.status === "exited" ? `${usd(c.realized)} returned` : c.notBurning ? "not burning" : c.runwayMonths === null ? "runway unknown" : `${c.runwayMonths.toFixed(1)} months runway`;
        console.log(`${c.name.padEnd(28)} ${usd(c.fairValue + c.realized).padStart(9)}  ${c.moic?.toFixed(2) ?? "—"}x  ${rating.padEnd(9)} ${runway}`);
        for (const s of c.signals) console.log(`    [${s.severity}] ${s.title}`);
      }
      return;
    }
    if (action === "sync") {
      const hit = o.companies.find((c) => c.name.toLowerCase() === (name ?? "").toLowerCase());
      if (!hit) throw new Error(`No portfolio company named "${name ?? ""}".`);
      for (const r of await syncCompany(db, hit.companyId, by)) console.log(`${r.name}: ${r.status}${r.claims ? `, ${r.claims} figures` : ""}${r.detail ? ` (${r.detail})` : ""}`);
      return;
    }
    if (action === "liquidity") {
      const l = await liquidityOverview(db);
      const L = l.labels;
      console.log(`Pending receivables ${usd(l.totals.pendingUsd)} (expected), listed shares ${usd(l.totals.listedUsd)}, received but not distributed ${usd(l.totals.undistributedUsd)}\n`);
      for (const x of l.processes) console.log(`${(x.company_name ?? "").padEnd(24)} ${L.kinds[x.kind]}: ${L.stages[x.stage]}${x.counterparty ? `, ${x.counterparty}` : ""}${x.expected_close ? `, closing ${x.expected_close}` : ""}`);
      for (const r of l.receivables) console.log(`${r.due_on}  ${(r.company_name ?? "").padEnd(22)} ${L.receivableKinds[r.kind]}: ${usd(r.amount_usd - r.settled_usd)}, expected ${usd(r.valueUsd)}${r.overdue ? " (overdue)" : ""}`);
      for (const p of l.listed) console.log(`${p.holding.ticker.padEnd(6)} ${p.sharesLeft.toLocaleString("en-US")} shares, ${usd(p.valueUsd)}; can sell from ${p.window.earliestSale}${p.window.volumeLimit ? `, up to ${p.window.volumeLimit.toLocaleString("en-US")} shares a quarter` : ""}`);
      for (const q of l.qsbsSoon) console.log(`QSBS: ${q.company} (${q.label}) steps up to ${q.next.pct}% on ${q.next.on}`);
      console.log("\nExpected cash back by year:");
      for (const y of l.forecast) console.log(`  ${y.year}: ${usd(y.total)} (receivables ${usd(y.receivables)}, listed shares ${usd(y.publicShares)}, planned exits ${usd(y.exits)})`);
      return;
    }
    if (action === "exits") {
      const hit = o.companies.find((c) => c.name.toLowerCase() === (name ?? "").toLowerCase());
      if (!hit) throw new Error(`No portfolio company named "${name ?? ""}".`);
      const v = await companyExits(db, hit.companyId);
      const L = v.labels;
      if (v.plan) console.log(`Plan: ${L.paths[v.plan.path]}${v.plan.target_year ? ` around ${v.plan.target_year}` : ""}${v.plan.base_usd ? `, base case ${usd(v.plan.base_usd)} to us` : ""}; ready: ${Object.values(v.plan.readiness).filter(Boolean).length} of ${v.readiness.length}`);
      for (const x of v.processes) {
        console.log(`${L.kinds[x.kind]} (${L.stages[x.stage]})${x.counterparty ? ` with ${x.counterparty}` : ""}${x.needsConsent ? (x.consent_decision_id ? "; the fund consented" : "; the fund's consent not recorded") : ""}`);
        for (const b of x.bids) console.log(`    ${b.received_on} ${L.bidKinds[b.kind]} from ${b.bidder}: ${usd(b.value_usd)}`);
      }
      for (const r of v.receivables) console.log(`${r.due_on}  ${L.receivableKinds[r.kind]}: ${usd(r.amount_usd)}, ${L.receivableStatus[r.status]}${r.settled_usd ? `, ${usd(r.settled_usd)} received` : ""}`);
      for (const q of v.qsbs) console.log(`QSBS ${q.label}: ${q.review ? L.qsbsStatus[q.review.status] : "not reviewed"}; ${q.result.exclusionPct}% excluded if sold today${q.result.next ? `, ${q.result.next.pct}% from ${q.result.next.on}` : ""}`);
      console.log(`Received so far: ${usd(v.receivedUsd)}`);
      return;
    }
    if (action === "fund-life") {
      const f = (await lpOverview(db)).funds.find((x) => x.name.toLowerCase() === (name ?? "").toLowerCase()) ?? (!name ? (await lpOverview(db)).funds[0] : undefined);
      if (!f) throw new Error(`No fund named "${name ?? ""}" in LP Reporting.`);
      const v = await fundLifeView(db, f.id);
      console.log(`${v.fund.name}: ${v.termYears}-year term to ${v.life.termEnds}${v.life.extensionYearsUsed ? `, extended to ${v.life.endsOn}` : ""} (${v.labels.lifeStage[v.life.stage]}); ${v.life.extensionYearsLeft} extension years left`);
      console.log(`Still held: ${usd(v.residualNavUsd)} across ${v.residual.length} companies`);
      for (const o2 of v.options) console.log(`  - ${o2.title}: ${o2.detail}`);
      return;
    }
    throw new Error(`Unknown action "${action}". Use: pnpm portfolio [sync <company> | liquidity | exits <company> | fund-life <fund>]`);
  } finally {
    await db.close();
  }
});
