import type { Letter, NetReturns, Performance, StatementColumn } from "../../types";
import { usd } from "../../ui";

export const x2 = (n: number | null | undefined) => (n === null || n === undefined ? "—" : `${n.toFixed(2)}x`);
export const irr = (n: number | null | undefined) => (n === null || n === undefined ? "—" : `${(n * 100).toFixed(1)}%`);
export const person = (a: string | null | undefined) => (a ?? "").replace(/^human:/, "");
export const longDate = (d: string | null | undefined) =>
  d ? new Date(`${d.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) : "—";
export const quarterLabel = (p: string) => p.replace("-", " ");
/** Negative amounts in parentheses, the way statements show them. */
export const acct = (n: number) => (Math.abs(n) < 0.005 ? "—" : n < 0 ? `(${usd(-n)})` : usd(n));

export const STATUS_TONE: Record<string, string> = { draft: "info", approved: "good", paid: "good", cancelled: "quiet", withdrawn: "quiet", pending: "warn", delivered: "good" };

const LINES: [keyof StatementColumn, string, 1 | -1][] = [
  ["beginning", "Beginning balance", 1], ["contributions", "Capital contributions", 1], ["distributions", "Distributions", -1],
  ["managementFees", "Management fees, net of offsets", -1], ["expenses", "Partnership expenses", -1], ["realizedGain", "Realized gain (loss)", 1],
  ["unrealizedGain", "Change in unrealized gain (loss)", 1], ["carriedInterest", "Carried interest allocated", -1], ["ending", "Ending balance", 1],
];

/** A capital account statement in the ILPA template's order: quarter, year to date, inception to date. */
export function StatementTable({ caption, s }: { caption: string; s: { quarter: StatementColumn; year: StatementColumn; inception: StatementColumn; commitment: number; unfunded: number; contributedToDate: number } }) {
  return (
    <div className="table-wrap">
      <table className="t">
        <caption className="sr-only">{caption}</caption>
        <thead><tr><th scope="col">Line</th><th scope="col" className="num">Quarter</th><th scope="col" className="num">Year to date</th><th scope="col" className="num">Inception to date</th></tr></thead>
        <tbody>
          {LINES.map(([k, label, sign]) => (
            <tr key={k} className={k === "ending" ? "total" : undefined}>
              <th scope="row">{label}</th>
              <td className="num">{acct(sign * s.quarter[k])}</td><td className="num">{acct(sign * s.year[k])}</td><td className="num">{acct(sign * s.inception[k])}</td>
            </tr>
          ))}
          <tr><th scope="row">Commitment</th><td /><td /><td className="num">{usd(s.commitment)}</td></tr>
          <tr><th scope="row">Contributed to date</th><td /><td /><td className="num">{usd(s.contributedToDate)}</td></tr>
          <tr><th scope="row">Unfunded commitment</th><td /><td /><td className="num">{usd(s.unfunded)}</td></tr>
        </tbody>
      </table>
    </div>
  );
}

/** Net returns to investors beside gross returns on the portfolio, with equal prominence (the Marketing Rule's standard). */
export function NetAndGross({ net, gross, note }: { net: NetReturns & { basis?: string }; gross: Performance["gross"]; note: string }) {
  return (
    <>
      <div className="grid-2">
        <div className="section" style={{ gap: 8 }}>
          <h3>Net to investors</h3>
          <div className="stats">
            <div className="stat"><b className="num">{irr(net.irr)}</b><span>Net IRR</span></div>
            <div className="stat"><b className="num">{x2(net.tvpi)}</b><span>Net TVPI</span></div>
            <div className="stat"><b className="num">{x2(net.dpi)}</b><span>DPI</span></div>
            <div className="stat"><b className="num">{x2(net.rvpi)}</b><span>RVPI</span></div>
          </div>
          {net.basis && <p className="small muted" style={{ margin: 0 }}>{net.basis}</p>}
        </div>
        <div className="section" style={{ gap: 8 }}>
          <h3>Gross, on the portfolio</h3>
          <div className="stats">
            <div className="stat"><b className="num">{irr(gross.irr)}</b><span>Gross IRR</span></div>
            <div className="stat"><b className="num">{x2(gross.moic)}</b><span>Gross multiple</span></div>
            <div className="stat"><b className="num">{usd(gross.invested)}</b><span>Invested</span></div>
            <div className="stat"><b className="num">{usd(gross.realized + gross.unrealized)}</b><span>Total value</span></div>
          </div>
          <p className="small muted" style={{ margin: 0 }}>{gross.basis}</p>
        </div>
      </div>
      <p className="small" style={{ margin: 0 }}>{note}</p>
    </>
  );
}

/** The letter: each factual sentence with its sources; the GP's commentary labeled as opinion. */
export function LetterView({ letter }: { letter: Letter }) {
  const n = new Map<string, number>();
  for (const s of letter.sections) for (const x of s.sentences) for (const c of x.cites) if (!n.has(c)) n.set(c, n.size + 1);
  return (
    <article className="section letter">
      {letter.sections.map((s) => (
        <section key={s.id} className="section" style={{ gap: 6 }} aria-labelledby={`l-${s.id}`}>
          <h3 id={`l-${s.id}`}>{s.heading}{s.id === "commentary" && <span className="pill outline" style={{ marginLeft: 8 }}>Opinion</span>}</h3>
          <p style={{ margin: 0 }}>
            {s.sentences.map((x, i) => (
              <span key={i}>
                {x.text}
                {x.cites.map((c) => <sup key={c}><a href={`#src-${n.get(c)}`} aria-label={`Source ${n.get(c)}: ${letter.sources[c]?.label ?? ""}`}>[{n.get(c)}]</a></sup>)}{" "}
              </span>
            ))}
          </p>
        </section>
      ))}
      {n.size > 0 && (
        <section aria-labelledby="l-src" className="section" style={{ gap: 4 }}>
          <h3 id="l-src">Sources</h3>
          <ol className="small" style={{ margin: 0, paddingLeft: 18 }}>
            {[...n.entries()].map(([id, k]) => <li key={id} id={`src-${k}`}>{letter.sources[id]?.label ?? "Source"}: <span className="muted">{letter.sources[id]?.detail}</span></li>)}
          </ol>
        </section>
      )}
    </article>
  );
}
