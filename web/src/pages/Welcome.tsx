import { useState } from "react";
import { api } from "../api";
import { useSession } from "../app";
import { Field, Notice, usePageTitle } from "../ui";

/** Signed in, but not in any firm yet: create one (or wait for an invitation). */
export default function Welcome() {
  const { me, reload } = useSession();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  usePageTitle("Set up your firm");

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api("/firms", { body: { name } });
      await reload();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="center-page">
      <form className="auth-card" onSubmit={create}>
        <div>
          <div className="eyebrow">Welcome, {me.user.name ?? me.user.email}</div>
          <h1>Set up your firm</h1>
          <p className="muted">
            Create a workspace for your firm. Next you'll describe your fund and mandate, then connect the tools you
            source from. If a colleague already set up your firm, ask them to invite {me.user.email}.
          </p>
        </div>
        {error && <Notice tone="bad">{error}</Notice>}
        <Field label="Firm name">
          <input className="input" required value={name} onChange={(e) => setName(e.target.value)} placeholder="Alpha Ventures" id="firm-name" />
        </Field>
        <button className="btn primary" disabled={busy || !name.trim()}>{busy ? "Creating…" : "Create workspace"}</button>
      </form>
    </div>
  );
}
