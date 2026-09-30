import { Link, useParams, useSearchParams } from "react-router-dom";
import { useApi } from "../api";
import type { PortfolioCompanyView } from "../types";
import { ErrorState, Loading, PageHead, Tabs, tabPanelProps, usd } from "../ui";
import { HealthPill } from "./portfolio/shared";
import Overview from "./portfolio/Overview";
import Numbers from "./portfolio/Numbers";
import Value from "./portfolio/Value";
import Capital from "./portfolio/Capital";
import Board from "./portfolio/Board";
import Help from "./portfolio/Help";
import Reporting from "./portfolio/Reporting";
import Exit from "./portfolio/Exit";

type Tab = "overview" | "numbers" | "value" | "capital" | "board" | "help" | "reporting" | "exit";

/** One portfolio company. The tab is in the URL so a link can open straight to marks or reporting. */
export default function PortfolioCompany() {
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const tab = (params.get("tab") as Tab) || "overview";
  const setTab = (t: Tab) => setParams(t === "overview" ? {} : { tab: t }, { replace: true });
  const { data, error, reload } = useApi<PortfolioCompanyView>(`/portfolio/companies/${id}`);
  if (error) return <ErrorState error={error} retry={() => void reload()} />;
  if (!data) return <Loading what="Loading the company" />;
  const rating = data.health[0] ? (data.health[0].value as { rating: "on_track" | "watch" | "at_risk" }).rating : null;
  const tabs: { id: Tab; label: string; badge?: number }[] = [
    { id: "overview", label: "Overview", badge: data.signals.filter((s) => s.severity !== "low").length },
    { id: "numbers", label: "Numbers" },
    { id: "value", label: "Valuation", badge: data.marks.filter((m) => m.status === "proposed").length },
    { id: "capital", label: "Reserves and follow-ons" },
    { id: "board", label: "Board" },
    { id: "help", label: "Value creation", badge: data.initiatives.filter((i) => i.status === "in_progress").length },
    { id: "reporting", label: "Reporting", badge: data.requests.filter((r) => r.status === "open").length },
    { id: "exit", label: "Exit and liquidity" },
  ];
  const refresh = () => void reload();
  return (
    <>
      <PageHead
        eyebrow={<Link to="/portfolio">Portfolio</Link>}
        title={data.company.name}
        lead={data.valueBasis === "exited"
          ? (data.value.pendingUsd + data.value.publicUsd > 0 ? `Exited; ${usd(data.value.pendingUsd + data.value.publicUsd)} still held in ${[data.value.pendingUsd > 0 && "escrows and earnouts", data.value.publicUsd > 0 && "the buyer's shares"].filter(Boolean).join(" and ")}.` : "Exited.")
          : data.valueBasis === "public" ? "Listed." : undefined}
        actions={
          <div className="row">
            {data.valueBasis !== "exited" && data.valueBasis !== "public" && <HealthPill rating={rating} suggested={data.suggested} labels={data.options.healthLabels} />}
            <Link className="btn small" to={`/execution/${data.company.dealId}`}>Investment record</Link>
            <Link className="btn small ghost" to={`/companies/${data.company.id}`}>All facts</Link>
          </div>
        }
      />
      <Tabs tabs={tabs} value={tab} onChange={setTab} label="Company sections" idBase="pf" />
      <div {...tabPanelProps("pf", tab)} className="section">
        {tab === "overview" && <Overview data={data} onChange={refresh} go={setTab} />}
        {tab === "numbers" && <Numbers data={data} onChange={refresh} />}
        {tab === "value" && <Value data={data} onChange={refresh} />}
        {tab === "capital" && <Capital data={data} onChange={refresh} />}
        {tab === "board" && <Board data={data} onChange={refresh} />}
        {tab === "help" && <Help data={data} onChange={refresh} />}
        {tab === "reporting" && <Reporting data={data} onChange={refresh} />}
        {tab === "exit" && <Exit data={data} onChange={refresh} />}
      </div>
    </>
  );
}

export interface PfTabProps {
  data: PortfolioCompanyView;
  onChange: () => void;
}
