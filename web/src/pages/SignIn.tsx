import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api, useApi } from "../api";
import { Field, Notice, usePageTitle } from "../ui";

export default function SignIn() {
  const [params] = useSearchParams();
  const { data: providers } = useApi<{ google: boolean; microsoft: boolean }>("/auth/providers");
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState(params.get("error"));
  const [busy, setBusy] = useState(false);
  usePageTitle("Sign in");

  const sendLink = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api("/auth/email", { body: { email } });
      setSent(true);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="center-page">
      <div className="auth-card">
        <div>
          <div className="eyebrow">VC OS</div>
          <h1>Sign in</h1>
          <p className="muted">The operating system for your fund: sourcing and diligence, the deal, the portfolio and its exits, your investors and compliance, in one place.</p>
        </div>
        {error && <Notice tone="bad">{error}</Notice>}
        <div className="section">
          {providers?.google && <a className="btn" href="/api/auth/google/start">Continue with Google</a>}
          {providers?.microsoft && <a className="btn" href="/api/auth/microsoft/start">Continue with Microsoft</a>}
        </div>
        {sent ? (
          <Notice tone="good">Check {email} for a sign-in link. It works once, for 15 minutes.</Notice>
        ) : (
          <form className="section panel panel-pad" onSubmit={sendLink}>
            <Field label="Work email" hint="We'll email you a one-time sign-in link.">
              <input className="input" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" id="signin-email" />
            </Field>
            <button className="btn primary" disabled={busy}>{busy ? "Sending…" : "Email me a link"}</button>
          </form>
        )}
      </div>
    </div>
  );
}
