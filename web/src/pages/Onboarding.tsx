import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, ApiError, useApi } from "../api";
import { useSession } from "../app";
import { SECTIONS, errorsFrom, errorsIn, type Errors } from "../profile-form";
import type { Profile, ProfileResponse } from "../types";
import { Loading, Notice } from "../ui";
import { SourcesSetup } from "./Connections";

/**
 * First-run setup: firm, fund, mandate, sectors, scoring, then sources.
 * Each step is checked by the server before moving on; the profile is saved
 * as a new version when the last profile step is done.
 */
export default function Onboarding() {
  const { me, reload } = useSession();
  const nav = useNavigate();
  const { data } = useApi<ProfileResponse>("/profile");
  const [p, setP] = useState<Profile | null>(null);
  const [step, setStep] = useState(0);
  const [errors, setErrors] = useState<Errors>({});
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (data?.current && !p) setP({ ...data.current.profile, firm: { ...data.current.profile.firm, name: me.firm!.name } });
  }, [data, p, me.firm]);

  if (!data || !p) return <div className="center-page"><Loading what="Loading your profile" /></div>;

  const steps = [...SECTIONS.map((s) => s.label), "Sources"];
  const onSources = step === SECTIONS.length;
  const section = SECTIONS[step];
  const Section = section?.C ?? (() => null);

  const next = async () => {
    setBusy(true);
    try {
      const r = await api<{ ok: boolean; errors?: { path: string; message: string }[] }>("/profile/check", { body: p });
      const errs = errorsFrom(r.ok ? [] : r.errors);
      setErrors(errs);
      if (Object.keys(errorsIn(errs, section!.paths)).length) return;
      if (step === SECTIONS.length - 1) {
        if (!r.ok) {
          setStep(Math.max(0, SECTIONS.findIndex((sec) => Object.keys(errorsIn(errs, sec.paths)).length > 0)));
          return;
        }
        await api("/profile", { method: "PUT", body: p });
        setSaved(true);
        await reload();
      }
      setStep(step + 1);
      window.scrollTo(0, 0);
    } catch (e) {
      setErrors(errorsFrom((e as ApiError).errors));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="center-page" style={{ placeItems: "start center" }}>
      <div style={{ width: "min(880px, 100%)" }} className="section">
        <div className="eyebrow">Setting up {me.firm!.name}</div>
        <nav className="steps" aria-label="Setup steps">
          {steps.map((label, i) => (
            <button key={label} type="button" className={i === step ? "current" : i < step ? "done" : ""} onClick={() => i < step && setStep(i)} disabled={i > step}>
              {label}
            </button>
          ))}
        </nav>
        {onSources ? (
          <>
            <header className="page-head">
              <div>
                <h1>Where should we source from?</h1>
                <p>Connect the tools you use, then add a feed for each source you want checked on a schedule. You can change all of this later under Connections and Sourcing.</p>
              </div>
            </header>
            {saved && <Notice tone="good">Profile saved. Sourcing will score companies against it.</Notice>}
            <SourcesSetup />
            <div className="spread">
              <button type="button" className="btn" onClick={() => setStep(step - 1)}>Back</button>
              <button type="button" className="btn primary" onClick={() => nav("/sourcing")}>Go to Sourcing</button>
            </div>
          </>
        ) : (
          <>
            <header className="page-head">
              <div>
                <h1>{section!.title}</h1>
                <p>{section!.lead}</p>
              </div>
            </header>
            {Object.keys(errorsIn(errors, section!.paths)).length > 0 && <Notice tone="bad">Some answers need another look. They're marked below.</Notice>}
            <div className="panel panel-pad">
              <Section p={p} set={setP} errors={errors} options={data.options} />
            </div>
            <div className="spread">
              <button type="button" className="btn" disabled={step === 0} onClick={() => setStep(step - 1)}>Back</button>
              <button type="button" className="btn primary" disabled={busy} onClick={() => void next()}>
                {step === SECTIONS.length - 1 ? (busy ? "Saving…" : "Save profile") : "Continue"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
