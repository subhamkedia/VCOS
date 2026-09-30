import { requireKey, setting } from "../lib/config.js";
import { asArray, asDate, asString, requestJson } from "./http.js";
import type { FetchLike } from "./types.js";

/**
 * Parallel Markets (an iCapital company): investor accreditation for
 * 506(c) offerings, KYC/KYB, AML and sanctions monitoring, reusable across
 * the funds an investor joins. The investor completes Parallel's flow; the
 * firm reads the result with its own API key. Read only.
 *
 * Paths follow Parallel's developer documentation as far as it is public
 * and sit in PARALLEL_PATHS so they can be corrected in one place; check them
 * once against a live account with `pnpm connectors --check`.
 */

export const PARALLEL_PATHS = {
  base: "https://api.parallelmarkets.com/v1",
  me: "/me",
  /** Accreditation records for an investor, looked up by the email they used with Parallel. */
  accreditations: "/accreditations",
  identity: "/identity",
};

const base = () => (setting("parallelApiBase") || PARALLEL_PATHS.base).replace(/\/$/, "");
const headers = () => ({ Authorization: `Bearer ${requireKey("parallelApiKey")}` });

export interface ParallelStatus {
  accredited: boolean;
  accreditationStatus: string | null;
  accreditationExpires: string | null;
  identityStatus: string | null;
  kycCleared: boolean;
}

/** Pure: map Parallel's accreditation and identity payloads to what VC OS records. */
export function parseParallel(accreditations: unknown, identity: unknown): ParallelStatus {
  const acc = asArray((accreditations as { accreditations?: unknown })?.accreditations ?? accreditations);
  const current = acc.find((a) => asString(a.status) === "current") ?? acc[0];
  const idStatus = asString((identity as { identity_details?: { status?: unknown } })?.identity_details?.status) ?? asString((identity as { status?: unknown })?.status) ?? null;
  const accStatus = current ? asString(current.status) ?? null : null;
  return {
    accredited: accStatus === "current",
    accreditationStatus: accStatus,
    accreditationExpires: current ? asDate(current.expires_at) ?? null : null,
    identityStatus: idStatus,
    kycCleared: idStatus === "approved" || idStatus === "current" || idStatus === "verified",
  };
}

export async function parallelStatus(email: string, fetchImpl?: FetchLike): Promise<ParallelStatus> {
  const q = new URLSearchParams({ email });
  const [a, i] = await Promise.all([
    requestJson("parallel", `${base()}${PARALLEL_PATHS.accreditations}?${q}`, { headers: headers(), fetchImpl }),
    requestJson("parallel", `${base()}${PARALLEL_PATHS.identity}?${q}`, { headers: headers(), fetchImpl }),
  ]);
  return parseParallel(a, i);
}

export async function parallelCheck(fetchImpl?: FetchLike): Promise<string> {
  const me = await requestJson<Record<string, unknown>>("parallel", `${base()}${PARALLEL_PATHS.me}`, { headers: headers(), fetchImpl });
  return `Parallel Markets: connected${asString(me.name) ? ` as ${asString(me.name)}` : ""}.`;
}
