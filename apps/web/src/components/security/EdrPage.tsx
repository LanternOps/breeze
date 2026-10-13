import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import "@/lib/i18n";
import { useHashState } from "@/lib/useHashState";
import { ShieldAlert, Activity, Shield } from "lucide-react";
import { fetchEdrStatus, type EdrStatusSummary } from "@/lib/edrProviders";
import S1ThreatList from "./S1ThreatList";
import HuntressIncidentList from "./HuntressIncidentList";
import OtherEdrDetectionList from "./OtherEdrDetectionList";
type EdrTab = "sentinelone" | "huntress" | "other-edr";
const LEGACY_TABS: {
  id: "sentinelone" | "huntress";
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
  const [hashTab, setActiveTab] = useHashState<EdrTab>("sentinelone", (h) =>
    h === "huntress" || h === "other-edr" ? h : undefined,
  );
  // Framework-provider summary. The "Other EDR" tab exists only when it has at
  // least one provider; a failed load hides it (never shown as an empty tab).
  const [status, setStatus] = useState<EdrStatusSummary | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    fetchEdrStatus()
      .then((s) => {
        if (!cancelled) setStatus(s);
      })
      .catch(() => {
        if (!cancelled) setStatus(null);
      })
      .finally(() => {
        if (!cancelled) setStatusLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const hasOther = !!status && status.providers.length > 0;
  const providerKeys = new Set((status?.providers ?? []).map((p) => p.provider));
  const otherLabel =
    providerKeys.size === 1 && status
      ? status.providers[0].label
      : t("securityOtherEdr.tabLabel");
  // A hidden tab can never be active. While status is still loading a
  // #other-edr deep link waits (renders nothing) instead of flashing SentinelOne.
  const waitingForOther = hashTab === "other-edr" && statusLoading;
  const activeTab: EdrTab =
    hashTab === "other-edr" && !hasOther ? "sentinelone" : hashTab;

  const switchTab = (next: EdrTab) => {
    window.location.hash = next;
    setActiveTab(next);
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
        {LEGACY_TABS.map((tab) => (
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
        {hasOther && (
          <button
            type="button"
            data-testid="edr-tab-other-edr"
            onClick={() => switchTab("other-edr")}
            className={`flex items-center gap-2 border-b-2 px-3 py-2 text-sm font-medium ${
              activeTab === "other-edr"
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            <Shield className="h-4 w-4" />
            <span>{otherLabel}</span>
          </button>
        )}
      </div>
      {waitingForOther ? null : activeTab === "other-edr" && status ? (
        <OtherEdrDetectionList status={status} />
      ) : activeTab === "huntress" ? (
        <HuntressIncidentList />
      ) : (
        <S1ThreatList />
      )}
    </div>
  );
}
