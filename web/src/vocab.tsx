import { createContext, useContext, type ReactNode } from "react";
import { useApi } from "./api";

/**
 * Readable names for every id the ledger stores (served by /api/vocabulary,
 * defined once in ledger/labels.ts). Pages call `v.predicate(id)` and never
 * show `team.headcount` or `self_reported`.
 */
export interface VocabData {
  predicates: Record<string, { label: string; description: string; kind: string }>;
  groups: { id: string; label: string; prefixes: string[] }[];
  sourceTypes: Record<string, string>;
  sourceTypeHelp: Record<string, string>;
  scopes: Record<string, string>;
  scopeHelp: Record<string, string>;
  evidenceKinds: Record<string, string>;
  identifiers: Record<string, string>;
  sources: Record<string, string>;
  enumValues: Record<string, string>;
  fitCriteria: Record<string, string>;
  severities: Record<string, string>;
  passReasons: Record<string, string>;
  actions: Record<string, string>;
  decisions: Record<string, string>;
}

const humanize = (id: string) => id.replace(/[._-]+/g, " ").replace(/^\w/, (c) => c.toUpperCase());

export function makeVocab(d: VocabData | null) {
  const pick = (m: Record<string, string> | undefined, id: string) => m?.[id] ?? humanize(id);
  return {
    predicate: (id: string) => d?.predicates[id]?.label ?? humanize(id.split(".").pop() ?? id),
    predicateHelp: (id: string) => d?.predicates[id]?.description ?? "",
    sourceType: (id: string) => pick(d?.sourceTypes, id),
    sourceTypeHelp: (id: string) => d?.sourceTypeHelp[id] ?? "",
    scope: (id: string) => pick(d?.scopes, id),
    scopeHelp: (id: string) => d?.scopeHelp[id] ?? "",
    kind: (id: string) => pick(d?.evidenceKinds, id),
    identifier: (id: string) => pick(d?.identifiers, id),
    source: (id: string) => pick(d?.sources, id),
    enumValue: (id: string) => pick(d?.enumValues, id),
    criterion: (id: string) => pick(d?.fitCriteria, id),
    severity: (id: string) => pick(d?.severities, id),
    passReason: (id: string) => pick(d?.passReasons, id),
    decision: (id: string) => pick(d?.decisions, id),
    passReasonIds: Object.keys(d?.passReasons ?? {}),
    /** An audit action as a phrase; unknown ones read as "made a change", never as an identifier. */
    action: (id: string) => d?.actions?.[id] ?? "made a change",
    groupOf: (predicate: string) => d?.groups.find((g) => g.prefixes.some((p) => predicate.startsWith(p))) ?? { id: "other", label: "Other", prefixes: [] },
    groups: d?.groups ?? [],
  };
}

export type Vocab = ReturnType<typeof makeVocab>;

const Ctx = createContext<Vocab>(makeVocab(null));
export const useVocab = () => useContext(Ctx);

export function VocabProvider({ children }: { children: ReactNode }) {
  const { data } = useApi<VocabData>("/vocabulary");
  return <Ctx.Provider value={makeVocab(data)}>{children}</Ctx.Provider>;
}
