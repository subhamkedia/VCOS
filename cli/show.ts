import "dotenv/config";
import { SHAREABLE_SCOPES } from "../ledger/repository.js";
import { findCompany, openDb, parseArgs, printCompany, run } from "./common.js";

// pnpm show <domain | name | id> [--shareable]
run(async () => {
  const { positional, flags } = parseArgs();
  const q = positional.join(" ");
  if (!q) throw new Error("Usage: pnpm show <domain, name or id> [--shareable]");
  const db = await openDb();
  try {
    const e = await findCompany(db, q);
    if (!e) throw new Error(`No company matching "${q}"`);
    await printCompany(db, e.id, flags.shareable ? { scopes: SHAREABLE_SCOPES } : {});
  } finally {
    await db.close();
  }
});
