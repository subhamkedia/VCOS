import "dotenv/config";
import { claude, hasClaude } from "../lib/llm.js";
import { ingest, type IngestResult } from "../connectors/ingest.js";
import type { SourceRecord } from "../connectors/types.js";
import { harmonicEnrichByDomain } from "../connectors/harmonic.js";
import { searchFormD, fetchFormD } from "../connectors/edgar.js";
import { fetchWebPage } from "../connectors/web.js";
import { transcriptFromFile, granolaTranscript, listGranolaTools } from "../connectors/transcripts.js";
import { openDb, parseArgs, printCompany, run } from "./common.js";

const USAGE = `
pnpm ingest harmonic <domain>                         Enrich a company from Harmonic
pnpm ingest formd "<company or keyword>" [--from YYYY-MM-DD] [--limit 5]
                                                      Pull SEC Form D filings
pnpm ingest web <url> --company "<name>" [--domain d]  Snapshot a page and extract claims
pnpm ingest transcript <file> --company "<name>" [--domain d] [--date YYYY-MM-DD]
                                                      Import an exported transcript (.txt .md .vtt)
pnpm ingest granola <meeting-id> --company "<name>" [--domain d] [--date YYYY-MM-DD]
pnpm ingest granola-tools                             List the tools Granola's MCP server exposes

Add --dry-run to see what would be written without touching the database.
`;

function summarize(r: IngestResult) {
  const s = r.subject;
  if (r.duplicate) return console.log(`  already ingested (evidence ${r.evidence.id})`);
  if (s) {
    const how = s.created ? (s.resolution.decision === "review" ? "created provisionally, merge proposal filed" : "new company") : `matched existing (${s.resolution.method})`;
    console.log(`  ${s.entity.name}: ${how}`);
    if (s.proposalId) console.log(`  review with: pnpm resolve`);
  }
  console.log(`  ${r.structuredClaims} structured claims${r.extraction ? `, ${r.extraction.claimIds.length} extracted` : ""}`);
  for (const x of r.structuredRejected) console.log(`  rejected ${x.predicate}: ${x.reason}`);
  for (const x of r.extraction?.rejected ?? []) console.log(`  rejected ${x.line}: ${x.reason}`);
  for (const c of r.contradictions) console.log(`  CONTRADICTION [${c.severity}] ${c.detail}`);
}

run(async () => {
  const { positional, str, flags } = parseArgs();
  const [kind, target] = positional;
  if (!kind || flags.help) return console.log(USAGE);

  if (kind === "granola-tools") {
    for (const t of await listGranolaTools()) console.log(`${t.name}: ${t.description ?? ""}`);
    return;
  }

  const company = str("company");
  const needsCompany = ["web", "transcript", "granola"].includes(kind);
  if (needsCompany && !company) throw new Error(`--company is required for ${kind}.${USAGE}`);
  if (!target) throw new Error(USAGE);

  const records: SourceRecord[] = [];
  if (kind === "harmonic") records.push(await harmonicEnrichByDomain(target));
  else if (kind === "web") records.push(await fetchWebPage(target, { company, companyDomain: str("domain") }));
  else if (kind === "transcript") records.push(await transcriptFromFile(target, { company: company!, companyDomain: str("domain"), date: str("date") }));
  else if (kind === "granola") records.push(await granolaTranscript(target, { company: company!, companyDomain: str("domain"), date: str("date") }));
  else if (kind === "formd") {
    const hits = (await searchFormD(target, { from: str("from"), to: str("to") })).slice(0, Number(str("limit") ?? 5));
    if (!hits.length) return console.log("No Form D filings found.");
    for (const h of hits) records.push(await fetchFormD(h));
  } else throw new Error(`Unknown source "${kind}".${USAGE}`);

  if (flags["dry-run"]) {
    for (const r of records) {
      console.log(`\n${r.evidence.title}  [${r.evidence.kind}, ${r.evidence.accessScope}]`);
      if (r.subject) console.log(`  subject: ${JSON.stringify(r.subject)}`);
      for (const c of r.claims ?? []) console.log(`  ${c.predicate} = ${JSON.stringify(c.value)}${c.asOf ? ` (as of ${c.asOf})` : ""}`);
      if (r.extract) console.log(`  + extractor would run over ${r.evidence.content.length.toLocaleString()} characters`);
    }
    return;
  }

  const needsLlm = records.some((r) => r.extract);
  if (needsLlm && !hasClaude()) console.log("ANTHROPIC_API_KEY not set: storing evidence without extracting claims.");
  const llm = hasClaude() ? claude() : undefined;

  const db = await openDb();
  try {
    for (const rec of records) {
      console.log(`\n${rec.evidence.title}`);
      const r = await ingest(db, rec, { llm });
      summarize(r);
      if (r.subject && !r.duplicate && flags.show) await printCompany(db, r.subject.entity.id);
    }
  } finally {
    await db.close();
  }
});
