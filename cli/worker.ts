import "dotenv/config";
import { connect, migrate } from "../lib/db.js";
import { claude, hasClaude } from "../lib/llm.js";
import { runDueFeeds } from "../modules/sourcing/index.js";
import { parseArgs, run } from "./common.js";

// pnpm worker           run due sourcing feeds for every firm, checking each minute
// pnpm worker --once    one pass, then exit (for cron or a scheduled job)
run(async () => {
  const { flags, str } = parseArgs();
  const every = Number(str("every") ?? 60) * 1000;
  const root = await connect();
  await migrate(root);
  const llm = hasClaude() ? claude() : undefined;
  if (!llm) console.log("ANTHROPIC_API_KEY not set: feeds store evidence but don't extract claims from text.");
  let stopping = false;
  process.on("SIGINT", () => (stopping = true));
  process.on("SIGTERM", () => (stopping = true));
  try {
    do {
      const results = await runDueFeeds(root, () => ({ llm }));
      for (const r of results) console.log(`${new Date().toISOString()} feed ${r.feedId} (firm ${r.firmId}): ${r.ok ? "done" : `failed: ${r.error}`}`);
      if (flags.once) break;
      for (let waited = 0; waited < every && !stopping; waited += 1000) await new Promise((r) => setTimeout(r, 1000));
    } while (!stopping);
  } finally {
    await root.close();
  }
});
