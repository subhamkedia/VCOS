import { useState, type ReactNode } from "react";

export function PageHead({ eyebrow, title, lead, actions }: { eyebrow?: ReactNode; title: string; lead?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="page-head">
      <div>
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        <h1>{title}</h1>
        {lead && <p>{lead}</p>}
      </div>
      {actions && <div className="row">{actions}</div>}
    </header>
  );
}

export function Field({ label, hint, error, children }: { label: string; hint?: ReactNode; error?: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {error ? <span className="err">{error}</span> : hint ? <small>{hint}</small> : null}
    </label>
  );
}

/** A list of short strings: type and press Enter or comma. */
export function TagInput({ value, onChange, placeholder, id }: { value: string[]; onChange: (v: string[]) => void; placeholder?: string; id?: string }) {
  const [draft, setDraft] = useState("");
  const add = (raw: string) => {
    const parts = raw.split(",").map((s) => s.trim()).filter(Boolean).filter((s) => !value.includes(s));
    if (parts.length) onChange([...value, ...parts]);
    setDraft("");
  };
  return (
    <div className="tags">
      {value.map((t) => (
        <span className="tag" key={t}>
          {t}
          <button type="button" aria-label={`Remove ${t}`} onClick={() => onChange(value.filter((x) => x !== t))}>×</button>
        </span>
      ))}
      <input
        id={id}
        value={draft}
        placeholder={value.length ? "" : placeholder}
        onChange={(e) => (e.target.value.endsWith(",") ? add(e.target.value) : setDraft(e.target.value))}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            add(draft);
          } else if (e.key === "Backspace" && !draft && value.length) onChange(value.slice(0, -1));
        }}
        onBlur={() => draft && add(draft)}
      />
    </div>
  );
}

export function Chips<T extends string>({ options, value, onChange }: { options: { id: T; label: string }[]; value: T[]; onChange: (v: T[]) => void }) {
  return (
    <div className="chips">
      {options.map((o) => {
        const on = value.includes(o.id);
        return (
          <button type="button" key={o.id} className="chip" aria-pressed={on} onClick={() => onChange(on ? value.filter((v) => v !== o.id) : [...value, o.id])}>
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export function Seg<T extends string>({ options, value, onChange }: { options: { id: T; label: string }[]; value: T; onChange: (v: T) => void }) {
  return (
    <span className="seg" role="group">
      {options.map((o) => (
        <button type="button" key={o.id} aria-pressed={o.id === value} onClick={() => onChange(o.id)}>{o.label}</button>
      ))}
    </span>
  );
}

export function Notice({ tone = "info", children }: { tone?: "info" | "good" | "bad" | "warn"; children: ReactNode }) {
  return <div className={`notice ${tone === "info" ? "" : tone}`} role={tone === "bad" ? "alert" : "status"}>{children}</div>;
}

export function Loading({ what = "Loading" }: { what?: string }) {
  return <p className="muted">{what}…</p>;
}

export const usd = (n: number | undefined | null) =>
  n === undefined || n === null ? "—" : n >= 1e9 ? `$${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(n % 1e6 ? 1 : 0)}M` : n >= 1e3 ? `$${Math.round(n / 1e3)}K` : `$${n}`;

export const when = (s: string | null | undefined) => {
  if (!s) return "—";
  const d = new Date(s);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (Math.abs(diff) < 60) return "just now";
  const fmt = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  for (const [unit, sec] of [["day", 86400], ["hour", 3600], ["minute", 60]] as const) {
    if (Math.abs(diff) >= sec) return fmt.format(-Math.round(diff / sec), unit);
  }
  return d.toLocaleDateString();
};

export const dateOnly = (s: string | null | undefined) =>
  s ? new Date(s).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "—";

export function FitBadge({ score, verdict }: { score: number | null; verdict: string | null }) {
  if (score === null || verdict === null) return <span className="pill quiet">not scored</span>;
  const tone = verdict === "strong" ? "good" : verdict === "possible" ? "info" : verdict === "excluded" ? "bad" : "quiet";
  return (
    <span className="fitbar">
      <span className="track"><span className="fill" style={{ width: `${score}%` }} /></span>
      <span className={`pill ${tone}`}>{score} · {verdict}</span>
    </span>
  );
}
