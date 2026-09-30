import "dotenv/config";
import { calendar, detectConflicts, overview, profile } from "../modules/compliance/index.js";
import { COMPLIANCE_LABELS as L } from "../ledger/labels.js";
import { openDb, parseArgs, run } from "./common.js";

// pnpm compliance                  the obligations calendar: what's due, overdue and done
// pnpm compliance screenings       each deal's latest regulatory screening, and deals in closing without one
// pnpm compliance restricted       the restricted list, and companies that may belong on it
// pnpm compliance conflicts        the conflicts register (--detect first finds new ones in the records)
// pnpm compliance requests         pre-clearances, political contributions and gifts waiting for review
run(async () => {
  const { positional, str } = parseArgs();
  const [action] = positional;
  const by = `human:${str("by") ?? process.env.USER ?? "unknown"}`;
  const db = await openDb();
  try {
    if (!action) {
      const p = await profile(db);
      console.log(`${L.adviserStatus[p.adviser_status]}${p.configured ? "" : " (default: set the regulatory profile in the app)"}\n`);
      const rows = await calendar(db);
      if (!rows.length) return console.log("Nothing due.");
      for (const o of rows) console.log(`${o.due}  ${(o.state === "done" ? "done" : o.state === "overdue" ? "OVERDUE" : "due").padEnd(8)} ${o.title}${o.subject ? ` (${o.subject})` : ""}${o.filing?.reference ? `  · ${o.filing.reference}` : ""}`);
      return;
    }
    const o = await overview(db, { person: by, team: [], reviewer: true });
    if (action === "screenings") {
      for (const s of o.screenings) console.log(`${(s.company_name ?? "Company").padEnd(30)} outbound: ${L.outbound[s.outbound]}; CFIUS: ${L.cfius[s.cfius]}; ${L.exportControl[s.export_control]}`);
      for (const d of o.needsScreening) console.log(`${d.company_name.padEnd(30)} in closing, not screened yet`);
      if (!o.screenings.length && !o.needsScreening.length) console.log("No screenings yet.");
      return;
    }
    if (action === "restricted") {
      for (const r of o.restricted.filter((x) => !x.removed_on)) console.log(`${r.name}${r.ticker ? ` (${r.ticker})` : ""}: ${r.reason}, since ${r.added_on}`);
      for (const s of o.restrictedSuggestions) console.log(`[consider] ${s.name}: ${s.reason}`);
      return;
    }
    if (action === "conflicts") {
      if (process.argv.includes("--detect")) console.log(`Found ${(await detectConflicts(db, by)).added} new.\n`);
      const cs = process.argv.includes("--detect") ? (await overview(db, { person: by, team: [], reviewer: true })).conflicts : o.conflicts;
      for (const c of cs) console.log(`[${L.conflictStatus[c.status]}] ${c.title}${c.mitigation ? `: ${c.mitigation}` : ""}`);
      if (!cs.length) console.log("No conflicts recorded.");
      return;
    }
    if (action === "requests") {
      const pending = [
        ...o.preclearances.filter((r) => r.status === "pending").map((r) => `Pre-clearance: ${r.person.replace(/^human:/, "")} to buy ${r.security}${r.restricted_hit ? " (ON THE RESTRICTED LIST)" : ""}`),
        ...o.contributions.filter((r) => r.status === "pending").map((r) => `Contribution: ${r.person.replace(/^human:/, "")}, $${r.amount_usd} to ${r.recipient}`),
        ...o.gifts.filter((r) => r.status === "logged" && r.over_limit).map((r) => `Gift over limit: ${r.person.replace(/^human:/, "")}, $${r.value_usd} ${r.direction} ${r.counterparty}`),
      ];
      console.log(pending.length ? pending.join("\n") : "Nothing waiting for review.");
      return;
    }
    throw new Error(`Unknown action "${action}". Use: pnpm compliance [screenings|restricted|conflicts|requests]`);
  } finally {
    await db.close();
  }
});
