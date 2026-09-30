import { createContext, useContext, useEffect } from "react";
import { BrowserRouter, Navigate, NavLink, Route, Routes, useLocation } from "react-router-dom";
import { api, useApi } from "./api";
import type { Action, Me, ModuleInfo, OutboxItem } from "./types";
import { ConfirmProvider, ErrorState, Loading, PageHead, ToastProvider } from "./ui";
import { VocabProvider } from "./vocab";
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
import Diligence from "./pages/Diligence";
import Deal from "./pages/Deal";
import Meetings from "./pages/Meetings";
import Execution from "./pages/Execution";
import ExecutionDeal from "./pages/ExecutionDeal";
import Portfolio from "./pages/Portfolio";
import PortfolioCompany from "./pages/PortfolioCompany";
import Portal, { PortalConnected } from "./pages/Portal";
import Lp from "./pages/Lp";
import LpFund from "./pages/LpFund";
import Investor from "./pages/Investor";
import Fundraising from "./pages/Fundraising";
import Compliance from "./pages/Compliance";
import Liquidity from "./pages/Liquidity";
import FundLife from "./pages/FundLife";
import Raise from "./pages/Raise";
import DataRoom from "./pages/DataRoom";
import Subscribe from "./pages/Subscribe";

interface Session {
  me: Me;
  reload: () => Promise<void>;
  can: (a: Action) => boolean;
}

const SessionCtx = createContext<Session | null>(null);
export const useSession = () => useContext(SessionCtx)!;

export default function App() {
  return (
    <ToastProvider>
      <ConfirmProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/signin" element={<SignIn />} />
            <Route path="/portal/connected" element={<PortalConnected />} />
            <Route path="/portal/:token" element={<Portal />} />
            <Route path="/investor/:token" element={<Investor />} />
            <Route path="/data-room/:token" element={<DataRoom />} />
            <Route path="/subscribe/:token" element={<Subscribe />} />
            <Route path="*" element={<Gate />} />
          </Routes>
        </BrowserRouter>
      </ConfirmProvider>
    </ToastProvider>
  );
}

export const ROLE_LABELS = { admin: "Admin", partner: "Partner", analyst: "Analyst" } as const;

/** Signed in? Has a firm? Finished onboarding? Route accordingly. */
function Gate() {
  const { data: me, error, loading, reload } = useApi<Me>("/me");
  const loc = useLocation();
  if (loading && !me) return <div className="center-page"><Loading /></div>;
  if (error?.status === 401) return <Navigate to="/signin" replace />;
  if (error || !me) return <div className="center-page"><ErrorState error={error ?? { message: "Couldn't load your session." }} retry={() => void reload()} /></div>;
  const session: Session = { me, reload, can: (a) => Boolean(me.can[a]) };
  if (!me.firm) return <SessionCtx.Provider value={session}><Welcome /></SessionCtx.Provider>;
  if (!me.onboarded && !loc.pathname.startsWith("/setup") && me.can.edit_thesis) return <Navigate to="/setup" replace />;
  return (
    <SessionCtx.Provider value={session}>
      <VocabProvider>
        <Routes>
          <Route path="/setup" element={<Onboarding />} />
          <Route path="*" element={<Shell />} />
        </Routes>
      </VocabProvider>
    </SessionCtx.Provider>
  );
}

/** After each navigation, move focus to the new page's title so screen readers announce it. */
function useFocusOnNavigate() {
  const loc = useLocation();
  useEffect(() => {
    const t = setTimeout(() => document.getElementById("page-title")?.focus({ preventScroll: true }), 50);
    return () => clearTimeout(t);
  }, [loc.pathname]);
}

function Shell() {
  const { me, reload } = useSession();
  useFocusOnNavigate();
  const { data: modules } = useApi<ModuleInfo[]>("/modules");
  const { data: pending } = useApi<OutboxItem[]>("/outbox");
  const { data: meetingCounts } = useApi<{ needs_review: number }>("/meetings/counts");
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
      <a className="skip" href="#main">Skip to content</a>
      <aside className="rail" aria-label="Main menu">
        <div className="brand">VC OS</div>
        {me.firms.length > 1 ? (
          <select className="firm-switch" value={me.firm!.id} onChange={(e) => void switchFirm(e.target.value)} aria-label="Firm">
            {me.firms.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
        ) : (
          <div className="firm-switch">{me.firm!.name}</div>
        )}
        <div>
          <h6 id="nav-modules">Modules</h6>
          <nav aria-labelledby="nav-modules">
            {(modules ?? []).map((m) => (
              <NavLink key={m.id} to={m.path}>
                {m.name}
                {m.status !== "live" && <span className="tag">{m.status === "next" ? "next" : `phase ${m.phase}`}</span>}
              </NavLink>
            ))}
          </nav>
        </div>
        <div>
          <h6 id="nav-workspace">Workspace</h6>
          <nav aria-labelledby="nav-workspace">
            <NavLink to="/companies">Companies</NavLink>
            <NavLink to="/meetings">
              Meetings {meetingCounts && meetingCounts.needs_review > 0 && <span className="count" aria-label={`${meetingCounts.needs_review} need you`}>{meetingCounts.needs_review}</span>}
            </NavLink>
            <NavLink to="/approvals">
              Approvals {pending && pending.length > 0 && <span className="count" aria-label={`${pending.length} waiting`}>{pending.length}</span>}
            </NavLink>
            <NavLink to="/compliance">Compliance</NavLink>
            <NavLink to="/connections">Connections</NavLink>
            <NavLink to="/settings">Firm settings</NavLink>
          </nav>
        </div>
        <div className="me">
          <span>{me.user.name ?? me.user.email}</span>
          <span>{ROLE_LABELS[me.firm!.role]}</span>
          <button type="button" onClick={() => void signOut()}>Sign out</button>
        </div>
      </aside>
      <main className="work" id="main">
        <Routes>
          <Route path="/" element={<Navigate to="/sourcing" replace />} />
          <Route path="/sourcing" element={<Sourcing />} />
          <Route path="/companies" element={<Companies />} />
          <Route path="/companies/:id" element={<Company />} />
          <Route path="/diligence" element={<Diligence />} />
          <Route path="/diligence/:id" element={<Deal />} />
          <Route path="/execution" element={<Execution />} />
          <Route path="/execution/:id" element={<ExecutionDeal />} />
          <Route path="/portfolio" element={<Portfolio />} />
          <Route path="/portfolio/liquidity" element={<Liquidity />} />
          <Route path="/portfolio/funds/:id" element={<FundLife />} />
          <Route path="/portfolio/:id" element={<PortfolioCompany />} />
          <Route path="/lp-reporting" element={<Lp />} />
          <Route path="/lp-reporting/:id" element={<LpFund />} />
          <Route path="/fundraising" element={<Fundraising />} />
          <Route path="/fundraising/:id" element={<Raise />} />
          <Route path="/compliance" element={<Compliance />} />
          <Route path="/meetings" element={<Meetings />} />
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

function NotFound() {
  return <PageHead title="Page not found" lead="There's nothing at this address. Use the menu to find your way." />;
}
