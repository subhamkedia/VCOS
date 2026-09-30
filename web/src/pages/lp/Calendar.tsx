import { useState } from "react";
import { api } from "../../api";
import { useSession } from "../../app";
import type { TaxDoc } from "../../types";
import { Notice, useToast } from "../../ui";
import type { LpTabProps } from "../LpFund";
import { STATUS_TONE, longDate } from "./shared";

const STATE: Record<string, { tone: string; label: string }> = {
  done: { tone: "good", label: "Done" }, overdue: { tone: "bad", label: "Overdue" }, upcoming: { tone: "outline", label: "Upcoming" }, past: { tone: "quiet", label: "Past" },
};

/**
 * The reporting calendar (quarterly reports, audited financials, Schedules
 * K-1, the annual Form ADV amendment) and K-1 delivery by investor. The tax
 * documents themselves come from the fund's tax preparer; this tracks who
 * has received theirs.
 */
export default function Calendar({ data, onChange }: LpTabProps) {
  const { can } = useSession();
  const toast = useToast();
  const lastYear = Number(data.asOf.slice(0, 4)) - 1;
  const [year, setYear] = useState(lastYear);
  const lps = data.investors.filter((i) => i.kind !== "gp");
  const doc = (partnerId: string, kind: TaxDoc["kind"]) => data.taxDocuments.find((t) => t.partner_id === partnerId && t.tax_year === year && t.kind === kind);
  const mark = async (partnerId: string, kind: TaxDoc["kind"], status: TaxDoc["status"]) => {
    try {
      await api(`/lp/funds/${data.fund.id}/tax-documents`, { body: { partnerId, taxYear: year, kind, status } });
      toast("good", status === "delivered" ? "Marked delivered." : "Marked pending.");
      onChange();
    } catch (e) {
      toast("bad", (e as Error).message);
    }
  };
  return (
    <>
      <section className="panel panel-pad section" aria-labelledby="cal-h">
        <h2 id="cal-h">Deadlines</h2>
        <ul className="timeline small">
          {data.calendar.map((d) => (
            <li key={d.key}>
              <span>{longDate(d.due)}</span>
              <span>
                <strong>{d.title}</strong> <span className={`pill ${STATE[d.state]!.tone}`}>{STATE[d.state]!.label}</span>{d.progress ? <span className="muted"> · {d.progress}</span> : null}
                <br /><span className="muted">{d.basis}</span>
              </span>
            </li>
          ))}
        </ul>
        <p className="small muted" style={{ margin: 0 }}>For a December year end. Check your LPA: many set their own reporting deadlines, and the audit and Form ADV apply to registered and exempt reporting advisers as the rules say.</p>
      </section>
      <section className="panel panel-pad section" aria-labelledby="k1-h">
        <div className="spread">
          <h2 id="k1-h">Tax documents for {year}</h2>
          <div className="row">
            <button className="btn small ghost" onClick={() => setYear(year - 1)} aria-label="Previous tax year">← {year - 1}</button>
            {year < lastYear + 1 && <button className="btn small ghost" onClick={() => setYear(year + 1)} aria-label="Next tax year">{year + 1} →</button>}
          </div>
        </div>
        {lps.length === 0 ? <Notice>No investors yet.</Notice> : (
          <div className="table-wrap">
            <table className="t">
              <caption className="sr-only">Tax documents by investor for {year}</caption>
              <thead><tr><th scope="col">Investor</th><th scope="col">Tax status</th><th scope="col">{data.labels.taxDocKinds.k1}</th><th scope="col">{data.labels.taxDocKinds.k3}</th></tr></thead>
              <tbody>
                {lps.map((p) => (
                  <tr key={p.id}>
                    <th scope="row">{p.name}</th>
                    <td className="small">{p.tax_status ? data.labels.taxStatus[p.tax_status] : <span className="muted">Not recorded</span>}</td>
                    {(["k1", "k3"] as const).map((k) => {
                      const d = doc(p.id, k);
                      return (
                        <td key={k}>
                          <div className="row">
                            <span className={`pill ${d ? STATUS_TONE[d.status] : "outline"}`}>{d ? `${data.labels.taxDocStatus[d.status]}${d.delivered_on ? ` ${longDate(d.delivered_on)}` : ""}` : "Not tracked"}</span>
                            {can("work_deals") && (d?.status === "delivered"
                              ? <button className="btn small ghost" onClick={() => void mark(p.id, k, "pending")}>Undo</button>
                              : <button className="btn small ghost" onClick={() => void mark(p.id, k, "delivered")}>Mark delivered</button>)}
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="small muted" style={{ margin: 0 }}>Schedule K-1 is due March 15 (September 15 with a Form 7004 extension). Schedule K-3 reports international tax items where they apply.</p>
      </section>
    </>
  );
}
