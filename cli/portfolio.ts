import "dotenv/config";
import { overview, syncCompany } from "../modules/portfolio/index.js";
import { openDb, parseArgs, run } from "./common.js";

// pnpm portfolio                   every holding: value, MOIC, runway, warnings
// pnpm portfolio sync <company>    refresh a company's numbers from its books and your tools
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
        const rating = c.status === "exited" ? "Exited" : o.healthLabels[c.health?.rating ?? c.suggested];
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
    throw new Error(`Unknown action "${action}". Use: pnpm portfolio [sync <company>]`);
  } finally {
    await db.close();
  }
});
