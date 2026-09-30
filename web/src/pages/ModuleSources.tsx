import { Link } from "react-router-dom";
import { useApi } from "../api";
import type { Connector } from "../types";
import { MODULE_USES } from "./Connections";

const TONE: Record<string, string> = { connected: "good", available: "info", error: "bad", not_configured: "quiet" };
const LABEL: Record<string, string> = { connected: "Connected", available: "Ready", error: "Needs attention", not_configured: "Not connected" };

/**
 * The outside tools a module draws on and whether each is ready, with the
 * way to Connections, where every tool is connected once for all modules.
 */
export function ModuleSources({ module }: { module: string }) {
  const { data } = useApi<Connector[]>("/connections");
  const use = MODULE_USES.find((m) => m.id === module);
  if (!data || !use) return null;
  const list = data.filter((c) => use.uses(c));
  if (!list.length) return null;
  return (
    <section className="sources-strip" aria-label={`Tools ${use.label} uses`}>
      <span className="small muted">Tools</span>
      {list.map((c) => {
        const status = c.manual ? "available" : c.status;
        return <span key={c.id} className="small source-chip" title={use.uses(c)}><span className={`status-dot ${TONE[status]}`} aria-hidden="true" />{c.name}<span className="sr-only">: {c.manual ? "ready, add files" : LABEL[status]}</span></span>;
      })}
      <Link className="small" to={`/connections?module=${module}`}>Manage in Connections</Link>
    </section>
  );
}
