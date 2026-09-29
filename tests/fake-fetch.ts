/** A fetch stand-in: the longest matching URL prefix answers. Arrays answer in order, repeating the last. */
export type Route = { status?: number; body: string | Uint8Array; headers?: Record<string, string> } | Array<{ status?: number; body: string; headers?: Record<string, string> }>;

export function fakeFetch(routes: Record<string, Route>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const seen = new Map<string, number>();
  const impl = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const key = Object.keys(routes).sort((a, b) => b.length - a.length).find((k) => url.startsWith(k));
    if (!key) return new Response(`no route for ${url}`, { status: 404 });
    const r = routes[key]!;
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    const one = Array.isArray(r) ? r[Math.min(n, r.length - 1)]! : r;
    return new Response(one.body as BodyInit, { status: one.status ?? 200, headers: one.headers });
  };
  return { impl, calls };
}

export const json = (v: unknown) => ({ body: JSON.stringify(v), headers: { "content-type": "application/json" } });

/** Public-address resolver for the SSRF guard in tests. */
export const publicDns = async () => ["93.184.216.34"];
