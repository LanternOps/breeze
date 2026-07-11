import { useTranslation } from "react-i18next";
import "@/lib/i18n";
import { useEffect, useState } from "react";
import { ShieldAlert, Activity } from "lucide-react";
import S1ThreatList from "./S1ThreatList";
import HuntressIncidentList from "./HuntressIncidentList";
type EdrTab = "sentinelone" | "huntress";
const TABS: {
  id: EdrTab;
  labelKey: string;
  testid: string;
}[] = [
  {
    id: "sentinelone",
    labelKey: "securityEdrPage.sentineloneThreats",
    testid: "edr-tab-sentinelone",
  },
  {
    id: "huntress",
    labelKey: "securityEdrPage.huntressIncidents",
    testid: "edr-tab-huntress",
  },
];
function tabFromHash(): EdrTab {
  if (typeof window === "undefined") return "sentinelone";
  const h = window.location.hash.replace(/^#/, "");
  return h === "huntress" ? "huntress" : "sentinelone";
}
export default function EdrPage() {
  const { t } = useTranslation("security");
  const [activeTab, setActiveTab] = useState<EdrTab>(tabFromHash);
  useEffect(() => {
    const onHash = () => setActiveTab(tabFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const switchTab = (t: EdrTab) => {
    window.location.hash = t;
    setActiveTab(t);
  };
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">
          {t("securityEdrPage.endpointDetectionAndAmpResponse")}
        </h1>
        <p className="text-sm text-muted-foreground">
          {t("securityEdrPage.threatsAndIncidentsAcrossYourFleetFrom")}
        </p>
      </div>
      <div className="flex gap-2 border-b">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            data-testid={tab.testid}
            onClick={() => switchTab(tab.id)}
            className={`flex items-center gap-2 border-b-2 px-3 py-2 text-sm font-medium ${
              activeTab === tab.id
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {tab.id === "sentinelone" ? (
              <ShieldAlert className="h-4 w-4" />
            ) : (
              <Activity className="h-4 w-4" />
            )}
            {t(tab.labelKey)}
          </button>
        ))}
      </div>
      {activeTab === "sentinelone" ? (
        <S1ThreatList />
      ) : (
        <HuntressIncidentList />
      )}
    </div>
  );
}
