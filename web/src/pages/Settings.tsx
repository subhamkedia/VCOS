import { useEffect, useState } from "react";
import { NavLink, Navigate, Route, Routes } from "react-router-dom";
import { api, ApiError, useApi } from "../api";
import { ROLE_LABELS, useSession } from "../app";
import { FundMath, SECTIONS, TERMS_SECTION, errorsFrom, type Errors } from "../profile-form";

const ALL = [...SECTIONS, TERMS_SECTION];
import type { Profile, ProfileResponse, Role } from "../types";
import { ErrorState, Field, Loading, Notice, PageHead, Time, useConfirm, useToast } from "../ui";
import { useLiveCheck } from "./Onboarding";

export default function Settings() {
  const tab = (to: string, label: string) => <NavLink to={to} className={({ isActive }) => `btn small ${isActive ? "primary" : ""}`}>{label}</NavLink>;
  return (
    <>
      <PageHead eyebrow="Workspace" title="Firm settings" lead="Your fund, mandate and thesis drive sourcing and scoring. Every save is kept as a version, so each score records the thesis it was measured against." />
      <nav className="row" aria-label="Settings sections">
        {ALL.map((s) => <span key={s.id}>{tab(`/settings/${s.id}`, s.label)}</span>)}
        {tab("/settings/team", "Team")}
        {tab("/settings/history", "History")}
      </nav>
      <Routes>
        <Route index element={<Navigate to="firm" replace />} />
        {ALL.map((s) => <Route key={s.id} path={s.id} element={<ProfileTab section={s.id} />} />)}
        <Route path="team" element={<Team />} />
        <Route path="history" element={<History />} />
      </Routes>
    </>
  );
}

function ProfileTab({ section }: { section: string }) {
  const { can, reload: reloadSession } = useSession();
  const toast = useToast();
  const { data, error, reload } = useApi<ProfileResponse>("/profile");
  const [p, setP] = useState<Profile | null>(null);
  const [errors, setErrors] = useState<Errors>({});
  const [busy, setBusy] = useState(false);
  const check = useLiveCheck(p);
  useEffect(() => {
    if (data?.current) setP(data.current.profile);
  }, [data]);
  const dirty = Boolean(p && data?.current && JSON.stringify(p) !== JSON.stringify(data.current.profile));
  // Warn before leaving the page with unsaved changes.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  if (error) return <ErrorState error={error} retry={() => void reload()} />;
  if (!data || !p) return <Loading />;
  const s = ALL.find((x) => x.id === section)!;
  const save = async () => {
    setBusy(true);
    try {
      const r = await api<{ version: number }>("/profile", { method: "PUT", body: p });
      setErrors({});
      toast("good", `Saved as version ${r.version}.`);
      await reload();
      await reloadSession();
    } catch (e) {
      setErrors(errorsFrom((e as ApiError).errors));
      toast("bad", "Not saved. Check the fields marked below.");
    } finally {
      setBusy(false);
    }
  };
  const editable = can("edit_thesis");
  return (
    <div className="section">
      <div>
        <h2>{s.title}</h2>
        <p className="muted small" style={{ margin: "4px 0 0" }}>{s.lead} Current version: {data.current?.version}.</p>
      </div>
      {!editable && <Notice>Partners and admins can edit the profile. You can see it.</Notice>}
      <div className={s.math ? "setup-grid" : ""}>
        <fieldset disabled={!editable} style={{ margin: 0, minWidth: 0 }} className="panel panel-pad">
          <s.C p={p} set={setP} errors={errors} options={data.options} />
        </fieldset>
        {s.math && <FundMath c={check?.construction ?? data.construction} currency={p.fund.currency} />}
      </div>
      {editable && (
        <div className="save-bar row" role="region" aria-label="Save changes">
          <button className="btn primary" disabled={busy || !dirty} aria-busy={busy} onClick={() => void save()}>{busy ? "Saving…" : "Save changes"}</button>
          {dirty && <button className="btn ghost" onClick={() => { setP(data.current!.profile); setErrors({}); }}>Discard changes</button>}
          <span className="muted small">{dirty ? "You have unsaved changes." : "All changes saved."}</span>
        </div>
      )}
    </div>
  );
}

function Team() {
  const { me, can } = useSession();
  const toast = useToast();
  const confirm = useConfirm();
  const { data, error, reload } = useApi<{ members: { user_id: string; email: string; name: string | null; role: Role }[]; invited: { id: string; email: string; role: Role }[]; roles: Role[] }>("/team");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("analyst");
  const [busy, setBusy] = useState(false);
  if (error) return <ErrorState error={error} retry={() => void reload()} />;
  if (!data) return <Loading />;
  const invite = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api("/team/invite", { body: { email, role } });
      toast("good", `Invited ${email}. They join when they sign in with that address.`);
      setEmail("");
      void reload();
    } catch (x) {
      toast("bad", (x as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const remove = async (m: { user_id: string; email: string; name: string | null }) => {
    const ok = await confirm({ title: `Remove ${m.name ?? m.email}?`, body: "They lose access to this firm's workspace right away. Their past actions stay in the audit log.", confirm: "Remove", danger: true });
    if (!ok) return;
    try {
      await api(`/team/${m.user_id}`, { method: "DELETE" });
      toast("good", `Removed ${m.email}.`);
      void reload();
    } catch (x) {
      toast("bad", (x as Error).message);
    }
  };
  return (
    <div className="section">
      <h2>Team</h2>
      <p className="muted small" style={{ margin: 0 }}>Admins manage the team and firm. Partners edit the thesis, connect sources, run feeds and approve outbound items. Analysts read, upload and queue drafts.</p>
      <div className="panel table-wrap">
        <table className="t">
          <caption className="sr-only">Team members and invitations</caption>
          <thead><tr><th scope="col">Person</th><th scope="col">Role</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
          <tbody>
            {data.members.map((m) => (
              <tr key={m.user_id}>
                <td>{m.name ?? m.email}{m.user_id === me.user.id && <span className="muted"> (you)</span>}<div className="small muted">{m.email}</div></td>
                <td><span className="pill outline">{ROLE_LABELS[m.role]}</span></td>
                <td>{can("manage_team") && m.user_id !== me.user.id && <button className="btn ghost small danger" onClick={() => void remove(m)}>Remove</button>}</td>
              </tr>
            ))}
            {data.invited.map((i) => (
              <tr key={i.id}><td>{i.email}<div className="small muted">Invited; hasn't signed in yet</div></td><td><span className="pill quiet">{ROLE_LABELS[i.role]}</span></td><td /></tr>
            ))}
          </tbody>
        </table>
      </div>
      {can("manage_team") && (
        <form className="panel panel-pad row" onSubmit={invite} style={{ alignItems: "flex-end" }}>
          <Field label="Invite by email"><input className="input" id="invite-email" type="email" required autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="colleague@yourfirm.com" /></Field>
          <Field label="Role">
            <select className="input" id="invite-role" value={role} onChange={(e) => setRole(e.target.value as Role)}>
              {data.roles.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
            </select>
          </Field>
          <button className="btn primary" disabled={busy} aria-busy={busy}>Send invitation</button>
        </form>
      )}
    </div>
  );
}

function History() {
  const { data, error, reload } = useApi<{ version: number; created_by: string; created_at: string }[]>("/profile/history");
  if (error) return <ErrorState error={error} retry={() => void reload()} />;
  if (!data) return <Loading />;
  return (
    <div className="section">
      <h2>Profile history</h2>
      <p className="muted small" style={{ margin: 0 }}>Every save is a version. Sourcing scores record which version they used.</p>
      <div className="panel table-wrap">
        <table className="t">
          <caption className="sr-only">Profile versions</caption>
          <thead><tr><th scope="col">Version</th><th scope="col">Saved by</th><th scope="col">When</th></tr></thead>
          <tbody>{data.map((h) => <tr key={h.version}><td className="num">v{h.version}</td><td>{h.created_by.replace(/^human:/, "")}</td><td className="small muted"><Time at={h.created_at} /></td></tr>)}</tbody>
        </table>
      </div>
    </div>
  );
}
