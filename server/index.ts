import "dotenv/config";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { connect, migrate } from "../lib/db.js";
import { claude, hasClaude } from "../lib/llm.js";
import { defaultMailer } from "../lib/mailer.js";
import { createApp } from "./app.js";

/**
 * `pnpm web` runs the API and serves the built app from web/dist.
 * In development, `pnpm dev` runs this plus Vite with hot reload.
 */
const port = Number(process.env.PORT ?? 8787);
const appUrl = process.env.APP_URL ?? `http://localhost:${process.env.WEB_PORT ?? port}`;

const root = await connect();
await migrate(root);
const app = createApp({ root, mailer: defaultMailer(), appUrl, llm: hasClaude() ? claude() : undefined });

const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../web/dist");
app.use("/assets/*", serveStatic({ root: path.relative(process.cwd(), dist) }));
app.get("*", async (c) => {
  try {
    return c.html(await readFile(path.join(dist, "index.html"), "utf8"));
  } catch {
    return c.text("The web app isn't built. Run `pnpm build:web`, or `pnpm dev` for development.", 503);
  }
});

serve({ fetch: app.fetch, port }, () => {
  console.log(`VC OS API on http://localhost:${port}  (app URL ${appUrl})`);
  if (!hasClaude()) console.log("ANTHROPIC_API_KEY not set: uploads are stored, but no claims are extracted.");
  if (!process.env.GOOGLE_CLIENT_ID && !process.env.MS_CLIENT_ID) console.log("No Google or Microsoft app configured: sign in with an email link (printed here).");
});
