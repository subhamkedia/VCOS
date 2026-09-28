import "dotenv/config";
import { approve, pending, reject } from "../modules/outbox/index.js";
import { getOutboxItem, type OutboxStatus } from "../ledger/repository.js";
import { openDb, parseArgs, run } from "./common.js";

// pnpm outbox                          items waiting for approval
// pnpm outbox --status done|failed|rejected|approved
// pnpm outbox show <id>                full payload
// pnpm outbox approve <id> [--by name] carry it out (a draft or CRM note, never a send)
// pnpm outbox reject <id> [--by name]
run(async () => {
  const { positional, str } = parseArgs();
  const [action, id] = positional;
  const by = `human:${str("by") ?? process.env.USER ?? "unknown"}`;
  const db = await openDb();
  try {
    if (!action) {
      const status = (str("status") ?? "pending") as OutboxStatus;
      const items = await pending(db, status);
      if (!items.length) return console.log(`No ${status} outbox items.`);
      for (const i of items) console.log(`${i.id}  [${i.channel}]  ${i.summary}  (from ${i.proposed_by})${i.error ? `  error: ${i.error}` : ""}`);
      if (status === "pending") console.log("\nReview with: pnpm outbox show <id>, then approve or reject.");
      return;
    }
    if (!id) throw new Error("Usage: pnpm outbox [show|approve|reject] <id>");
    if (action === "show") {
      const i = await getOutboxItem(db, id);
      if (!i) throw new Error(`No outbox item ${id}`);
      console.log(JSON.stringify(i, null, 2));
    } else if (action === "approve") {
      const r = await approve(db, id, by);
      console.log(r.outcome.ok ? `Approved by ${by}: ${r.outcome.detail}` : `Approved by ${by}, but it failed: ${r.outcome.detail}`);
    } else if (action === "reject") {
      await reject(db, id, by);
      console.log(`Rejected ${id}.`);
    } else throw new Error(`Unknown action "${action}"`);
  } finally {
    await db.close();
  }
});
