import "dotenv/config";
import { config } from "../lib/config.js";
import { CONNECTORS, ENV_NAMES, missingKeys } from "../connectors/registry.js";
import { parseArgs, run } from "./common.js";

// pnpm connectors           which sources are configured, and what each needs
// pnpm connectors --check   also make one cheap live call to each configured source
run(async () => {
  const { flags } = parseArgs();
  console.log(`Claude extraction: ${config.anthropicApiKey ? "configured" : "missing ANTHROPIC_API_KEY (evidence is stored, claims aren't extracted)"}\n`);
  let category = "";
  for (const c of CONNECTORS) {
    if (c.category !== category) {
      category = c.category;
      console.log(category.toUpperCase());
    }
    const missing = missingKeys(c);
    let status = missing.length ? `missing ${missing.map((k) => ENV_NAMES[k]).join(", ")}` : "ready";
    if (!missing.length && flags.check && c.check) {
      try {
        status = `ok: ${await c.check()}`;
      } catch (err) {
        status = `FAILED: ${(err as Error).message.slice(0, 160)}`;
      }
    }
    console.log(`  ${c.name.padEnd(26)} ${status}`);
    console.log(`  ${"".padEnd(26)} scope ${c.scope}${c.writes ? ` · writes ${c.writes} after approval` : ""} · ${c.ingest}`);
    if (c.notes) console.log(`  ${"".padEnd(26)} ${c.notes}`);
  }
  if (!flags.check) console.log("\nAdd --check to test each configured connector with one live call.");
});
