import { createContext, useContext, type ReactNode } from "react";
import { BrowserRouter, Navigate, NavLink, Route, Routes, useLocation } from "react-router-dom";
import { api, useApi } from "./api";
import type { Action, Me, ModuleInfo, OutboxItem } from "./types";
import { Loading } from "./ui";
import SignIn from "./pages/SignIn";
import Welcome from "./pages/Welcome";
import Onboarding from "./pages/Onboarding";
import Sourcing from "./pages/Sourcing";
import Companies from "./pages/Companies";
import Company from "./pages/Company";
import Connections from "./pages/Connections";
import Approvals from "./pages/Approvals";
import Settings from "./pages/Settings";
import ModulePage from "./pages/ModulePage";

interface Session {
  me: Me;
  reload: () => Promise<void>;
  can: (a: Action) => boolean;
}

const SessionCtx = createContext<Session | null>(null);
export const useSession = () => useContext(SessionCtx)!;

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/signin" element={<SignIn />} />
        <Route path="*" element={<Gate />} />
      </Routes>
    </BrowserRouter>
  );
}

/** Signed in? Has a firm? Finished onboarding? Route accordingly. */
function Gate() {
  const { data: me, error, loading, reload } = useApi<Me>("/me");
  const loc = useLocation();
  if (loading && !me) return <div className="center-page"><Loading /></div>;
  if (error?.status === 401 || !me) return <Navigate to="/signin" replace />;
  const session: Session = { me, reload, can: (a) => Boolean(me.can[a]) };
  if (!me.firm) return <SessionCtx.Provider value={session}><Welcome /></SessionCtx.Provider>;
  if (!me.onboarded && !loc.pathname.startsWith("/setup") && me.can.edit_thesis) return <Navigate to="/setup" replace />;
  return (
    <SessionCtx.Provider value={session}>
      <Routes>
        <Route path="/setup" element={<Onboarding />} />
        <Route path="*" element={<Shell />} />
      </Routes>
    </SessionCtx.Provider>
  );
}

function Shell() {
  const { me, reload } = useSession();
  const { data: modules } = useApi<ModuleInfo[]>("/modules");
  const { data: pending } = useApi<OutboxItem[]>("/outbox");
  const switchFirm = async (firmId: string) => {
    await api("/firms/switch", { body: { firmId } });
    await reload();
  };
  const signOut = async () => {
    await api("/auth/logout", { body: {} });
    window.location.href = "/signin";
  };
  return (
    <div className="shell">
      <aside className="rail">
        <div className="brand">VC OS</div>
        {me.firms.length > 1 ? (
          <select className="firm-switch" value={me.firm!.id} onChange={(e) => void switchFirm(e.target.value)} aria-label="Firm">
            {me.firms.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
        ) : (
          <div className="firm-switch">{me.firm!.name}</div>
        )}
        <div>
          <h6>Modules</h6>
          <nav>
            {(modules ?? []).map((m) => (
              <NavLink key={m.id} to={m.path}>
                {m.name}
                {m.status !== "live" && <span className="tag">{m.status === "next" ? "next" : `phase ${m.phase}`}</span>}
              </NavLink>
            ))}
          </nav>
        </div>
        <div>
          <h6>Workspace</h6>
          <nav>
            <NavLink to="/companies">Companies</NavLink>
            <NavLink to="/approvals">Approvals {pending && pending.length > 0 && <span className="count">{pending.length}</span>}</NavLink>
            <NavLink to="/connections">Connections</NavLink>
            <NavLink to="/settings">Firm settings</NavLink>
          </nav>
        </div>
        <div className="me">
          <span>{me.user.name ?? me.user.email}</span>
          <span>{me.firm!.role}</span>
          <button type="button" onClick={() => void signOut()}>Sign out</button>
        </div>
      </aside>
      <main className="work">
        <Routes>
          <Route path="/" element={<Navigate to="/sourcing" replace />} />
          <Route path="/sourcing" element={<Sourcing />} />
          <Route path="/companies" element={<Companies />} />
          <Route path="/companies/:id" element={<Company />} />
          <Route path="/connections" element={<Connections />} />
          <Route path="/approvals" element={<Approvals />} />
          <Route path="/settings/*" element={<Settings />} />
          {(modules ?? []).filter((m) => m.status !== "live").map((m) => (
            <Route key={m.id} path={m.path} element={<ModulePage module={m} />} />
          ))}
          <Route path="*" element={modules ? <NotFound /> : <Loading />} />
        </Routes>
      </main>
    </div>
  );
}

function NotFound(): ReactNode {
  return <p className="muted">There's nothing at this address. Use the menu on the left.</p>;
}
