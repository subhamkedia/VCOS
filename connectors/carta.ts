import { requireKey, setting } from "../lib/config.js";
import { parseCsv } from "../lib/csv.js";
import { asArray, asNumber, asString, requestJson } from "./http.js";
import type { FetchLike } from "./types.js";
import type { Holding } from "../engines/cap-table.js";

/**
 * Carta, two ways.
 *
 * 1. The Carta API Platform (partner access, OAuth 2.0 client credentials,
 *    v1alpha1 Investor API): the firm's funds, its investments, and the
 *    capitalization tables Carta shares with it. Access is invite-only;
 *    paths follow Carta's API reference and should be checked once with
 *    `pnpm connectors --check` on a real account.
 * 2. A cap table export (CSV from Carta, Pulley or a spreadsheet), which
 *    works for any company, connected or not.
 */

const tokenCache = new Map<string, { token: string; expiresAt: number }>();

async function token(fetchImpl?: FetchLike): Promise<string> {
  const id = requireKey("cartaClientId");
  const secret = requireKey("cartaClientSecret");
  const hit = tokenCache.get(id);
  if (hit && hit.expiresAt > Date.now() + 60_000) return hit.token;
  const res = await requestJson<{ access_token?: string; expires_in?: number }>("carta", "https://login.app.carta.com/o/access_token/", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}` },
    body: new URLSearchParams({ grant_type: "client_credentials", scope: "read_investor_firms read_investor_funds read_investor_investments read_investor_capitalizationtables" }),
    fetchImpl,
  });
  if (!res.access_token) throw new Error("Carta did not return an access token.");
  tokenCache.set(id, { token: res.access_token, expiresAt: Date.now() + (res.expires_in ?? 3600) * 1000 });
  return res.access_token;
}

const api = async <T>(path: string, fetchImpl?: FetchLike) =>
  requestJson<T>("carta", `${(setting("cartaApiBase") || "https://api.carta.com").replace(/\/$/, "")}/v1alpha1${path}`, {
    headers: { Authorization: `Bearer ${await token(fetchImpl)}` }, fetchImpl,
  });

export async function cartaFirms(fetchImpl?: FetchLike) {
  const r = await api<{ firms?: unknown[] }>("/investors/firms", fetchImpl);
  return asArray(r.firms).map((f) => ({ id: String(f.id), name: asString(f.name) ?? "Firm" }));
}

export async function cartaFunds(firmId: string, fetchImpl?: FetchLike) {
  const r = await api<{ funds?: unknown[] }>(`/investors/firms/${encodeURIComponent(firmId)}/funds`, fetchImpl);
  return asArray(r.funds).map((f) => ({ id: String(f.id), name: asString(f.name) ?? "Fund" }));
}

/** Map a Carta capitalization table response to holdings. Pure; defensive about field names. */
export function cartaCapTableHoldings(json: unknown): Holding[] {
  const root = (json as { capitalizationTable?: unknown })?.capitalizationTable ?? json;
  const rows = [
    ...asArray((root as { shareClasses?: unknown })?.shareClasses),
    ...asArray((root as { securities?: unknown })?.securities),
  ];
  return rows.flatMap((r) => {
    const name = asString(r.name) ?? asString(r.shareClassName) ?? "Shares";
    const shares = asNumber(r.fullyDilutedShares) ?? asNumber(r.outstandingShares) ?? asNumber(r.quantity);
    if (!shares) return [];
    return [{ holder: asString(r.holderName) ?? name, className: name, shares, kind: kindOf(name, asString(r.type)) }];
  });
}

export async function cartaCheck(fetchImpl?: FetchLike): Promise<string> {
  const firms = await cartaFirms(fetchImpl);
  return `Carta: ${firms.length} firm${firms.length === 1 ? "" : "s"} visible (${firms.map((f) => f.name).join(", ")})`;
}

// ---------------------------------------------------------------------------
// Cap table exports (CSV)
// ---------------------------------------------------------------------------

export function kindOf(className: string, type?: string): Holding["kind"] {
  const s = `${className} ${type ?? ""}`.toLowerCase();
  if (/available|unissued|unallocated|pool|reserved/.test(s)) return "pool";
  if (/option|rsu|warrant|award/.test(s)) return "options";
  if (/prefer|series/.test(s)) return "preferred";
  return "common";
}

const HOLDER = /^(stakeholder|holder|name|shareholder|stockholder|investor)( name)?$/;
const CLASS = /^(share class|class|security|security class|security type|stock class|type)$/;
const SHARES = /^(shares|quantity|outstanding|shares outstanding|fully diluted( shares)?|number of shares|amount of shares)$/;

/**
 * Holdings from a cap table export: one row per holder and class, with
 * holder, class and share-count columns (the header names Carta, Pulley
 * and most spreadsheets use). Totals rows are skipped. Pure.
 */
export function capTableFromCsv(text: string): { holdings: Holding[]; skipped: number } {
  const rows = parseCsv(text);
  const head = (rows[0] ?? []).map((h) => h.trim().toLowerCase());
  const hi = head.findIndex((h) => HOLDER.test(h));
  const ci = head.findIndex((h) => CLASS.test(h));
  const si = head.findIndex((h) => SHARES.test(h));
  if (hi < 0 || si < 0) throw new Error("The file needs a holder column (Stakeholder, Holder or Name) and a share count column (Shares, Quantity or Outstanding).");
  const holdings: Holding[] = [];
  let skipped = 0;
  for (const r of rows.slice(1)) {
    const holder = (r[hi] ?? "").trim();
    const shares = Number((r[si] ?? "").replace(/[,\s]/g, ""));
    if (!holder || /^total/i.test(holder) || !Number.isFinite(shares) || shares <= 0) {
      skipped++;
      continue;
    }
    const className = (ci >= 0 ? r[ci]?.trim() : "") || "Common";
    holdings.push({ holder, className, shares, kind: kindOf(className) });
  }
  if (!holdings.length) throw new Error("No holdings found in the file.");
  return { holdings, skipped };
}
