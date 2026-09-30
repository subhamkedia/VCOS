import { requireKey } from "../lib/config.js";
import { parseCsv } from "../lib/csv.js";
import { asArray, asDate, asNumber, asString, requestJson } from "./http.js";
import type { FetchLike } from "./types.js";

/**
 * The fund's bank account, read only, for reconciling capital call receipts
 * and distributions. VC OS never moves money: there is no payment or
 * transfer function here, and a test fails if one appears.
 *
 * 1. Mercury's API (a read-only token from Settings → API tokens):
 *    GET /api/v1/accounts and GET /api/v1/account/{id}/transactions, with a
 *    Bearer token. Incoming wires are positive amounts.
 * 2. A statement export (CSV) from any bank (First Citizens/SVB, JPMorgan,
 *    Bank of America, Silicon Valley Bank's online banking and others all
 *    export CSV), for banks without an API or firms that prefer not to
 *    connect one.
 */

export interface BankTxn {
  externalId: string;
  postedOn: string;
  amount: number;
  counterparty: string | null;
  memo: string | null;
}

const MERCURY = "https://api.mercury.com/api/v1";
const headers = () => ({ Authorization: `Bearer ${requireKey("mercuryApiToken")}` });

export async function mercuryAccounts(fetchImpl?: FetchLike): Promise<{ id: string; name: string; kind: string | null; balance: number | null }[]> {
  const r = await requestJson<{ accounts?: unknown }>("mercury", `${MERCURY}/accounts`, { headers: headers(), fetchImpl });
  return asArray(r.accounts).map((a) => ({
    id: String(a.id), name: asString(a.nickname) ?? asString(a.name) ?? "Account", kind: asString(a.kind) ?? null, balance: asNumber(a.currentBalance) ?? null,
  }));
}

/** Posted transactions on one account between two dates (inclusive), newest first, following Mercury's offset paging. */
export async function mercuryTransactions(accountId: string, start: string, end: string, fetchImpl?: FetchLike): Promise<BankTxn[]> {
  const out: BankTxn[] = [];
  for (let offset = 0; offset < 10_000; offset += 500) {
    const q = new URLSearchParams({ start, end, limit: "500", offset: String(offset) });
    const r = await requestJson<{ transactions?: unknown; total?: number }>("mercury", `${MERCURY}/account/${encodeURIComponent(accountId)}/transactions?${q}`, { headers: headers(), fetchImpl });
    const page = asArray(r.transactions);
    for (const t of page) {
      const status = asString(t.status);
      if (status && status !== "sent" && status !== "posted" && status !== "completed") continue; // pending, failed, cancelled
      const amount = asNumber(t.amount);
      const postedOn = asDate(t.postedAt) ?? asDate(t.createdAt);
      if (amount === undefined || !postedOn) continue;
      out.push({
        externalId: String(t.id), postedOn, amount,
        counterparty: asString(t.counterpartyName) ?? asString(t.counterpartyNickname) ?? null,
        memo: asString(t.externalMemo) ?? asString(t.bankDescription) ?? asString(t.note) ?? null,
      });
    }
    if (page.length < 500) break;
  }
  return out;
}

export async function mercuryCheck(fetchImpl?: FetchLike): Promise<string> {
  const a = await mercuryAccounts(fetchImpl);
  return `Mercury: ${a.length} account${a.length === 1 ? "" : "s"} (${a.map((x) => x.name).join(", ")}).`;
}

// ---------------------------------------------------------------------------
// Statement exports
// ---------------------------------------------------------------------------

const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");
const money = (s: string | undefined) => {
  if (!s?.trim()) return undefined;
  const neg = /^\(.*\)$/.test(s.trim()) || s.trim().startsWith("-");
  const n = Number(s.replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? (neg ? -n : n) : undefined;
};
const dateOf = (s: string | undefined) => {
  if (!s?.trim()) return undefined;
  const t = s.trim();
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(t);
  if (us) return `${us[3]!.length === 2 ? `20${us[3]}` : us[3]}-${us[1]!.padStart(2, "0")}-${us[2]!.padStart(2, "0")}`;
  return asDate(t);
};

/**
 * Parse a bank statement CSV. Understands a single signed Amount column or
 * separate Credit/Debit (Deposit/Withdrawal) columns, US or ISO dates, and
 * common description column names. Rows without a date or amount are
 * skipped. The id is the bank's reference when there is one, else a hash of
 * the row so re-importing the same file adds nothing.
 */
export function parseBankCsv(text: string): { rows: BankTxn[]; skipped: number } {
  const [head, ...body] = parseCsv(text);
  if (!head) return { rows: [], skipped: 0 };
  const h = head.map(norm);
  const col = (...names: string[]) => h.findIndex((x) => names.includes(x));
  const date = col("date", "posteddate", "postingdate", "transactiondate", "valuedate", "bookingdate");
  const amount = col("amount", "amountusd", "transactionamount");
  const credit = col("credit", "credits", "deposit", "deposits", "creditamount", "moneyin");
  const debit = col("debit", "debits", "withdrawal", "withdrawals", "debitamount", "moneyout");
  const desc = col("description", "memo", "details", "narrative", "transactiondescription", "bankdescription");
  const party = col("counterparty", "counterpartyname", "payee", "payer", "name", "originator");
  const ref = col("reference", "referencenumber", "transactionid", "id", "fitid", "banktransactionid");
  if (date < 0 || (amount < 0 && credit < 0 && debit < 0)) throw new Error("The file needs a date column and an amount (or credit and debit) column.");
  const rows: BankTxn[] = [];
  let skipped = 0;
  const seen = new Map<string, number>();
  body.forEach((r) => {
    if (!r.some((x) => x.trim())) return;
    const d = dateOf(r[date]);
    const a = amount >= 0 ? money(r[amount]) : (money(r[credit]) ?? 0) - Math.abs(money(r[debit]) ?? 0);
    if (!d || a === undefined || a === 0) { skipped++; return; }
    const memo = desc >= 0 ? r[desc]?.trim() || null : null;
    const counterparty = party >= 0 ? r[party]?.trim() || null : null;
    // Two identical rows in one file are two transactions: number repeats so a re-import still matches.
    const base = ref >= 0 && r[ref]?.trim() ? r[ref]!.trim() : `csv:${d}:${a.toFixed(2)}:${(counterparty ?? memo ?? "").slice(0, 60)}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    const externalId = n === 1 ? base : `${base}#${n}`;
    rows.push({ externalId, postedOn: d, amount: a, counterparty, memo });
  });
  return { rows, skipped };
}
