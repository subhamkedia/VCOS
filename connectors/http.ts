import type { FetchLike } from "./types.js";

/** An API answered with an error. `status` lets callers treat 404 as "not found" rather than a failure. */
export class HttpError extends Error {
  constructor(
    readonly vendor: string,
    readonly status: number,
    body: string,
  ) {
    super(`${vendor} ${status}: ${body.slice(0, 300)}`);
  }
}

/**
 * A failure from an outside tool as a sentence a person can act on:
 * who answered, what it means, and what to do. Other errors pass through.
 */
export function problemText(err: unknown, source = "The source"): string {
  if (err instanceof HttpError) {
    const s = err.status;
    if (s === 401) return `${source} didn't accept the credentials (HTTP 401). Reconnect it or enter a new key, then test again.`;
    if (s === 403) return `${source} refused access (HTTP 403). Check the account's permissions and the network, then test again.`;
    if (s === 404) return `${source} couldn't find what was asked for (HTTP 404).`;
    if (s === 429) return `${source} is limiting requests (HTTP 429). Try again later.`;
    if (s >= 500) return `${source} had a problem on its side (HTTP ${s}). Try again later.`;
    return `${source} rejected the request (HTTP ${s}).`;
  }
  const m = err instanceof Error ? err.message : String(err);
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|network error/i.test(m)) return `${source} couldn't be reached. Check the network and try again.`;
  return m;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * One HTTP call to a vendor API. Retries 429 and 5xx up to `retries` times,
 * honouring Retry-After, and throws HttpError on any other failure.
 */
export async function request(
  vendor: string,
  url: string,
  init: RequestInit & { fetchImpl?: FetchLike; retries?: number } = {},
): Promise<Response> {
  const { fetchImpl = fetch, retries = 3, ...rest } = init;
  for (let attempt = 0; ; attempt++) {
    const res = await fetchImpl(url, rest);
    if (res.ok) return res;
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= retries) throw new HttpError(vendor, res.status, await res.text());
    const after = Number(res.headers.get("retry-after"));
    await sleep(Number.isFinite(after) && after > 0 ? Math.min(after, 30) * 1000 : 500 * 2 ** attempt);
  }
}

export async function requestJson<T = unknown>(
  vendor: string,
  url: string,
  init: RequestInit & { fetchImpl?: FetchLike; retries?: number } = {},
): Promise<T> {
  const res = await request(vendor, url, { ...init, headers: { Accept: "application/json", ...init.headers } });
  return (await res.json()) as T;
}

/** Read a dotted path out of an untyped vendor payload. */
export const pick = (o: unknown, path: string): unknown =>
  path.split(".").reduce<unknown>((acc, k) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[k] : undefined), o);

export const asString = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

export const asNumber = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && !isNaN(Number(v)) ? Number(v) : undefined;

export const asDate = (v: unknown): string | undefined => {
  const s = typeof v === "number" ? new Date(v > 1e12 ? v : v * 1000).toISOString() : asString(v);
  if (!s) return undefined;
  const d = new Date(s);
  return isNaN(d.getTime()) ? undefined : d.toISOString().slice(0, 10);
};

export const asArray = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? (v as Record<string, unknown>[]) : []);

// ---------------------------------------------------------------------------
// Fetching addresses people type in: public internet only (SSRF guard)
// ---------------------------------------------------------------------------

export type Resolver = (host: string) => Promise<string[]>;

const defaultResolver: Resolver = async (host) => {
  const { lookup } = await import("node:dns/promises");
  return (await lookup(host, { all: true })).map((a) => a.address);
};

/** Loopback, private, link-local, carrier-grade NAT, multicast and unspecified addresses. */
export function isPrivateAddress(ip: string): boolean {
  const v4 = ip.startsWith("::ffff:") ? ip.slice(7) : ip;
  const m = v4.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const v6 = ip.toLowerCase();
  return v6 === "::" || v6 === "::1" || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6) || v6.startsWith("ff");
}

/** Throws unless the URL is http(s) and its host resolves only to public addresses. */
export async function assertPublicUrl(url: string, resolve: Resolver = defaultResolver): Promise<URL> {
  const u = new URL(url);
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("Use an http(s) link.");
  if (u.username || u.password) throw new Error("Links with a user name or password aren't allowed.");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) {
    throw new Error("That address isn't on the public internet.");
  }
  const addresses = /^[\d.]+$/.test(host) || host.includes(":") ? [host] : await resolve(host);
  if (!addresses.length || addresses.some(isPrivateAddress)) throw new Error("That address isn't on the public internet.");
  return u;
}

/** GET a public URL, re-checking every redirect hop. */
export async function fetchPublic(
  vendor: string,
  url: string,
  opts: { headers?: Record<string, string>; fetchImpl?: FetchLike; resolve?: Resolver; maxRedirects?: number } = {},
): Promise<Response> {
  let current = url;
  for (let hop = 0; hop <= (opts.maxRedirects ?? 3); hop++) {
    await assertPublicUrl(current, opts.resolve);
    const res = await (opts.fetchImpl ?? fetch)(current, { headers: opts.headers, redirect: "manual" });
    const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (!location) {
      if (!res.ok) throw new HttpError(vendor, res.status, await res.text());
      return res;
    }
    current = new URL(location, current).toString();
  }
  throw new Error(`${vendor}: too many redirects`);
}
