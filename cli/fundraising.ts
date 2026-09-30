import "dotenv/config";
import { writeFileSync } from "node:fs";
import { exportDdq, overview, raiseView, requestQueue } from "../modules/fundraising/index.js";
import { openDb, parseArgs, run } from "./common.js";

// pnpm fundraising                         every raise: target, closed, weighted pipeline, coverage
// pnpm fundraising pipeline "<raise>"      prospects by stage, with next steps and data room activity
// pnpm fundraising investors "<raise>"     subscriptions and what each still needs before a closing
// pnpm fundraising ddq [--csv] [--out f]   the approved DDQ answers as a document
// pnpm fundraising requests                investor requests, oldest due first
run(async () => {
  const { positional, str } = parseArgs();
  const [action, name] = positional;
  const by = `human:${str("by") ?? process.env.USER ?? "unknown"}`;
  const db = await openDb();
  const m = (n: number | null) => (n === null ? "—" : `$${(n / 1e6).toFixed(1)}M`);
  try {
    const o = await overview(db);
    const pick = () => {
      const r = o.raises.find((x) => x.name.toLowerCase() === (name ?? "").toLowerCase()) ?? (o.raises.length === 1 && !name ? o.raises[0] : undefined);
      if (!r) throw new Error(`No raise named "${name ?? ""}". Raises: ${o.raises.map((x) => x.name).join(", ") || "none yet"}.`);
      return r;
    };
    if (!action) {
      if (!o.raises.length) return console.log("No raises yet. Start one in the app (Fundraising & IR) from your firm profile.");
      for (const r of o.raises) console.log(`${r.name} (${r.status}): target ${m(r.targetUsd)}, closed ${m(r.closedUsd)}, weighted pipeline ${m(r.weightedUsd)}, coverage ${r.coverage === null ? "—" : `${(r.coverage * 100).toFixed(0)}%`}; ${r.prospects} live prospects, ${r.followUpsDue} follow-ups due`);
      return;
    }
    if (action === "pipeline") {
      const v = await raiseView(db, pick().id);
      for (const st of v.pipeline.byStage.filter((s) => s.count)) {
        console.log(`\n${v.labels.stages[st.stage]} (${st.count}, ${m(st.amount)}):`);
        for (const p of v.prospects.filter((x) => x.stage === st.stage)) {
          console.log(`  ${p.name.padEnd(36)} ${m(p.committed_usd ?? p.soft_circle_usd ?? p.ask_usd).padStart(7)}  ${p.next_step ?? ""}${p.next_step_on ? ` by ${p.next_step_on}` : ""}${p.overdue ? " (overdue)" : ""}${p.engagement ? `  · data room: ${p.engagement.documents} docs` : ""}`);
        }
      }
      return;
    }
    if (action === "investors") {
      const v = await raiseView(db, pick().id);
      for (const s of v.subscriptions) console.log(`${s.investor_name.padEnd(36)} ${m(s.commitment_usd).padStart(7)}  ${v.labels.subscriptionStatus[s.status]}${s.open.length ? `: ${s.open.join("; ")}` : ""}`);
      for (const i of v.issues) console.log(`[${i.severity === "block" ? "blocks closing" : "check"}] ${i.message}`);
      return;
    }
    if (action === "ddq") {
      const out = await exportDdq(db, { format: process.argv.includes("--csv") ? "csv" : "markdown" }, by);
      writeFileSync(str("out") ?? out.filename, out.text);
      console.log(`Wrote ${str("out") ?? out.filename} (approved answers only).`);
      return;
    }
    if (action === "requests") {
      for (const r of await requestQueue(db)) console.log(`${r.due_on ?? "—"}  ${r.status.padEnd(8)} ${r.overdue ? "OVERDUE " : ""}${r.from_name}: ${r.subject}`);
      return;
    }
    throw new Error(`Unknown action "${action}". Use: pnpm fundraising [pipeline|investors|ddq|requests]`);
  } finally {
    await db.close();
  }
});
