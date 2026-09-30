import { Link, useParams, useSearchParams } from "react-router-dom";
import { useApi } from "../api";
import type { LpFundView } from "../types";
import { ErrorState, Loading, PageHead, Tabs, tabPanelProps } from "../ui";
import Overview from "./lp/Overview";
import { longDate } from "./lp/shared";
import Investors from "./lp/Investors";
import Calls from "./lp/Calls";
import Distributions from "./lp/Distributions";
import Accounts from "./lp/Accounts";
import Expenses from "./lp/Expenses";
import Reports from "./lp/Reports";
import Calendar from "./lp/Calendar";

type Tab = "overview" | "investors" | "calls" | "distributions" | "accounts" | "expenses" | "reports" | "calendar";

/** One fund. The tab is in the URL so a link can open straight to calls or reports. */
export default function LpFund() {
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const tab = (params.get("tab") as Tab) || "overview";
  const setTab = (t: Tab) => setParams(t === "overview" ? {} : { tab: t }, { replace: true });
  const { data, error, reload } = useApi<LpFundView>(`/lp/funds/${id}`);
  if (error) return <ErrorState error={error} retry={() => void reload()} />;
  if (!data) return <Loading what="Loading the fund" />;
  const tabs: { id: Tab; label: string; badge?: number }[] = [
    { id: "overview", label: "Overview" },
    { id: "investors", label: "Investors" },
    { id: "calls", label: "Capital calls", badge: data.calls.filter((c) => c.status === "draft").length + data.bank.unmatched.length },
    { id: "distributions", label: "Distributions", badge: data.distributions.filter((d) => d.status === "draft" || d.status === "approved").length },
    { id: "accounts", label: "Capital accounts" },
    { id: "expenses", label: "Fees and expenses" },
    { id: "reports", label: "Reports", badge: data.reports.filter((r) => r.status === "draft").length },
    { id: "calendar", label: "Deadlines and tax", badge: data.calendar.filter((d) => d.state === "overdue").length },
  ];
  const refresh = () => void reload();
  return (
    <>
      <PageHead eyebrow={<Link to="/lp-reporting">LP Reporting</Link>} title={data.fund.name} lead={`${data.fund.vintage ? `${data.fund.vintage} vintage · ` : ""}first close ${longDate(data.fund.inception)} · figures as of ${longDate(data.asOf)}`} />
      <Tabs tabs={tabs} value={tab} onChange={setTab} label="Fund sections" idBase="lp" />
      <div {...tabPanelProps("lp", tab)} className="section">
        {tab === "overview" && <Overview data={data} onChange={refresh} go={setTab} />}
        {tab === "investors" && <Investors data={data} onChange={refresh} />}
        {tab === "calls" && <Calls data={data} onChange={refresh} />}
        {tab === "distributions" && <Distributions data={data} onChange={refresh} />}
        {tab === "accounts" && <Accounts data={data} />}
        {tab === "expenses" && <Expenses data={data} onChange={refresh} />}
        {tab === "reports" && <Reports data={data} onChange={refresh} />}
        {tab === "calendar" && <Calendar data={data} onChange={refresh} />}
      </div>
    </>
  );
}

export type LpTab = Tab;
export interface LpTabProps {
  data: LpFundView;
  onChange: () => void;
}
