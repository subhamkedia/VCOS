import { useEffect, useState } from "react";
import { NavLink, Navigate, Route, Routes } from "react-router-dom";
import { api, ApiError, useApi } from "../api";
import { useSession } from "../app";
import { SECTIONS, errorsFrom, type Errors } from "../profile-form";
import type { Profile, ProfileResponse, Role } from "../types";
import { Field, Loading, Notice, PageHead, when } from "../ui";

export default function Settings() {
  return (
    <>
      <PageHead eyebrow="Workspace" title="Firm settings" lead="Your fund, mandate and thesis drive sourcing and scoring. Every save is kept as a version, so each score records the thesis it was measured against." />
      <nav className="row" aria-label="Settings sections">
        {SECTIONS.map((s) => <NavLink key={s.id} to={`/settings/${s.id}`} className={({ isActive }) => `btn small ${isActive ? "primary" : ""}`}>{s.label}</NavLink>)}
        <NavLink to="/settings/team" className={({ isActive }) => `btn small ${isActive ? "primary" : ""}`}>Team</NavLink>
        <NavLink to="/settings/history" className={({ isActive }) => `btn small ${isActive ? "primary" : ""}`}>History</NavLink>
      </nav>
      <Routes>
        <Route index element={<Navigate to="firm" replace />} />
        {SECTIONS.map((s) => <Route key={s.id} path={s.id} element={<ProfileTab section={s.id} />} />)}
        <Route path="team" element={<Team />} />
        <Route path="history" element={<History />} />
      </Routes>
    </>
  );
}

function ProfileTab({ section }: { section: string }) {
  const { can, reload: reloadSession } = useSession();
  const { data, reload } = useApi<ProfileResponse>("/profile");
  const [p, setP] = useState<Profile | null>(null);
  const [errors, setErrors] = useState<Errors>({});
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (data?.current) setP(data.current.profile);
  }, [data]);
  if (!data || !p) return <Loading />;
  const s = SECTIONS.find((x) => x.id === section)!;
  const save = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api<{ version: number }>("/profile", { method: "PUT", body: p });
      setErrors({});
      setMsg(`Saved as version ${r.version}.`);
      await reload();
      await reloadSession();
    } catch (e) {
      setErrors(errorsFrom((e as ApiError).errors));
      setMsg(null);
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
      {Object.keys(errors).length > 0 && <Notice tone="bad">Not saved: {Object.values(errors).join("; ")}</Notice>}
      {msg && <Notice tone="good">{msg}</Notice>}
      <fieldset disabled={!editable} style={{ border: 0, padding: 0, margin: 0 }} className="panel panel-pad">
        <s.C p={p} set={setP} errors={errors} options={data.options} />
      </fieldset>
      {editable ? <div className="row"><button className="btn primary" disabled={busy} onClick={() => void save()}>{busy ? "Saving…" : "Save changes"}</button></div>
        : <p className="muted small">Partners and admins can edit the profile.</p>}
    </div>
  );
}

function Team() {
  const { me, can } = useSession();
  const { data, reload } = useApi<{ members: { user_id: string; email: string; name: string | null; role: Role }[]; invited: { id: string; email: string; role: Role }[]; roles: Role[] }>("/team");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("analyst");
  const [msg, setMsg] = useState<{ tone: "good" | "bad"; text: string } | null>(null);
  if (!data) return <Loading />;
  const invite = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await api("/team/invite", { body: { email, role } });
      setMsg({ tone: "good", text: `Invited ${email}. They join when they sign in with that address.` });
      setEmail("");
      void reload();
    } catch (x) {
      setMsg({ tone: "bad", text: (x as Error).message });
    }
  };
  const remove = async (userId: string) => {
    try {
      await api(`/team/${userId}`, { method: "DELETE" });
      void reload();
    } catch (x) {
      setMsg({ tone: "bad", text: (x as Error).message });
    }
  };
  return (
    <div className="section">
      <h2>Team</h2>
      <p className="muted small" style={{ margin: 0 }}>Admins manage the team and firm. Partners edit the thesis, connect sources, run feeds and approve outbound items. Analysts read, upload and queue drafts.</p>
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      <div className="panel table-wrap">
        <table className="t">
          <thead><tr><th>Person</th><th>Role</th><th /></tr></thead>
          <tbody>
            {data.members.map((m) => (
              <tr key={m.user_id}>
                <td>{m.name ?? m.email}<div className="small muted">{m.email}</div></td>
                <td><span className="pill outline">{m.role}</span></td>
                <td>{can("manage_team") && m.user_id !== me.user.id && <button className="btn ghost small danger" onClick={() => void remove(m.user_id)}>Remove</button>}</td>
              </tr>
            ))}
            {data.invited.map((i) => (
              <tr key={i.id}><td>{i.email}<div className="small muted">invited, hasn't signed in yet</div></td><td><span className="pill quiet">{i.role}</span></td><td /></tr>
            ))}
          </tbody>
        </table>
      </div>
      {can("manage_team") && (
        <form className="panel panel-pad row" onSubmit={invite} style={{ alignItems: "flex-end" }}>
          <Field label="Invite by email"><input className="input" id="invite-email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="colleague@yourfirm.com" /></Field>
          <Field label="Role">
            <select className="input" id="invite-role" value={role} onChange={(e) => setRole(e.target.value as Role)}>
              {data.roles.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </Field>
          <button className="btn primary">Send invitation</button>
        </form>
      )}
    </div>
  );
}

function History() {
  const { data } = useApi<{ version: number; created_by: string; created_at: string }[]>("/profile/history");
  if (!data) return <Loading />;
  return (
    <div className="section">
      <h2>Profile history</h2>
      <div className="panel table-wrap">
        <table className="t">
          <thead><tr><th>Version</th><th>Saved by</th><th>When</th></tr></thead>
          <tbody>{data.map((h) => <tr key={h.version}><td className="num">v{h.version}</td><td>{h.created_by}</td><td className="small muted">{when(h.created_at)}</td></tr>)}</tbody>
        </table>
      </div>
    </div>
  );
}
