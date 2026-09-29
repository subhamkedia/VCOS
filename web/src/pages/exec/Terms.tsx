import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../api";
import { useSession } from "../../app";
import type { Standing, TermSheetStatus, TermSheetTerms, TermSheetVersion } from "../../types";
import { Field, Group, MoneyInput, Notice, NumberInput, Seg, Select, Time, useConfirm, useToast } from "../../ui";
import { SECURITY_LABELS, TERM_STATUS_LABELS } from "../Execution";
import { person, type ExecTabProps } from "../ExecutionDeal";

const STANDING: Record<Standing, { label: string; tone: string }> = {
  standard: { label: "Standard", tone: "good" }, investor_friendly: { label: "Investor-friendly", tone: "info" },
  founder_friendly: { label: "Founder-friendly", tone: "warn" }, off_market: { label: "Off-market", tone: "bad" },
};

const BLANK: TermSheetTerms = {
  security: "preferred", seriesName: "Series A Preferred",
  liquidation: { multiple: 1, participation: "none", seniority: "pari_passu" }, dividends: { kind: "non_cumulative" }, antiDilution: "broad_wa",
  redemption: false, payToPlay: false, board: { ours: "none" }, protectiveProvisions: "standard", dragAlong: true, proRata: "major_investors",
  informationRights: true, managementRightsLetter: false, mfn: false, founderVesting: { years: 4, cliffMonths: 12, acceleration: "double" },
  oispRepresentation: false, qsbsRepresentation: false, tranched: false,
};

/**
 * The term sheet, as structured terms. Each version is checked term by term
 * against the NVCA model and the firm's house terms; nothing is judged by a
 * model. Marking a version signed records the round's economics as facts.
 */
export default function Terms({ data, onChange }: ExecTabProps) {
  const { can } = useSession();
  const [editing, setEditing] = useState(false);
  const live = data.termSheets.find((t) => t.status !== "superseded") ?? data.termSheets[0];
  const decided = ["passed", "closed"].includes(data.deal.stage);
  return (
    <>
      {editing ? (
        <TermForm initial={live?.terms ?? BLANK} dealId={data.deal.id} onDone={() => { setEditing(false); onChange(); }} onCancel={() => setEditing(false)} />
      ) : (
        can("work_deals") && !decided && (
          <div className="row">
            <button className="btn primary" onClick={() => setEditing(true)}>{live ? "New version" : "Enter the term sheet"}</button>
            <span className="small muted">Each change is a new version; earlier ones are kept.</span>
          </div>
        )
      )}
      {!live ? <Notice>No term sheet yet. Enter the terms when you have them: VC OS checks each one against the NVCA model and your <Link to="/settings/terms">house terms</Link>, and models the round.</Notice> : (
        <>
          <Checks sheet={live} />
          <Versions data={data} onChange={onChange} />
        </>
      )}
    </>
  );
}

function Checks({ sheet }: { sheet: TermSheetVersion }) {
  const t = sheet.terms;
  const outside = sheet.checks.filter((c) => c.house === "outside");
  return (
    <section className="panel panel-pad section" aria-labelledby="checks-h">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 id="checks-h">Version {sheet.version}: {t.seriesName || SECURITY_LABELS[t.security]}</h2>
        <span className={`pill ${sheet.status === "signed" ? "good" : "info"}`}>{TERM_STATUS_LABELS[sheet.status]}</span>
      </div>
      <dl className="kv">
        <dt>Instrument</dt><dd>{SECURITY_LABELS[t.security]}</dd>
        {t.security === "preferred" ? (
          <>
            <dt>Pre-money</dt><dd>{fmt(t.preMoneyUsd)}</dd>
            <dt>Round size</dt><dd>{fmt(t.raiseUsd)}</dd>
          </>
        ) : (
          <>
            <dt>Valuation cap</dt><dd>{fmt(t.valuationCapUsd)}</dd>
            <dt>Discount</dt><dd>{t.discountPct ? `${t.discountPct}%` : "—"}</dd>
          </>
        )}
        <dt>Our allocation</dt><dd>{fmt(t.ourAllocationUsd)}</dd>
        {t.leadInvestor && <><dt>Lead</dt><dd>{t.leadInvestor}</dd></>}
      </dl>
      {outside.length > 0 ? (
        <Notice tone="warn">{outside.length} {outside.length === 1 ? "term is" : "terms are"} outside your house terms: {outside.map((c) => c.label.toLowerCase()).join(", ")}.</Notice>
      ) : <Notice tone="good">Every term is within your house terms.</Notice>}
      <div className="table-wrap">
        <table className="t checks">
          <caption className="sr-only">Each term compared with the NVCA model and your house terms</caption>
          <thead><tr><th scope="col">Term</th><th scope="col">This term sheet</th><th scope="col">Against NVCA and market</th><th scope="col">Your house terms</th></tr></thead>
          <tbody>
            {sheet.checks.map((c) => (
              <tr key={c.key}>
                <th scope="row">{c.label}</th>
                <td>{c.value}{c.note && <div className="small muted">{c.note}</div>}</td>
                <td><span className={`pill ${STANDING[c.nvca].tone}`}>{STANDING[c.nvca].label}</span><div className="ref">{c.reference}</div></td>
                <td>{c.house === "ok" ? <span className="pill good">Within</span> : c.house === "outside" ? <span className="pill bad">Outside</span> : <span className="muted small">No house rule</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {t.otherTerms && <div><h3>Other terms</h3><p className="small" style={{ whiteSpace: "pre-wrap", margin: 0 }}>{t.otherTerms}</p></div>}
    </section>
  );
}

function Versions({ data, onChange }: ExecTabProps) {
  const { can } = useSession();
  const toast = useToast();
  const confirm = useConfirm();
  const set = async (v: TermSheetVersion, status: TermSheetStatus) => {
    if (status === "signed" && !(await confirm({
      title: `Mark version ${v.version} signed?`,
      body: "The round's size, valuation and lead become facts about the company, cited to this term sheet. Other versions are marked superseded.",
      confirm: "Mark signed",
    }))) return;
    try {
      await api(`/deals/${data.deal.id}/term-sheets/${v.version}/status`, { body: { status } });
      toast("good", `Version ${v.version}: ${TERM_STATUS_LABELS[status].toLowerCase()}.`);
      onChange();
    } catch (e) {
      toast("bad", (e as Error).message);
    }
  };
  return (
    <section className="panel panel-pad section" aria-labelledby="versions-h">
      <h2 id="versions-h">Versions</h2>
      <ul className="timeline small">
        {data.termSheets.map((v) => (
          <li key={v.id}>
            <span><Time at={v.created_at} /></span>
            <span className="row" style={{ justifyContent: "space-between" }}>
              <span><strong>Version {v.version}</strong> · {TERM_STATUS_LABELS[v.status]} · {person(v.created_by)}{v.note ? ` · ${v.note}` : ""}
                <span className="muted"> · {v.checks.filter((c) => c.house === "outside").length} outside house terms</span></span>
              {can("work_deals") && v.status !== "signed" && v.status !== "superseded" && (
                <span className="row" style={{ gap: 6 }}>
                  {v.status !== "negotiating" && <button className="btn small ghost" onClick={() => void set(v, "negotiating")}>Negotiating</button>}
                  <button className="btn small" onClick={() => void set(v, "signed")}>Mark signed</button>
                </span>
              )}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

const fmt = (n?: number) => (n === undefined ? "—" : `$${n >= 1e6 ? `${+(n / 1e6).toFixed(2)}M` : `${Math.round(n / 1e3)}K`}`);

function TermForm({ initial, dealId, onDone, onCancel }: { initial: TermSheetTerms; dealId: string; onDone: () => void; onCancel: () => void }) {
  const toast = useToast();
  const [t, setT] = useState<TermSheetTerms>(structuredClone({ ...BLANK, ...initial }));
  const [status, setStatus] = useState<TermSheetStatus>("proposed");
  const [note, setNote] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const up = (patch: Partial<TermSheetTerms>) => setT({ ...t, ...patch });
  const priced = t.security === "preferred";
  const bool = (key: keyof TermSheetTerms, label: string) => (
    <label className="check-row"><input type="checkbox" checked={Boolean(t[key])} onChange={(e) => up({ [key]: e.target.checked } as Partial<TermSheetTerms>)} /><span>{label}</span></label>
  );
  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ version: number }>(`/deals/${dealId}/term-sheets`, { body: { terms: t, status, note: note || undefined } });
      toast("good", `Saved as version ${r.version}.`);
      onDone();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="panel panel-pad section" aria-labelledby="tf-h" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <h2 id="tf-h">Term sheet</h2>
      <Seg label="Instrument" value={t.security} onChange={(security) => up({ security, seriesName: security === "preferred" ? t.seriesName : SECURITY_LABELS[security]! })}
        options={(["preferred", "safe_post", "safe_pre", "note"] as const).map((id) => ({ id, label: SECURITY_LABELS[id]! }))} />
      <Group title="The round">
        <div className="form-grid">
          <Field label="Series name" required><input className="input" required value={t.seriesName} onChange={(e) => up({ seriesName: e.target.value })} /></Field>
          {priced ? (
            <>
              <Field label="Pre-money valuation" required><MoneyInput id="tf-pre" value={t.preMoneyUsd} onChange={(v) => up({ preMoneyUsd: v })} /></Field>
              <Field label="Round size" required><MoneyInput id="tf-raise" value={t.raiseUsd} onChange={(v) => up({ raiseUsd: v })} /></Field>
              <Field label="Option pool after the round" hint="Created in the pre-money, as a share of the post-money."><NumberInput id="tf-pool" value={t.poolTopUpPostPct} onChange={(v) => up({ poolTopUpPostPct: v })} suffix="%" /></Field>
            </>
          ) : (
            <>
              <Field label="Valuation cap" hint={t.security === "safe_post" ? "Post-money cap." : "Pre-money cap."}><MoneyInput id="tf-cap" value={t.valuationCapUsd} onChange={(v) => up({ valuationCapUsd: v })} /></Field>
              <Field label="Discount"><NumberInput id="tf-disc" value={t.discountPct} onChange={(v) => up({ discountPct: v })} suffix="%" /></Field>
              <Field label="Total raise"><MoneyInput id="tf-raise" value={t.raiseUsd} onChange={(v) => up({ raiseUsd: v })} /></Field>
              {t.security === "note" && (
                <>
                  <Field label="Interest rate"><NumberInput id="tf-rate" value={t.noteRatePct} onChange={(v) => up({ noteRatePct: v })} suffix="%" /></Field>
                  <Field label="Maturity"><NumberInput id="tf-mat" value={t.noteMaturityMonths} onChange={(v) => up({ noteMaturityMonths: v })} suffix="months" /></Field>
                </>
              )}
            </>
          )}
          <Field label="Our allocation"><MoneyInput id="tf-ours" value={t.ourAllocationUsd} onChange={(v) => up({ ourAllocationUsd: v })} /></Field>
          <Field label="Lead investor"><input className="input" value={t.leadInvestor ?? ""} onChange={(e) => up({ leadInvestor: e.target.value || undefined })} /></Field>
        </div>
        {!priced && bool("mfn", "Most-favored-nation clause")}
      </Group>
      {priced && (
        <Group title="Economics of the preferred">
          <div className="form-grid">
            <Field label="Liquidation preference"><NumberInput id="tf-liq" value={t.liquidation.multiple} onChange={(v) => up({ liquidation: { ...t.liquidation, multiple: v ?? 1 } })} suffix="x" step="0.25" /></Field>
            <Field label="Participation">
              <Select id="tf-part" value={t.liquidation.participation} onChange={(v) => up({ liquidation: { ...t.liquidation, participation: v ?? "none" } })}
                options={[{ id: "none", label: "Non-participating" }, { id: "capped", label: "Participating, capped" }, { id: "full", label: "Fully participating" }]} />
            </Field>
            {t.liquidation.participation === "capped" && <Field label="Participation cap"><NumberInput id="tf-pcap" value={t.liquidation.capMultiple} onChange={(v) => up({ liquidation: { ...t.liquidation, capMultiple: v } })} suffix="x" /></Field>}
            <Field label="Seniority">
              <Select id="tf-sen" value={t.liquidation.seniority} onChange={(v) => up({ liquidation: { ...t.liquidation, seniority: v ?? "pari_passu" } })}
                options={[{ id: "pari_passu", label: "Pari passu with earlier preferred" }, { id: "senior", label: "Senior to earlier preferred" }, { id: "stacked", label: "Stacked" }]} />
            </Field>
            <Field label="Dividends">
              <Select id="tf-div" value={t.dividends.kind} onChange={(v) => up({ dividends: { ...t.dividends, kind: v ?? "non_cumulative" } })}
                options={[{ id: "non_cumulative", label: "Non-cumulative" }, { id: "cumulative", label: "Cumulative" }, { id: "none", label: "None" }]} />
            </Field>
            <Field label="Anti-dilution">
              <Select id="tf-ad" value={t.antiDilution} onChange={(v) => up({ antiDilution: v ?? "broad_wa" })}
                options={[{ id: "broad_wa", label: "Broad-based weighted average" }, { id: "narrow_wa", label: "Narrow-based weighted average" }, { id: "full_ratchet", label: "Full ratchet" }, { id: "none", label: "None" }]} />
            </Field>
            <Field label="Protective provisions">
              <Select id="tf-pp" value={t.protectiveProvisions} onChange={(v) => up({ protectiveProvisions: v ?? "standard" })}
                options={[{ id: "standard", label: "Standard (NVCA)" }, { id: "expanded", label: "Expanded" }, { id: "limited", label: "Limited" }]} />
            </Field>
          </div>
          {bool("redemption", "Redemption rights")}
          {bool("payToPlay", "Pay-to-play")}
          {bool("dragAlong", "Drag-along")}
          {bool("tranched", "Tranched (milestone-based closings)")}
        </Group>
      )}
      <Group title="Board and rights">
        <div className="form-grid">
          {priced && (
            <>
              <Field label="Board size"><NumberInput id="tf-bs" value={t.board.size} onChange={(v) => up({ board: { ...t.board, size: v } })} /></Field>
              <Field label="Investor seats"><NumberInput id="tf-bi" value={t.board.investorSeats} onChange={(v) => up({ board: { ...t.board, investorSeats: v } })} /></Field>
              <Field label="Common seats"><NumberInput id="tf-bc" value={t.board.commonSeats} onChange={(v) => up({ board: { ...t.board, commonSeats: v } })} /></Field>
              <Field label="Independent seats"><NumberInput id="tf-bind" value={t.board.independentSeats} onChange={(v) => up({ board: { ...t.board, independentSeats: v } })} /></Field>
            </>
          )}
          <Field label="Our board role">
            <Select id="tf-ours-board" value={t.board.ours} onChange={(v) => up({ board: { ...t.board, ours: v ?? "none" } })} options={[{ id: "seat", label: "Board seat" }, { id: "observer", label: "Observer" }, { id: "none", label: "None" }]} />
          </Field>
          <Field label="Pro rata rights">
            <Select id="tf-pr" value={t.proRata} onChange={(v) => up({ proRata: v ?? "major_investors" })} options={[{ id: "major_investors", label: "Major investors" }, { id: "all", label: "All investors" }, { id: "super", label: "Super pro rata" }, { id: "none", label: "None" }]} />
          </Field>
          <Field label="No-shop"><NumberInput id="tf-ns" value={t.noShopDays} onChange={(v) => up({ noShopDays: v })} suffix="days" /></Field>
          <Field label="Investor counsel fees cap"><MoneyInput id="tf-counsel" value={t.investorCounselCapUsd} onChange={(v) => up({ investorCounselCapUsd: v })} /></Field>
        </div>
        {bool("informationRights", "Information rights")}
        {bool("managementRightsLetter", "Management rights letter")}
      </Group>
      <Group title="Founders, tax and national security">
        <div className="form-grid">
          <Field label="Founder vesting"><NumberInput id="tf-vy" value={t.founderVesting.years} onChange={(v) => up({ founderVesting: { ...t.founderVesting, years: v ?? 0 } })} suffix="years" /></Field>
          <Field label="Cliff"><NumberInput id="tf-vc" value={t.founderVesting.cliffMonths} onChange={(v) => up({ founderVesting: { ...t.founderVesting, cliffMonths: v ?? 0 } })} suffix="months" /></Field>
          <Field label="Acceleration">
            <Select id="tf-acc" value={t.founderVesting.acceleration} onChange={(v) => up({ founderVesting: { ...t.founderVesting, acceleration: v ?? "double" } })} options={[{ id: "double", label: "Double trigger" }, { id: "single", label: "Single trigger" }, { id: "none", label: "None" }]} />
          </Field>
        </div>
        {bool("oispRepresentation", "Outbound investment (OISP) representations and covenants")}
        {bool("qsbsRepresentation", "QSBS representation (Section 1202)")}
      </Group>
      <Field label="Other terms" hint="Anything not captured above."><textarea className="input" value={t.otherTerms ?? ""} onChange={(e) => up({ otherTerms: e.target.value || undefined })} /></Field>
      <div className="form-grid">
        <Field label="Status">
          <Select id="tf-status" value={status} onChange={(v) => setStatus(v ?? "proposed")} options={(["draft", "proposed", "negotiating"] as const).map((id) => ({ id, label: TERM_STATUS_LABELS[id] }))} />
        </Field>
        <Field label="What changed" hint="E.g. 'Company's markup of 12 Sept'."><input className="input" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      </div>
      {err && <Notice tone="bad">{err}</Notice>}
      <div className="row">
        <button className="btn primary" disabled={busy} aria-busy={busy}>Save version</button>
        <button type="button" className="btn ghost" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}
