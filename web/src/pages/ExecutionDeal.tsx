import { Link, useParams, useSearchParams } from "react-router-dom";
import { useApi } from "../api";
import type { ExecutionView } from "../types";
import { ErrorState, Loading, PageHead, Tabs, tabPanelProps } from "../ui";
import { STAGE_LABELS, STAGE_TONE } from "./Diligence";
import Committee from "./exec/Committee";
import Terms from "./exec/Terms";
import CapModel from "./exec/CapModel";
import Closing from "./exec/Closing";
import Funding from "./exec/Funding";

type Tab = "ic" | "terms" | "model" | "closing" | "funding";

/**
 * One deal from IC to close. The tab is in the URL; the default follows the
 * deal's stage (IC while at IC, closing after approval).
 */
export default function ExecutionDeal() {
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const { data, error, reload } = useApi<ExecutionView>(`/deals/${id}/execution`);
  if (error) return <ErrorState error={error} retry={() => void reload()} />;
  if (!data) return <Loading what="Loading deal" />;
  const d = data.deal;
  const fallback: Tab = d.stage === "ic" ? "ic" : "closing";
  const tab = (params.get("tab") as Tab) || fallback;
  const setTab = (t: Tab) => setParams(t === fallback ? {} : { tab: t }, { replace: true });
  const outside = data.termSheets[0]?.checks.filter((c) => c.house === "outside").length ?? 0;
  const items = data.closing.items;
  const openRequired = data.closing.ready.open.length;
  const redFlags = items.filter((i) => i.status === "red_flag").length;
  const liveWire = data.wires.find((w) => w.status !== "cancelled");
  const tabs: { id: Tab; label: string; badge?: number }[] = [
    { id: "ic", label: "Investment committee" },
    { id: "terms", label: "Term sheet", badge: outside },
    { id: "model", label: "Cap table and returns" },
    { id: "closing", label: "Closing", badge: redFlags || openRequired },
    { id: "funding", label: "Wire and close", badge: liveWire?.status === "verified" ? 1 : undefined },
  ];
  const refresh = () => void reload();
  return (
    <>
      <PageHead
        eyebrow={<Link to="/execution">Investment Execution</Link>}
        title={d.company_name}
        lead={`Approval rule: ${data.icRule}.`}
        actions={
          <div className="row">
            <span className={`pill ${STAGE_TONE[d.stage]}`}>{STAGE_LABELS[d.stage]}</span>
            <Link className="btn small" to={`/diligence/${d.id}`}>Diligence and memo</Link>
            <Link className="btn small ghost" to={`/companies/${d.company_id}`}>All facts</Link>
          </div>
        }
      />
      <Tabs tabs={tabs} value={tab} onChange={setTab} label="Execution sections" idBase="exec" />
      <div {...tabPanelProps("exec", tab)} className="section">
        {tab === "ic" && <Committee data={data} onChange={refresh} />}
        {tab === "terms" && <Terms data={data} onChange={refresh} />}
        {tab === "model" && <CapModel data={data} onChange={refresh} />}
        {tab === "closing" && <Closing data={data} onChange={refresh} />}
        {tab === "funding" && <Funding data={data} onChange={refresh} />}
      </div>
    </>
  );
}

export interface ExecTabProps {
  data: ExecutionView;
  onChange: () => void;
}

export const person = (actor: string | null | undefined) => (actor ?? "").replace(/^human:/, "");
