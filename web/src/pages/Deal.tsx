import { Link, useParams, useSearchParams } from "react-router-dom";
import { useApi } from "../api";
import type { DealView } from "../types";
import { ErrorState, FitBadge, Loading, PageHead, Tabs, tabPanelProps } from "../ui";
import { StageName, STAGE_TONE } from "./Diligence";
import Overview from "./deal/Overview";
import Checklist from "./deal/Checklist";
import Questions from "./deal/Questions";
import Conflicts from "./deal/Conflicts";
import Calls from "./deal/Calls";
import MemoTab from "./deal/Memo";
import Decision from "./deal/Decision";

type Tab = "overview" | "checklist" | "questions" | "conflicts" | "calls" | "memo" | "decision";

/**
 * One deal's workspace. Every tab reads the same view of the ledger, so a
 * note logged on "Calls" updates the checklist and the questions at once.
 * The tab is in the URL, so a link can open straight to the memo.
 */
export default function Deal() {
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const tab = (params.get("tab") as Tab) || "overview";
  const setTab = (t: Tab) => setParams(t === "overview" ? {} : { tab: t }, { replace: true });
  const { data, error, reload } = useApi<DealView>(`/deals/${id}`);
  if (error) return <ErrorState error={error} retry={() => void reload()} />;
  if (!data) return <Loading what="Loading deal" />;
  const d = data.deal;
  const openQs = data.questions.filter((q) => q.status === "open").length;
  const tabs: { id: Tab; label: string; badge?: number }[] = [
    { id: "overview", label: "Overview" },
    { id: "checklist", label: "Checklist", badge: data.readiness.requiredOpen.length },
    { id: "questions", label: "Questions", badge: openQs },
    { id: "conflicts", label: "Conflicts", badge: data.contradictions.length },
    { id: "calls", label: "Meetings and notes", badge: data.meetings.length + data.notes.length },
    { id: "memo", label: "IC memo" },
    { id: "decision", label: "Decision" },
  ];
  const domain = data.company.identifiers.find((i) => i.kind === "domain")?.value;
  const refresh = () => void reload();
  return (
    <>
      <PageHead
        eyebrow={<Link to="/diligence">Diligence</Link>}
        title={d.company_name}
        lead={data.claims.find((c) => c.predicate === "company.description")?.display}
        actions={
          <div className="row">
            <span className={`pill ${STAGE_TONE[d.stage]}`}><StageName stage={d.stage} /></span>
            {data.fit && <FitBadge score={data.fit.fit_score} verdict={data.fit.fit_verdict} />}
            {["ic", "approved", "closing", "closed"].includes(d.stage) && <Link className="btn small primary" to={`/execution/${d.id}`}>Open in Execution</Link>}
            <Link className="btn small" to={`/companies/${data.company.id}`}>All facts</Link>
            {domain && <a className="btn small ghost" href={`https://${domain}`} target="_blank" rel="noreferrer">{domain}<span className="sr-only"> (opens in a new tab)</span></a>}
          </div>
        }
      />
      <Tabs tabs={tabs} value={tab} onChange={setTab} label="Deal sections" idBase="deal" />
      <div {...tabPanelProps("deal", tab)} className="section">
        {tab === "overview" && <Overview data={data} onChange={refresh} go={setTab} />}
        {tab === "checklist" && <Checklist data={data} onChange={refresh} />}
        {tab === "questions" && <Questions data={data} onChange={refresh} />}
        {tab === "conflicts" && <Conflicts data={data} onChange={refresh} />}
        {tab === "calls" && <Calls data={data} onChange={refresh} />}
        {tab === "memo" && <MemoTab data={data} onChange={refresh} />}
        {tab === "decision" && <Decision data={data} onChange={refresh} />}
      </div>
    </>
  );
}

export interface TabProps {
  data: DealView;
  onChange: () => void;
}
