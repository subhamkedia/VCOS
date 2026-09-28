import "dotenv/config";
import { findCompany, openDb, parseArgs, printCompany, run } from "./common.js";

// pnpm show <domain | name | id>
run(async () => {
  const q = parseArgs().positional.join(" ");
  if (!q) throw new Error("Usage: pnpm show <domain, name or id>");
  const db = await openDb();
  try {
    const e = await findCompany(db, q);
    if (!e) throw new Error(`No company matching "${q}"`);
    await printCompany(db, e.id);
  } finally {
    await db.close();
  }
});
