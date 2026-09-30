import { Link, useParams, useSearchParams } from "react-router-dom";
import { useApi } from "../api";
import type { RaiseView } from "../types";
import { ErrorState, Loading, PageHead, Tabs, tabPanelProps, usd } from "../ui";
import Pipeline from "./fr/Pipeline";
import Room from "./fr/Room";
import Ddq from "./fr/Ddq";
import Investors from "./fr/Investors";
import Closings from "./fr/Closings";
import SideLetters from "./fr/SideLetters";
import Relations from "./fr/Relations";

type Tab = "pipeline" | "room" | "ddq" | "investors" | "closings" | "side" | "relations";

/** One raise. The tab is in the URL so a link can open straight to closings or the data room. */
export default function Raise() {
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const tab = (params.get("tab") as Tab) || "pipeline";
  const setTab = (t: Tab) => setParams(t === "pipeline" ? {} : { tab: t }, { replace: true });
  const { data, error, reload } = useApi<RaiseView>(`/fundraising/raises/${id}`);
  if (error) return <ErrorState error={error} retry={() => void reload()} />;
  if (!data) return <Loading what="Loading the raise" />;
  const r = data.raise;
  const tabs: { id: Tab; label: string; badge?: number }[] = [
    { id: "pipeline", label: "Pipeline", badge: data.prospects.filter((p) => p.overdue).length },
    { id: "room", label: "Data room", badge: data.documents.filter((d) => d.status === "draft").length },
    { id: "ddq", label: "DDQ" },
    { id: "investors", label: "Subscriptions", badge: data.subscriptions.filter((s) => s.status === "submitted").length },
    { id: "closings", label: "Closings", badge: data.closings.filter((c) => c.status === "draft").length },
    { id: "side", label: "Side letters" },
    { id: "relations", label: "Investor relations" },
  ];
  const refresh = () => void reload();
  return (
    <>
      <PageHead
        eyebrow={<Link to="/fundraising">Fundraising & IR</Link>}
        title={r.name}
        lead={`Target ${usd(r.target_usd)}${r.hard_cap_usd ? `, hard cap ${usd(r.hard_cap_usd)}` : ""} · ${data.labels.exemptions[r.exemption]} · ${data.labels.offerings[r.offering]}`}
      />
      <Tabs tabs={tabs} value={tab} onChange={setTab} label="Raise sections" idBase="fr" />
      <div {...tabPanelProps("fr", tab)} className="section">
        {tab === "pipeline" && <Pipeline data={data} onChange={refresh} />}
        {tab === "room" && <Room data={data} onChange={refresh} />}
        {tab === "ddq" && <Ddq data={data} />}
        {tab === "investors" && <Investors data={data} onChange={refresh} />}
        {tab === "closings" && <Closings data={data} onChange={refresh} />}
        {tab === "side" && <SideLetters data={data} onChange={refresh} />}
        {tab === "relations" && <Relations data={data} />}
      </div>
    </>
  );
}

export interface FrTabProps {
  data: RaiseView;
  onChange: () => void;
}
