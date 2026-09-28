import "dotenv/config";
import { pendingProposals, decideProposal } from "../agents/resolver/index.js";
import { openDb, parseArgs, run } from "./common.js";

// pnpm resolve                      list pending merge proposals
// pnpm resolve accept <id> [--by name]
// pnpm resolve reject <id> [--by name]
run(async () => {
  const { positional, str } = parseArgs();
  const [action, id] = positional;
  const db = await openDb();
  try {
    if (!action) {
      const list = await pendingProposals(db);
      if (!list.length) return console.log("No pending merge proposals.");
      for (const p of list) {
        console.log(`\n${p.id}  score ${p.score.toFixed(2)}  (${p.method})`);
        console.log(`  incoming: ${p.candidate.name}${p.candidate.domain ? ` · ${p.candidate.domain}` : ""}${p.candidate.founders?.length ? ` · founders ${p.candidate.founders.join(", ")}` : ""}  [from ${p.candidate.source}]`);
        console.log(`  same as:  ${p.target_name ?? "(no target)"}?`);
        console.log(`  why:      ${p.explanation}`);
      }
      console.log("\nDecide with: pnpm resolve accept <id>   or   pnpm resolve reject <id>");
      return;
    }
    if ((action !== "accept" && action !== "reject") || !id) throw new Error("Usage: pnpm resolve [accept|reject <id>]");
    await decideProposal(db, id, action === "accept", `human:${str("by") ?? process.env.USER ?? "unknown"}`);
    console.log(`${action === "accept" ? "Merged" : "Rejected"} ${id}.`);
  } finally {
    await db.close();
  }
});
