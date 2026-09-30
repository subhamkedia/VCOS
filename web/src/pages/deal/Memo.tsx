import { Fragment, useState } from "react";
import { api, useApi } from "../../api";
import { useSession } from "../../app";
import type { Memo } from "../../types";
import { ErrorState, Loading, Notice, Time, actor, useToast } from "../../ui";
import { useVocab } from "../../vocab";
import { SourceViewer } from "../Company";
import type { TabProps } from "../Deal";

/**
 * The IC memo. Every factual sentence carries citations to the facts it
 * states; a check in code drops any sentence that doesn't, or whose numbers
 * don't match what it cites, and lists what it dropped.
 */
export default function MemoTab({ data, onChange }: TabProps) {
  const { can } = useSession();
  const toast = useToast();
  const { data: opts } = useApi<{ llm: boolean }>("/diligence/options");
  const [version, setVersion] = useState<number | null>(data.memos[0]?.version ?? null);
  const [busy, setBusy] = useState<string | null>(null);
  const draft = async (body: { shareable?: boolean; writer?: "claude" }, key: string) => {
    setBusy(key);
    try {
      const m = await api<{ version: number; check_result: Memo["check_result"] }>(`/deals/${data.deal.id}/memos`, { body });
      const dropped = m.check_result.rejected.length;
      toast(dropped ? "bad" : "good", dropped ? `Version ${m.version} saved. ${dropped} ${dropped === 1 ? "sentence was" : "sentences were"} dropped for missing support; see below.` : `Version ${m.version} saved. Every fact is cited.`);
      setVersion(m.version);
      onChange();
    } catch (e) {
      toast("bad", (e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  return (
    <>
      {can("work_deals") && (
        <div className="row">
          <button className="btn primary" disabled={Boolean(busy)} aria-busy={busy === "std"} onClick={() => void draft({}, "std")}>{busy === "std" ? "Drafting…" : "Draft from the ledger"}</button>
          {opts?.llm && <button className="btn" disabled={Boolean(busy)} aria-busy={busy === "ai"} onClick={() => void draft({ writer: "claude" }, "ai")} title="Claude writes the prose from the same facts; the same citation check applies.">{busy === "ai" ? "Claude is writing…" : "Draft with Claude (beta)"}</button>}
          <button className="btn ghost" disabled={Boolean(busy)} onClick={() => void draft({ shareable: true }, "share")}>Shareable version</button>
        </div>
      )}
      <p className="small muted" style={{ margin: 0 }}>The shareable version uses only facts from public sources, and leaves out your fund's numbers and judgment, for co-investors.</p>
      {data.memos.length === 0 ? <Notice>No memo yet. Gather sources and log calls first; the draft only says what the ledger can cite.</Notice> : (
        <div className="row" role="group" aria-label="Memo versions">
          {data.memos.map((m) => (
            <button key={m.id} className={`chip`} aria-pressed={m.version === version} onClick={() => setVersion(m.version)}>
              v{m.version}{m.shareable ? " · shareable" : ""}{m.drafted_by.startsWith("agent:") ? " · Claude" : ""}
            </button>
          ))}
        </div>
      )}
      {version !== null && <MemoView dealId={data.deal.id} version={version} />}
    </>
  );
}

function MemoView({ dealId, version }: { dealId: string; version: number }) {
  const v = useVocab();
  const { data: m, error } = useApi<Memo>(`/deals/${dealId}/memos/${version}`);
  const [open, setOpen] = useState<string | null>(null);
  const [reading, setReading] = useState<string | null>(null);
  if (error) return <ErrorState error={error} />;
  if (!m) return <Loading what="Loading memo" />;
  const numbers = new Map<string, number>();
  let n = 0;
  const numberOf = (id: string) => {
    if (!numbers.has(id)) numbers.set(id, ++n);
    return numbers.get(id)!;
  };
  const r = m.check_result;
  return (
    <div className="memo-grid">
      <article className="panel panel-pad memo" aria-label={m.body.title}>
        <div className="spread">
          <h2 style={{ fontSize: 20, marginTop: 0 }}>{m.body.title}</h2>
          <a className="btn small" href={`/api/deals/${dealId}/memos/${version}?format=md`} download>Download Markdown</a>
        </div>
        <p className="small muted">Version {m.version}, drafted <Time at={m.created_at} /> by {actor(m.created_by)}{m.drafted_by.startsWith("agent:") ? " with Claude" : ""}.</p>
        {m.body.sections.map((s) => (
          <section key={s.id} aria-label={s.heading} className="section" style={{ gap: 6 }}>
            <h2>{s.heading}</h2>
            <p>
              {s.sentences.map((x, i) => (
                <Fragment key={i}>
                  <span className={x.kind === "view" ? "view" : undefined}>{x.text}</span>
                  {x.cites.map((c) => (
                    <sup key={c}><button type="button" aria-expanded={open === c} aria-label={`Source ${numberOf(c)}: ${m.refs[c]?.label ?? "citation"}`} onClick={() => setOpen(open === c ? null : c)}>{numberOf(c)}</button></sup>
                  ))}{" "}
                </Fragment>
              ))}
            </p>
            {s.sentences.some((x) => x.cites.includes(open ?? "")) && open && m.refs[open] && (
              <div className="cite-card" role="note">
                <strong>{m.refs[open].label}</strong>{m.refs[open].display ? `: ${m.refs[open].display}` : ""}
                <div className="muted">
                  {m.refs[open].source}{m.refs[open].sourceType ? ` · ${v.sourceType(m.refs[open].sourceType!)}` : ""}{m.refs[open].superseded ? " · since superseded" : ""}
                </div>
                {m.refs[open].evidenceId && <button className="btn ghost small" style={{ paddingLeft: 0 }} onClick={() => setReading(m.refs[open]?.evidenceId ?? null)}>Show in source</button>}
              </div>
            )}
          </section>
        ))}
        {reading && <SourceViewer id={reading} onClose={() => setReading(null)} />}
      </article>
      <aside className="panel panel-pad section" aria-labelledby="check-h" style={{ alignSelf: "start" }}>
        <h2 id="check-h">Citation check</h2>
        <span className={`pill ${r.ok ? "good" : "warn"}`} style={{ alignSelf: "flex-start" }}>{r.ok ? "Every fact cited" : `${r.rejected.length} dropped`}</span>
        <dl className="kv small">
          <dt>Sentences</dt><dd>{r.sentences}</dd>
          <dt>Facts</dt><dd>{r.facts}</dd>
          <dt>Citations</dt><dd>{r.citations}</dd>
        </dl>
        {r.rejected.length > 0 && (
          <>
            <h3>Dropped for missing support</h3>
            <ul className="small" style={{ margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 6 }}>
              {r.rejected.map((x, i) => <li key={i}><q>{x.text}</q><br /><span className="muted">{x.section}: {x.reason}</span></li>)}
            </ul>
          </>
        )}
        <p className="small muted" style={{ margin: 0 }}>Every factual sentence must cite facts from the ledger, and every number must match what it cites, at the precision it's written. The check is code; a writer can't talk its way past it.</p>
      </aside>
    </div>
  );
}
