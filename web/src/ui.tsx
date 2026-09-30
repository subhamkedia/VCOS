import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from "react";

// ---------------------------------------------------------------------------
// Page structure
// ---------------------------------------------------------------------------

/** Page header. Also sets the browser tab title, so history and tabs are readable. */
export function PageHead({ eyebrow, title, lead, actions }: { eyebrow?: ReactNode; title: string; lead?: ReactNode; actions?: ReactNode }) {
  usePageTitle(title);
  return (
    <header className="page-head">
      <div>
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        <h1 tabIndex={-1} id="page-title">{title}</h1>
        {lead && <p>{lead}</p>}
      </div>
      {actions && <div className="row">{actions}</div>}
    </header>
  );
}

export function usePageTitle(title: string) {
  useEffect(() => {
    document.title = `${title} · VC OS`;
  }, [title]);
}

/** A labelled group of related fields. */
export function Group({ title, hint, children }: { title: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <fieldset className="group">
      <legend>{title}</legend>
      {hint && <p className="muted small group-hint">{hint}</p>}
      {children}
    </fieldset>
  );
}

export function Field({ label, hint, error, required, children }: { label: string; hint?: ReactNode; error?: string; required?: boolean; children: ReactNode }) {
  return (
    <label className={`field ${error ? "has-error" : ""}`}>
      <span>
        {label}
        {required && <span className="req" aria-hidden="true"> *</span>}
        {required && <span className="sr-only"> (required)</span>}
      </span>
      {children}
      {error ? <span className="err" role="alert">{error}</span> : hint ? <small>{hint}</small> : null}
    </label>
  );
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** A list of short strings: type and press Enter or comma. `suggestions` are one click away. */
export function TagInput({ value, onChange, placeholder, id, suggestions }: { value: string[]; onChange: (v: string[]) => void; placeholder?: string; id?: string; suggestions?: string[] }) {
  const [draft, setDraft] = useState("");
  const add = (raw: string) => {
    const parts = raw.split(",").map((s) => s.trim()).filter(Boolean).filter((s) => !value.includes(s));
    if (parts.length) onChange([...value, ...parts]);
    setDraft("");
  };
  const open = (suggestions ?? []).filter((s) => !value.includes(s));
  return (
    <div className="section" style={{ gap: 6 }}>
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
      {open.length > 0 && (
        <div className="chips suggest" aria-label="Suggestions">
          {open.map((s) => <button type="button" key={s} className="chip ghost" onClick={() => onChange([...value, s])}>+ {s}</button>)}
        </div>
      )}
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

export function Seg<T extends string>({ options, value, onChange, label }: { options: { id: T; label: string }[]; value: T; onChange: (v: T) => void; label?: string }) {
  return (
    <span className="seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button type="button" key={o.id} aria-pressed={o.id === value} onClick={() => onChange(o.id)}>{o.label}</button>
      ))}
    </span>
  );
}

export function Select<T extends string>({ id, value, options, onChange, placeholder }: { id: string; value: T | undefined; options: { id: T; label: string }[]; onChange: (v: T | undefined) => void; placeholder?: string }) {
  return (
    <select className="input" id={id} value={value ?? ""} onChange={(e) => onChange((e.target.value || undefined) as T | undefined)}>
      <option value="">{placeholder ?? "Choose…"}</option>
      {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
    </select>
  );
}

const parseNum = (v: string) => (v.trim() === "" ? undefined : Number(v.replace(/,/g, "")));

/** A number field that stores `undefined` when empty. `suffix` shows the unit. */
export function NumberInput({ id, value, onChange, suffix, prefix, step, placeholder }: { id: string; value: number | undefined; onChange: (v: number | undefined) => void; suffix?: string; prefix?: string; step?: string; placeholder?: string }) {
  const [text, setText] = useState(value === undefined ? "" : String(value));
  useEffect(() => {
    if (parseNum(text) !== value) setText(value === undefined ? "" : String(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <span className="affix">
      {prefix && <span className="affix-part" aria-hidden="true">{prefix}</span>}
      <input className="input num" id={id} inputMode="decimal" step={step} placeholder={placeholder} value={text}
        onChange={(e) => {
          setText(e.target.value);
          const n = parseNum(e.target.value);
          if (n === undefined || Number.isFinite(n)) onChange(n);
        }} />
      {suffix && <span className="affix-part" aria-hidden="true">{suffix}</span>}
    </span>
  );
}

/** Money entered in millions ("12.5" = 12,500,000), shown with the fund's currency. */
export function MoneyInput({ id, value, onChange, currency = "USD" }: { id: string; value: number | undefined; onChange: (v: number | undefined) => void; currency?: string }) {
  return <NumberInput id={id} value={value === undefined ? undefined : value / 1e6} onChange={(m) => onChange(m === undefined ? undefined : Math.round(m * 1e6))} prefix={currencySymbol(currency)} suffix="M" />;
}

export const currencySymbol = (c = "USD") =>
  ({ USD: "$", EUR: "€", GBP: "£", CAD: "C$", INR: "₹", SGD: "S$", AUD: "A$", CHF: "CHF ", ILS: "₪", JPY: "¥" })[c] ?? `${c} `;

// ---------------------------------------------------------------------------
// Feedback
// ---------------------------------------------------------------------------

export function Notice({ tone = "info", children }: { tone?: "info" | "good" | "bad" | "warn"; children: ReactNode }) {
  return <div className={`notice ${tone === "info" ? "" : tone}`} role={tone === "bad" ? "alert" : "status"}>{children}</div>;
}

export function Loading({ what = "Loading" }: { what?: string }) {
  return <p className="muted" role="status" aria-live="polite">{what}…</p>;
}

/** What went wrong, and a way to try again. */
export function ErrorState({ error, retry }: { error: { message: string; status?: number }; retry?: () => void }) {
  const msg = error.status === 403 ? "Your role doesn't include this." : error.status === 404 ? "This doesn't exist, or belongs to another firm." : error.message;
  return (
    <div className="notice bad" role="alert">
      <div className="spread">
        <span>{msg}</span>
        {retry && <button type="button" className="btn small" onClick={retry}>Try again</button>}
      </div>
    </div>
  );
}

type Toast = { id: number; tone: "good" | "bad" | "info"; text: string };
const ToastCtx = createContext<(tone: Toast["tone"], text: string) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

/** Short confirmations after an action, announced to screen readers, gone after a few seconds. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((tone: Toast["tone"], text: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, tone, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === "bad" ? 8000 : 4000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" aria-live="polite" role="status">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.tone}`}>
            <span>{t.text}</span>
            <button type="button" aria-label="Dismiss" onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))}>×</button>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

interface ConfirmOptions {
  title: string;
  body: ReactNode;
  confirm: string;
  danger?: boolean;
}
const ConfirmCtx = createContext<(o: ConfirmOptions) => Promise<boolean>>(async () => false);
export const useConfirm = () => useContext(ConfirmCtx);

/** A real modal dialog (native <dialog>: focus is trapped, Escape cancels, focus returns). */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [opts, setOpts] = useState<ConfirmOptions | null>(null);
  const resolver = useRef<(v: boolean) => void>(() => {});
  const titleId = useId();
  const ask = useCallback((o: ConfirmOptions) => {
    setOpts(o);
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
      requestAnimationFrame(() => ref.current?.showModal());
    });
  }, []);
  const close = (v: boolean) => {
    ref.current?.close();
    resolver.current(v);
  };
  return (
    <ConfirmCtx.Provider value={ask}>
      {children}
      <dialog ref={ref} className="dialog" aria-labelledby={titleId} onCancel={() => resolver.current(false)}>
        {opts && (
          <form method="dialog" className="section" onSubmit={(e) => { e.preventDefault(); close(true); }}>
            <h2 id={titleId}>{opts.title}</h2>
            <div>{opts.body}</div>
            <div className="row" style={{ justifyContent: "flex-end" }}>
              <button type="button" className="btn" onClick={() => close(false)} autoFocus>Cancel</button>
              <button type="submit" className={`btn ${opts.danger ? "danger-solid" : "primary"}`}>{opts.confirm}</button>
            </div>
          </form>
        )}
      </dialog>
    </ConfirmCtx.Provider>
  );
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export const money = (n: number | undefined | null, currency = "USD") => {
  if (n === undefined || n === null) return "—";
  const s = currencySymbol(currency);
  const a = Math.abs(n);
  const v = a >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : a >= 1e6 ? `${(n / 1e6).toFixed(a % 1e6 ? 1 : 0)}M` : a >= 1e3 ? `${Math.round(n / 1e3)}K` : `${Math.round(n)}`;
  return `${s}${v}`;
};
export const usd = (n: number | undefined | null) => money(n, "USD");

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

/** A relative time with the exact time on hover and for assistive tech. */
/**
 * Who did something, as a person reads it: "pat@firm.vc" for a person,
 * "Diligence agent" for an agent (never "agent:diligence@0.1").
 */
export const actor = (a: string | null | undefined): string => {
  if (!a) return "—";
  if (a.startsWith("human:")) return a.slice(6);
  if (a.startsWith("agent:")) {
    const name = a.slice(6).split(/[@/:]/)[0]!.replace(/-/g, " ");
    return `${name.charAt(0).toUpperCase()}${name.slice(1)} agent`;
  }
  return a.replace(/^[a-z]+:/, "");
};

export function Time({ at }: { at: string | null | undefined }) {
  if (!at) return <span className="muted">—</span>;
  const d = new Date(at);
  return <time dateTime={d.toISOString()} title={d.toLocaleString()}>{when(at)}</time>;
}

export const dateOnly = (s: string | null | undefined) =>
  s ? new Date(s).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "—";

export function FitBadge({ score, verdict }: { score: number | null; verdict: string | null }) {
  if (score === null || verdict === null) return <span className="pill quiet">Not scored</span>;
  const tone = verdict === "strong" ? "good" : verdict === "possible" ? "info" : verdict === "excluded" ? "bad" : "quiet";
  const label = verdict.charAt(0).toUpperCase() + verdict.slice(1);
  return (
    <span className="fitbar" title={`Thesis fit ${score} out of 100`}>
      <span className="track" aria-hidden="true"><span className="fill" style={{ width: `${score}%` }} /></span>
      <span className={`pill ${tone}`}>{score} · {label}</span>
    </span>
  );
}

/**
 * WAI-ARIA tabs: arrow keys move between tabs, Home/End jump, only the
 * selected tab is in the tab order. Render the panel with `tabPanelProps`.
 */
export function Tabs<T extends string>({ tabs, value, onChange, label, idBase }: {
  tabs: { id: T; label: string; badge?: ReactNode }[]; value: T; onChange: (v: T) => void; label: string; idBase: string;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const move = (i: number) => {
    const n = (i + tabs.length) % tabs.length;
    onChange(tabs[n]!.id);
    refs.current[n]?.focus();
  };
  return (
    <div className="tabs" role="tablist" aria-label={label}>
      {tabs.map((t, i) => (
        <button
          key={t.id} ref={(el) => { refs.current[i] = el; }} type="button" role="tab" id={`${idBase}-tab-${t.id}`}
          aria-selected={t.id === value} aria-controls={`${idBase}-panel-${t.id}`} tabIndex={t.id === value ? 0 : -1}
          onClick={() => onChange(t.id)}
          onKeyDown={(e) => {
            if (e.key === "ArrowRight") { e.preventDefault(); move(i + 1); }
            else if (e.key === "ArrowLeft") { e.preventDefault(); move(i - 1); }
            else if (e.key === "Home") { e.preventDefault(); move(0); }
            else if (e.key === "End") { e.preventDefault(); move(tabs.length - 1); }
          }}
        >
          {t.label}{t.badge !== undefined && t.badge !== null && t.badge !== 0 && <span className="count">{t.badge}</span>}
        </button>
      ))}
    </div>
  );
}

export const tabPanelProps = (idBase: string, id: string) => ({ role: "tabpanel" as const, id: `${idBase}-panel-${id}`, "aria-labelledby": `${idBase}-tab-${id}`, tabIndex: 0 });

/** A small modal that asks for a line of text (a reason, an answer). Native <dialog>. */
export function usePrompt() {
  const confirm = useConfirm();
  return async (o: { title: string; label: string; confirm: string; initial?: string; required?: boolean; danger?: boolean; multiline?: boolean }): Promise<string | null> => {
    let value = o.initial ?? "";
    const ok = await confirm({
      title: o.title, confirm: o.confirm, danger: o.danger,
      body: (
        <label className="field">
          <span>{o.label}</span>
          {o.multiline
            ? <textarea className="input" defaultValue={value} required={o.required} onChange={(e) => { value = e.target.value; }} />
            : <input className="input" defaultValue={value} required={o.required} onChange={(e) => { value = e.target.value; }} />}
        </label>
      ),
    });
    if (!ok) return null;
    return value.trim();
  };
}
