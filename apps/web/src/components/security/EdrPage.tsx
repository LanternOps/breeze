import { useTranslation } from "react-i18next";
import "@/lib/i18n";
import { useHashState } from "@/lib/useHashState";
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
export default function EdrPage() {
  const { t } = useTranslation("security");
  // SSR-safe hash tab (#2421): starts at the default, adopts the hash post-mount.
  const [activeTab, setActiveTab] = useHashState<EdrTab>("sentinelone", (h) =>
    h === "huntress" ? "huntress" : undefined,
  );
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
            {t(/* i18n-dynamic */ tab.labelKey)}
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
