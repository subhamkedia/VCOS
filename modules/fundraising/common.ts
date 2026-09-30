import type { Db } from "../../lib/db.js";
import { getRaise, type RaiseRow } from "../../ledger/fundraising.js";
import { getProfile } from "../firm/profile.js";
import { isReady } from "../connections/index.js";

export class FundraisingInvalid extends Error {}

export const isDay = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
export const today = () => new Date().toISOString().slice(0, 10);
export const addDays = (d: string, n: number) => new Date(Date.parse(d) + n * 86_400_000).toISOString().slice(0, 10);
export const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
export const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
export const longDate = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
export const money = (v: unknown): number | null => {
  if (v === undefined || v === null || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? n : null;
};
export const text = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
export const emailsOf = (v: unknown): string[] =>
  (Array.isArray(v) ? v.map(String) : String(v ?? "").split(/[,;\s]+/)).map((s) => s.trim().toLowerCase()).filter(Boolean);

export async function raiseOr404(db: Db, id: string): Promise<RaiseRow> {
  const r = await getRaise(db, id);
  if (!r) throw new FundraisingInvalid("No such raise.");
  return r;
}

export async function firmName(db: Db): Promise<string> {
  return (await getProfile(db))?.profile.firm.name ?? "our firm";
}

/** Where email drafts go: the firm's own mailbox, never sent by VC OS. */
export async function mailChannel(db: Db): Promise<"gmail_draft" | "outlook_draft" | null> {
  return (await isReady(db, "gmail")) ? "gmail_draft" : (await isReady(db, "outlook")) ? "outlook_draft" : null;
}
