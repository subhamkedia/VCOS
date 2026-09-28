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
