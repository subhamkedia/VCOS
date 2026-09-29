import type { Db } from "../../lib/db.js";
import { encrypt } from "../../lib/secrets.js";
import { sha256 } from "../../lib/text.js";
import { newToken, type PortalRef } from "../../ledger/platform.js";
import { predicateLabel } from "../../ledger/labels.js";
import { getEntity } from "../../ledger/repository.js";
import {
  accountingLinks, contacts, insertKpiRequest, insertPortalLink, kpiRequests, revokePortalLinks, setPortalOAuth, updateKpiRequest, upsertAccountingLink,
} from "../../ledger/portfolio.js";
import { getProfile } from "../firm/profile.js";
import { isReady } from "../connections/index.js";
import { queue } from "../outbox/index.js";
import { pkcePair } from "../../connectors/oauth.js";
import {
  ACCOUNTING_NAMES, accountingAuthorizeUrl, accountingConfigured, accountingExchangeCode, quickbooksCompanyName, xeroTenants, type AccountingProvider,
} from "../../connectors/accounting.js";
import { DEFAULT_REQUEST_METRICS, REPORTABLE_METRICS } from "../../connectors/kpi-names.js";
import { holding, isDay, isMonth, PortfolioInvalid } from "./common.js";
import { recordKpis } from "./kpis.js";

/**
 * The founder portal: one link per company, no account, for the founder to
 * report the month's numbers and to connect the company's accounting
 * system (read only). The firm asks for numbers with a KPI request, which
 * is queued as an email draft in the firm's own mailbox (principle 3: VC OS
 * never sends). Keep requests short: a handful of metrics, monthly, so
 * reporting doesn't become a burden on the company.
 *
 * Tokens are random (256 bits), shown once, stored only as hashes, expire,
 * and can be revoked. The portal shows the company only what it needs to
 * report: never the firm's marks, ratings or notes.
 */

export const PORTAL_DAYS = 45;

export async function createPortalLink(db: Db, companyId: string, by: string, appUrl: string): Promise<{ id: string; url: string; expiresAt: string }> {
  await holding(db, companyId);
  const token = newToken();
  const row = await insertPortalLink(db, companyId, sha256(token), PORTAL_DAYS, by);
  return { id: row.id, url: `${appUrl.replace(/\/$/, "")}/portal/${token}`, expiresAt: row.expires_at };
}

export async function revokePortal(db: Db, companyId: string, by: string) {
  await holding(db, companyId);
  return { revoked: await revokePortalLinks(db, companyId, by) };
}

const monthName = (period: string) => new Date(`${period}-15T00:00:00Z`).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });

/**
 * Ask a company for a month's numbers: a portal link, a request row, and an
 * email draft in the firm's mailbox for a person to review and send. With no
 * mailbox connected, the link and the text come back to copy.
 */
export async function requestKpis(
  db: Db,
  companyId: string,
  input: { period: unknown; dueOn: unknown; metrics?: unknown; recipients?: unknown },
  by: string,
  appUrl: string,
) {
  const h = await holding(db, companyId);
  if (!isMonth(input.period)) throw new PortfolioInvalid("Pick the month (YYYY-MM).");
  if (!isDay(input.dueOn)) throw new PortfolioInvalid("Pick a due date.");
  const metrics = Array.isArray(input.metrics) && input.metrics.length ? input.metrics.map(String) : [...DEFAULT_REQUEST_METRICS];
  const bad = metrics.filter((m) => !(REPORTABLE_METRICS as readonly string[]).includes(m));
  if (bad.length) throw new PortfolioInvalid(`Unknown metric: ${bad.join(", ")}.`);
  if (metrics.length > 12) throw new PortfolioInvalid("Ask for twelve metrics at most: short requests get answered.");
  const reporting = (await contacts(db, companyId)).filter((c) => c.reporting).map((c) => c.email);
  const recipients = (Array.isArray(input.recipients) && input.recipients.length ? input.recipients.map((x) => String(x).trim().toLowerCase()) : reporting).filter(Boolean);
  if (!recipients.length) throw new PortfolioInvalid("Add who reports the numbers (a contact marked for reporting), or enter an email.");
  if (recipients.some((r) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(r))) throw new PortfolioInvalid("Check the email addresses.");
  const link = await createPortalLink(db, companyId, by, appUrl);
  const req = await insertKpiRequest(db, { companyId, period: input.period, metrics, dueOn: input.dueOn, recipients, portalLinkId: link.id }, by);
  const firm = (await getProfile(db))?.profile.firm.name ?? "our team";
  const subject = `${h.name}: ${monthName(input.period)} numbers for ${firm}`;
  const body = [
    "Hi,",
    "",
    `Could you share ${h.name}'s numbers for ${monthName(input.period)} by ${new Date(`${input.dueOn}T00:00:00Z`).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" })}? It takes a couple of minutes here, no account needed:`,
    "",
    link.url,
    "",
    "What we're asking for:",
    ...metrics.map((m) => `- ${predicateLabel(m)}`),
    "",
    "If you'd rather not type them each month, you can connect QuickBooks or Xero from the same page (read-only; you can disconnect at any time).",
    "",
    "Thank you,",
  ].join("\n");
  const channel = (await isReady(db, "gmail")) ? "gmail_draft" : (await isReady(db, "outlook")) ? "outlook_draft" : null;
  let outboxId: string | null = null;
  if (channel) {
    outboxId = await queue(db, channel, { to: recipients, subject, body }, { summary: `KPI request: ${h.name}, ${input.period}`, proposedBy: by, entityId: companyId });
    await updateKpiRequest(db, req.id, { outboxId }, by);
  }
  return { requestId: req.id, outboxId, channel, link: link.url, email: { to: recipients, subject, body } };
}

export async function cancelRequest(db: Db, requestId: string, by: string) {
  await updateKpiRequest(db, requestId, { status: "cancelled" }, by);
}

// ---------------------------------------------------------------------------
// What the founder sees (the server finds the firm from the token, then calls these on the firm's Db)
// ---------------------------------------------------------------------------

export async function portalView(db: Db, ref: PortalRef) {
  const company = await getEntity(db, ref.companyId);
  const firm = (await getProfile(db))?.profile.firm.name ?? "Your investor";
  const open = (await kpiRequests(db, { companyId: ref.companyId, status: "open" })).map((r) => ({ period: r.period, dueOn: r.due_on, metrics: r.metrics }));
  const links = (await accountingLinks(db, ref.companyId)).map((l) => ({ provider: l.provider, name: ACCOUNTING_NAMES[l.provider], status: l.status, connectedAt: l.connected_at, lastSyncAt: l.last_sync_at }));
  return {
    company: company?.name ?? "Your company",
    firm,
    requests: open,
    metrics: REPORTABLE_METRICS.map((id) => ({ id, label: predicateLabel(id), percent: /gross_margin|nrr|uptime/.test(id), count: /headcount|count|units/.test(id), plan: id.startsWith("plan.") })),
    accounting: (["quickbooks", "xero"] as AccountingProvider[]).map((p) => ({ provider: p, name: ACCOUNTING_NAMES[p], available: accountingConfigured(p), connected: links.find((l) => l.provider === p) ?? null })),
  };
}

export async function portalSubmit(db: Db, ref: PortalRef, input: { period: unknown; values: unknown; note?: unknown }) {
  const r = await recordKpis(db, ref.companyId, input, "founder-portal", "portal");
  return { claims: r.claims, rejected: r.rejected.length };
}

/** Start connecting the company's books: returns where to send the browser. */
export async function startAccountingLink(db: Db, ref: PortalRef, provider: unknown, redirectUri: string): Promise<string> {
  if (provider !== "quickbooks" && provider !== "xero") throw new PortfolioInvalid("Pick QuickBooks or Xero.");
  if (!accountingConfigured(provider)) throw new PortfolioInvalid(`${ACCOUNTING_NAMES[provider]} isn't set up on this server yet. Report the numbers here instead.`);
  const state = newToken();
  const { verifier, challenge } = pkcePair();
  await setPortalOAuth(db, ref.id, { state, provider, verifier });
  return accountingAuthorizeUrl(provider, { state, redirectUri, challenge });
}

/** The provider sent the founder back: store the (encrypted) refresh token on the company's link. */
export async function finishAccountingLink(
  db: Db,
  ref: PortalRef & { provider: AccountingProvider; verifier: string },
  input: { code: string; realmId?: string; redirectUri: string },
  deps: { exchange?: typeof accountingExchangeCode; tenants?: typeof xeroTenants; companyName?: typeof quickbooksCompanyName } = {},
): Promise<{ company: string; provider: string; externalName: string | null }> {
  const t = await (deps.exchange ?? accountingExchangeCode)(ref.provider, { code: input.code, redirectUri: input.redirectUri, verifier: ref.verifier });
  let externalId: string;
  let externalName: string | null = null;
  if (ref.provider === "quickbooks") {
    if (!input.realmId) throw new PortfolioInvalid("QuickBooks didn't say which company was connected.");
    externalId = input.realmId;
    externalName = await (deps.companyName ?? quickbooksCompanyName)(externalId, t.accessToken);
  } else {
    const orgs = await (deps.tenants ?? xeroTenants)(t.accessToken);
    if (!orgs.length) throw new PortfolioInvalid("Xero didn't grant access to an organisation.");
    externalId = orgs[0]!.id;
    externalName = orgs[0]!.name;
  }
  await upsertAccountingLink(db, { companyId: ref.companyId, provider: ref.provider, externalId, externalName, secret: encrypt(t.refreshToken), portalLinkId: ref.id }, "founder-portal");
  const company = (await getEntity(db, ref.companyId))?.name ?? "the company";
  return { company, provider: ACCOUNTING_NAMES[ref.provider], externalName };
}
