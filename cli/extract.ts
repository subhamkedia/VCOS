import "dotenv/config";
import { claude } from "../lib/llm.js";
import { extractClaims } from "../agents/extractor/index.js";
import { findCompany, openDb, parseArgs, printCompany, run } from "./common.js";

// pnpm extract <evidence-id> <company: domain, name or id>
// Re-run extraction over evidence already in the ledger (for example after improving the prompt).
run(async () => {
  const { positional } = parseArgs();
  const [evidenceId, companyQuery] = positional;
  if (!evidenceId || !companyQuery) throw new Error("Usage: pnpm extract <evidence-id> <company domain, name or id>");
  const db = await openDb();
  try {
    const company = await findCompany(db, companyQuery);
    if (!company) throw new Error(`No company matching "${companyQuery}"`);
    const out = await extractClaims(db, claude(), evidenceId, company.id);
    console.log(`${out.claimIds.length} claims written, ${out.rejected.length} rejected`);
    for (const r of out.rejected) console.log(`  rejected ${r.line}: ${r.reason}`);
    await printCompany(db, company.id);
  } finally {
    await db.close();
  }
});
