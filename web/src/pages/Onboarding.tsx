import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, ApiError, useApi } from "../api";
import { useSession } from "../app";
import { FundMath, Review, SECTIONS, errorsFrom, errorsIn, type Errors } from "../profile-form";
import type { Construction, Profile, ProfileCheck, ProfileResponse } from "../types";
import { ErrorState, Loading, Notice, usePageTitle, useToast } from "../ui";
import { SourcesSetup } from "./Connections";

const draftKey = (firmId: string) => `vcos:setup-draft:${firmId}`;

function loadDraft(firmId: string): { profile: Profile; step: number } | null {
  try {
    const raw = localStorage.getItem(draftKey(firmId));
    return raw ? (JSON.parse(raw) as { profile: Profile; step: number }) : null;
  } catch {
    return null;
  }
}

/** Live checks and portfolio math, debounced, from the server's validator and engine. */
export function useLiveCheck(p: Profile | null) {
  const [check, setCheck] = useState<ProfileCheck | null>(null);
  useEffect(() => {
    if (!p) return;
    const t = setTimeout(() => {
      api<ProfileCheck>("/profile/check", { body: p }).then(setCheck).catch(() => undefined);
    }, 350);
    return () => clearTimeout(t);
  }, [p]);
  return check;
}

/**
 * First-run setup: firm, fund, mandate, sectors, scoring, a review, then
 * sources. Answers are kept in this browser as you go, so leaving halfway
 * loses nothing; the profile is saved as a version at the review.
 */
export default function Onboarding() {
  const { me, reload } = useSession();
  const toast = useToast();
  const nav = useNavigate();
  const { data, error, reload: retry } = useApi<ProfileResponse>("/profile");
  const firmId = me.firm!.id;
  const [p, setP] = useState<Profile | null>(null);
  const [step, setStep] = useState(0);
  const [errors, setErrors] = useState<Errors>({});
  const [busy, setBusy] = useState(false);
  const [restored, setRestored] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const check = useLiveCheck(p);
  const construction: Construction | null = check?.construction ?? data?.construction ?? null;

  const REVIEW = SECTIONS.length;
  const SOURCES = SECTIONS.length + 1;
  const steps = [...SECTIONS.map((s) => s.label), "Review", "Sources"];
  const current = SECTIONS[step];
  usePageTitle(`Set up ${me.firm!.name}: ${steps[step]}`);

  useEffect(() => {
    if (!data?.current || p) return;
    const draft = loadDraft(firmId);
    if (draft) {
      setP(draft.profile);
      setStep(Math.min(draft.step, REVIEW));
      setRestored(true);
    } else setP({ ...data.current.profile, firm: { ...data.current.profile.firm, name: me.firm!.name } });
  }, [data, p, me.firm, firmId, REVIEW]);

  useEffect(() => {
    if (p && step <= REVIEW) {
      try {
        localStorage.setItem(draftKey(firmId), JSON.stringify({ profile: p, step }));
      } catch {
        // storage unavailable: the draft just isn't kept
      }
    }
  }, [p, step, firmId, REVIEW]);

  // Move focus to the step's heading so keyboard and screen-reader users land in the right place.
  useEffect(() => {
    heading.current?.focus();
    window.scrollTo(0, 0);
  }, [step]);

  if (error) return <div className="center-page"><ErrorState error={error} retry={() => void retry()} /></div>;
  if (!data || !p) return <div className="center-page"><Loading what="Loading your profile" /></div>;

  const go = (n: number) => {
    setErrors({});
    setStep(n);
  };

  const next = async () => {
    setBusy(true);
    try {
      const r = await api<ProfileCheck>("/profile/check", { body: p });
      const errs = errorsFrom(r.ok ? [] : r.errors);
      setErrors(errs);
      if (current && Object.keys(errorsIn(errs, current.paths)).length) return;
      go(step + 1);
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    setBusy(true);
    try {
      await api("/profile", { method: "PUT", body: p });
      try {
        localStorage.removeItem(draftKey(firmId));
      } catch {
        // nothing to clean up
      }
      toast("good", "Profile saved. Sourcing will score companies against it.");
      await reload();
      go(SOURCES);
    } catch (e) {
      const errs = errorsFrom((e as ApiError).errors);
      setErrors(errs);
      const first = SECTIONS.findIndex((sec) => Object.keys(errorsIn(errs, sec.paths)).length > 0);
      if (first >= 0) go(first);
      toast("bad", (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const discardDraft = () => {
    try {
      localStorage.removeItem(draftKey(firmId));
    } catch {
      // ignore
    }
    setP({ ...data.current!.profile, firm: { ...data.current!.profile.firm, name: me.firm!.name } });
    setRestored(false);
    go(0);
  };

  const title = step === REVIEW ? "Check everything before saving" : step === SOURCES ? "Where should we source from?" : current!.title;
  const lead = step === REVIEW ? "This becomes version 1 of your firm profile. You can change it any time under Firm settings; each save is kept."
    : step === SOURCES ? "Connect the tools you use, and add the websites of accelerators, studios, VCs and CVCs whose portfolios you want to follow. Each becomes a feed that runs on the schedule you pick."
    : current!.lead;
  const sectionErrors = current ? errorsIn(errors, current.paths) : {};

  return (
    <div className="center-page" style={{ placeItems: "start center" }}>
      <main className="section" style={{ width: "min(1180px, 100%)" }} id="main">
        <div className="eyebrow">Setting up {me.firm!.name}</div>
        <nav aria-label="Setup steps">
          <ol className="steps" style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {steps.map((label, i) => (
              <li key={label}>
                <button type="button" className={i === step ? "current" : i < step ? "done" : ""} aria-current={i === step ? "step" : undefined}
                  onClick={() => i < step && step !== SOURCES && go(i)} disabled={i > step || step === SOURCES}>
                  {label}
                </button>
              </li>
            ))}
          </ol>
        </nav>
        <header className="page-head">
          <div>
            <h1 ref={heading} tabIndex={-1}>{title}</h1>
            <p>{lead}</p>
          </div>
        </header>
        {restored && step < SOURCES && (
          <Notice>
            We restored the answers you'd entered before. <button type="button" className="btn ghost small" onClick={discardDraft}>Start over</button>
          </Notice>
        )}
        {Object.keys(sectionErrors).length > 0 && <Notice tone="bad">Some answers need another look. They're marked below.</Notice>}

        {step < REVIEW && current && (
          <div className={current.math ? "setup-grid" : ""}>
            <div className="panel panel-pad"><current.C p={p} set={setP} errors={errors} options={data.options} /></div>
            {current.math && <FundMath c={construction} currency={p.fund.currency} />}
          </div>
        )}
        {step === REVIEW && (
          <div className="setup-grid">
            <Review p={p} options={data.options} onEdit={go} />
            <FundMath c={construction} currency={p.fund.currency} />
          </div>
        )}
        {step === SOURCES && <SourcesSetup />}

        <div className="spread">
          {step === SOURCES ? <span /> : <button type="button" className="btn" disabled={step === 0} onClick={() => go(step - 1)}>Back</button>}
          {step < REVIEW && <button type="button" className="btn primary" aria-busy={busy} disabled={busy} onClick={() => void next()}>{busy ? "Checking…" : "Continue"}</button>}
          {step === REVIEW && <button type="button" className="btn primary" aria-busy={busy} disabled={busy} onClick={() => void save()}>{busy ? "Saving…" : "Save profile"}</button>}
          {step === SOURCES && <button type="button" className="btn primary" onClick={() => nav("/sourcing")}>Go to Sourcing</button>}
        </div>
      </main>
    </div>
  );
}
