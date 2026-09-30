import { useSearchParams } from "react-router-dom";
import { useApi } from "../api";
import type { ComplianceOverview } from "../types";
import { ErrorState, Loading, Notice, PageHead, Tabs, tabPanelProps, useToast } from "../ui";
import Calendar from "./co/Calendar";
import Screenings from "./co/Screenings";
import Ethics from "./co/Ethics";
import Gifts from "./co/Gifts";
import Conflicts from "./co/Conflicts";
import Attestations from "./co/Attestations";
import Profile from "./co/Profile";

type Tab = "calendar" | "deals" | "ethics" | "gifts" | "conflicts" | "attest" | "profile";

/**
 * Compliance, shared by every module: what's due, deal screenings before a
 * closing, the code of ethics, pay-to-play and gifts, conflicts, and the
 * year's attestations. The system flags and dates; the CCO and counsel decide.
 */
export default function Compliance() {
  const [params, setParams] = useSearchParams();
  const tab = (params.get("tab") as Tab) || "calendar";
  const setTab = (t: Tab) => setParams(t === "calendar" ? {} : { tab: t }, { replace: true });
  const { data, error, reload } = useApi<ComplianceOverview>("/compliance");
  if (error) return <ErrorState error={error} retry={() => void reload()} />;
  if (!data) return <Loading what="Loading compliance" />;
  const pendingFor = (rows: { status: string; person: string }[]) => (data.reviewer ? rows.filter((r) => r.status === "pending" && r.person !== data.person).length : 0);
  const tabs: { id: Tab; label: string; badge?: number }[] = [
    { id: "calendar", label: "Calendar", badge: data.calendar.filter((o) => o.state === "overdue").length },
    { id: "deals", label: "Deal screening", badge: data.needsScreening.length },
    { id: "ethics", label: "Code of ethics", badge: pendingFor(data.preclearances) },
    { id: "gifts", label: "Contributions and gifts", badge: pendingFor(data.contributions) + (data.reviewer ? data.gifts.filter((g) => g.status === "logged" && g.over_limit && g.person !== data.person).length : 0) },
    { id: "conflicts", label: "Conflicts", badge: data.conflicts.filter((c) => c.status === "open").length },
    { id: "attest", label: "Attestations and reviews", badge: data.attestations.missing.filter((m) => m.person === data.person).length },
    { id: "profile", label: "Regulatory profile" },
  ];
  const refresh = () => void reload();
  return (
    <>
      <PageHead
        title="Compliance"
        lead={`${data.labels.adviserStatus[data.profile.adviser_status]}. Every module feeds it: closings and investors' states date Form D and state notices, closed deals date outbound notices, funds size Form PF.`}
      />
      {!data.profile.configured && <Notice tone="warn">Set the regulatory profile so the calendar matches your status. Until then it assumes an exempt reporting adviser, and deals can close without a screening.</Notice>}
      <Tabs tabs={tabs} value={tab} onChange={setTab} label="Compliance sections" idBase="co" />
      <div {...tabPanelProps("co", tab)} className="section">
        {tab === "calendar" && <Calendar data={data} onChange={refresh} />}
        {tab === "deals" && <Screenings data={data} onChange={refresh} />}
        {tab === "ethics" && <Ethics data={data} onChange={refresh} />}
        {tab === "gifts" && <Gifts data={data} onChange={refresh} />}
        {tab === "conflicts" && <Conflicts data={data} onChange={refresh} />}
        {tab === "attest" && <Attestations data={data} onChange={refresh} />}
        {tab === "profile" && <Profile data={data} onChange={refresh} />}
      </div>
    </>
  );
}

export interface CoTabProps {
  data: ComplianceOverview;
  onChange: () => void;
}

/** Run an action, toast the result, and refresh the page's data. */
export function useRun(onChange: () => void) {
  const toast = useToast();
  return async (fn: () => Promise<unknown>, done: string) => {
    try {
      await fn();
      toast("good", done);
      onChange();
      return true;
    } catch (e) {
      toast("bad", (e as Error).message);
      return false;
    }
  };
}
