import type { Health, KpiPoint, Severity, Signal } from "../../types";

export const HEALTH_TONE: Record<Health, string> = { on_track: "good", watch: "warn", at_risk: "bad" };
export const SEVERITY_TONE: Record<Severity, string> = { high: "bad", medium: "warn", low: "quiet" };
export const SEVERITY_LABEL: Record<Severity, string> = { high: "Act now", medium: "Watch", low: "Note" };
export const SOURCE_LABEL: Record<string, string> = {
  primary: "From the books", self_reported: "Company-reported", internal: "Our records", third_party: "Third party", inference: "Model inference",
};

export const x2 = (n: number | null | undefined) => (n === null || n === undefined ? "—" : `${n.toFixed(2)}x`);
export const pctFmt = (n: number | null | undefined, digits = 1) => (n === null || n === undefined ? "—" : `${n > 0 ? "+" : ""}${n.toFixed(digits)}%`);
export const months = (n: number | null | undefined) => (n === null || n === undefined ? "—" : `${n.toFixed(1)} mo`);
export const monthLabel = (m: string) => new Date(`${m}-15T00:00:00Z`).toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
export { actor as person } from "../../ui";

export function HealthPill({ rating, suggested, labels }: { rating: Health | null | undefined; suggested: Health; labels: Record<Health, string> }) {
  if (rating) return <span className={`pill ${HEALTH_TONE[rating]}`}>{labels[rating]}</span>;
  return <span className={`pill outline`} title="No one has rated this company yet; this is what the signals suggest.">Suggested: {labels[suggested]}</span>;
}

export function SignalList({ signals, empty = "No warnings." }: { signals: (Pick<Signal, "key" | "severity" | "title"> & { detail?: string })[]; empty?: string }) {
  if (!signals.length) return <p className="small muted" style={{ margin: 0 }}>{empty}</p>;
  return (
    <ul className="signals">
      {signals.map((s) => (
        <li key={s.key}>
          <span className={`pill ${SEVERITY_TONE[s.severity]}`}>{SEVERITY_LABEL[s.severity]}</span>
          <span><strong>{s.title}</strong>{s.detail ? <span className="muted"> · {s.detail}</span> : null}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * One metric by month as bars: a single series, so the title names it and
 * there's no legend. Each bar has a tooltip (and the month table next to it
 * is the accessible view). Bars are thin, anchored to the baseline with a
 * gap between them; only the latest value is labeled.
 */
export function KpiBars({ title, points, format, planned }: { title: string; points: KpiPoint[]; format: (n: number) => string; planned?: KpiPoint[] }) {
  const last12 = points.slice(-12);
  if (!last12.length) return null;
  const plan = new Map((planned ?? []).map((p) => [p.month, p.value]));
  const max = Math.max(...last12.map((p) => p.value), ...last12.map((p) => plan.get(p.month) ?? 0), 1);
  const W = 240;
  const H = 72;
  const gap = 2;
  const bw = Math.max(4, (W - gap * (last12.length - 1)) / last12.length);
  const latest = last12[last12.length - 1]!;
  return (
    <figure className="kpi-chart">
      <figcaption>
        <span className="small muted">{title}</span>
        <strong className="num">{format(latest.value)}</strong>
        <span className="small muted">{monthLabel(latest.month)}</span>
      </figcaption>
      <svg viewBox={`0 0 ${W} ${H + 14}`} role="img" aria-label={`${title} by month, latest ${format(latest.value)} in ${monthLabel(latest.month)}`} preserveAspectRatio="none">
        <line x1={0} y1={H} x2={W} y2={H} className="axis" />
        {last12.map((p, i) => {
          const h = Math.max(1, (p.value / max) * (H - 4));
          const x = i * (bw + gap);
          const pl = plan.get(p.month);
          return (
            <g key={p.month} className="bar-g">
              <rect x={x} y={0} width={bw} height={H} className="hit"><title>{`${monthLabel(p.month)}: ${format(p.value)}${pl !== undefined ? ` (plan ${format(pl)})` : ""}`}</title></rect>
              <path className="bar" d={`M${x},${H} V${H - h + Math.min(2, h)} q0,-2 2,-2 h${bw - 4} q2,0 2,2 V${H} Z`} />
              {pl !== undefined && <line x1={x} x2={x + bw} y1={H - (pl / max) * (H - 4)} y2={H - (pl / max) * (H - 4)} className="plan" />}
            </g>
          );
        })}
        <text x={0} y={H + 12} className="tick">{monthLabel(last12[0]!.month)}</text>
        <text x={W} y={H + 12} className="tick" textAnchor="end">{monthLabel(latest.month)}</text>
      </svg>
      {planned?.length ? <span className="small muted"><span className="plan-key" aria-hidden="true" /> Plan</span> : null}
    </figure>
  );
}
