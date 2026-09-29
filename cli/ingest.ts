import "dotenv/config";
import { claude, hasClaude } from "../lib/llm.js";
import { ingest, type IngestResult } from "../connectors/ingest.js";
import type { SourceRecord } from "../connectors/types.js";
import { harmonicEnrichByDomain } from "../connectors/harmonic.js";
import { searchFormD, fetchFormD } from "../connectors/edgar.js";
import { fetchWebPage } from "../connectors/web.js";
import { transcriptFromFile } from "../connectors/transcripts.js";
import { granolaNote } from "../connectors/granola.js";
import { meetingSourceRecord } from "../connectors/meetings.js";
import { fetchYcBatch, fetchYcFounders, ycToRecord } from "../connectors/yc.js";
import { pitchbookByDomain } from "../connectors/pitchbook.js";
import { crunchbaseByDomain } from "../connectors/crunchbase.js";
import { dealroomByDomain } from "../connectors/dealroom.js";
import { affinityListOrgs, affinityNoteRecord, affinityNotes, affinityOrgRecord, affinitySearchOrgs, type AffinityOrg } from "../connectors/affinity.js";
import { gmailSearch } from "../connectors/gmail.js";
import { outlookSearch } from "../connectors/outlook.js";
import { emailToRecord } from "../connectors/email.js";
import { driveRecord, driveSearch } from "../connectors/gdrive.js";
import { documentFromFile } from "../connectors/documents.js";
import { openDb, parseArgs, printCompany, run } from "./common.js";

const USAGE = `
Data vendors (vendor scope, never exported)
  pnpm ingest harmonic <domain>
  pnpm ingest pitchbook <domain>
  pnpm ingest crunchbase <domain>
  pnpm ingest dealroom <domain>

Public sources
  pnpm ingest formd "<company or keyword>" [--from YYYY-MM-DD] [--limit 5]
  pnpm ingest yc <batch: W26, X26, S26...> [--limit n] [--founders]
  pnpm ingest web <url> --company "<name>" [--domain d]

CRM
  pnpm ingest affinity "<organization name>"          The best match and its notes
  pnpm ingest affinity-list <list id> [--notes]       Every organization on a list (your pipeline)

Email (confidential; subject company = --company, or the sender's company domain)
  pnpm ingest gmail "<gmail query>" [--max 20] [--company "<name>"] [--domain d]
  pnpm ingest outlook "<search>" [--max 20] [--company "<name>"] [--domain d]

Documents (confidential)
  pnpm ingest drive <file id> --company "<name>" [--domain d]
  pnpm ingest drive-search "<text>"                   List matching files (writes nothing)
  pnpm ingest document <file.pdf|.txt|.md> --company "<name>" [--domain d] [--url <docsend link>]

Meetings (confidential)
  pnpm ingest transcript <file> --company "<name>" [--domain d] [--date YYYY-MM-DD]
  pnpm ingest granola <note id, not_...> --company "<name>" [--domain d]
  In the web app, connected meeting tools sync on their own and each
  meeting is matched to a company (Meetings screen).

Add --dry-run to see what would be written without touching the database.
Run \`pnpm connectors\` to see which sources have keys.
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

  if (kind === "drive-search") {
    if (!target) throw new Error(USAGE);
    for (const f of await driveSearch(target)) console.log(`${f.id}  ${f.name}  [${f.mimeType}]  ${f.modifiedTime?.slice(0, 10) ?? ""}`);
    return;
  }

  const company = str("company");
  const domain = str("domain");
  const needsCompany = ["web", "transcript", "granola", "drive", "document"].includes(kind);
  if (needsCompany && !company) throw new Error(`--company is required for ${kind}.${USAGE}`);
  if (!target) throw new Error(USAGE);
  const max = Number(str("max") ?? str("limit") ?? 20);

  const records: SourceRecord[] = [];
  const affinityWithNotes = async (o: AffinityOrg, notes: boolean) => {
    records.push(affinityOrgRecord(o));
    if (notes) for (const n of await affinityNotes(o.id)) records.push(affinityNoteRecord(n, o));
  };

  if (kind === "harmonic") records.push(await harmonicEnrichByDomain(target));
  else if (kind === "pitchbook") records.push(await pitchbookByDomain(target));
  else if (kind === "crunchbase") records.push(await crunchbaseByDomain(target));
  else if (kind === "dealroom") records.push(await dealroomByDomain(target));
  else if (kind === "web") records.push(await fetchWebPage(target, { company, companyDomain: domain }));
  else if (kind === "transcript") records.push(await transcriptFromFile(target, { company: company!, companyDomain: domain, date: str("date") }));
  else if (kind === "granola") records.push(meetingSourceRecord(await granolaNote(target), { name: company!, domain }));
  else if (kind === "document") records.push(await documentFromFile(target, { company: company!, companyDomain: domain, date: str("date"), url: str("url") }));
  else if (kind === "drive") records.push(await driveRecord(target, { company: company!, companyDomain: domain }));
  else if (kind === "gmail" || kind === "outlook") {
    const mails = kind === "gmail" ? await gmailSearch(target, { max }) : await outlookSearch(target, { max });
    for (const m of mails) records.push(emailToRecord(m, { company, companyDomain: domain }));
    if (!mails.length) return console.log("No messages matched.");
  } else if (kind === "affinity") {
    const [o] = await affinitySearchOrgs(target);
    if (!o) return console.log(`No Affinity organization matches "${target}".`);
    await affinityWithNotes(o, true);
  } else if (kind === "affinity-list") {
    for (const o of await affinityListOrgs(Number(target))) await affinityWithNotes(o, Boolean(flags.notes));
  } else if (kind === "yc") {
    const list = (await fetchYcBatch(target)).slice(0, str("limit") ? Number(str("limit")) : undefined);
    for (const c of list) {
      if (flags.founders) c.founders = await fetchYcFounders(c.slug).catch(() => undefined);
      records.push(ycToRecord(c));
    }
  } else if (kind === "formd") {
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
