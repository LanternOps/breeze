import { useCallback, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { useTranslation } from "react-i18next";
import "@/lib/i18n";
import { useHashTab } from "@/lib/useHashState";
import SecurityPageHeader from "./SecurityPageHeader";
import SecurityScanManager from "./SecurityScanManager";
import ThreatList from "./ThreatList";
import ThreatDetail from "./ThreatDetail";

type ScansTab = "scans" | "threats";

const SCANS_TABS: readonly ScansTab[] = ["scans", "threats"];

export default function SecurityScansPage() {
  const { t } = useTranslation("security");
  const [tab, setTab] = useHashTab<ScansTab>(SCANS_TABS, "scans");
  // Local, not hash-backed: this page only uses the hash for the top-level
  // scans/threats tab (see CLAUDE.md "URL State in Components"), and a
  // selected-threat id isn't a tab.
  const [selectedThreatId, setSelectedThreatId] = useState<string | null>(
    null,
  );

  const switchTab = useCallback(
    (next: ScansTab) => {
      window.location.hash = next;
      setTab(next);
      setSelectedThreatId(null);
    },
    [setTab],
  );

  return (
    <div className="space-y-6">
      <SecurityPageHeader
        title={t("securityScansPage.iocScans")}
        subtitle={t("securityScansPage.subtitle")}
      />

      <div className="inline-flex rounded-md border bg-muted/30 p-1 text-sm">
        <button
          type="button"
          data-testid="security-scans-tab-scans"
          onClick={() => switchTab("scans")}
          className={`rounded-md px-3 py-1 ${tab === "scans" ? "bg-background shadow-xs" : "text-muted-foreground"}`}
        >
          {t("securityScansPage.scansTab")}
        </button>
        <button
          type="button"
          data-testid="security-scans-tab-threats"
          onClick={() => switchTab("threats")}
          className={`rounded-md px-3 py-1 ${tab === "threats" ? "bg-background shadow-xs" : "text-muted-foreground"}`}
        >
          {t("securityScansPage.threatsTab")}
        </button>
      </div>

      {tab === "scans" ? (
        <div data-testid="security-scan-manager">
          <SecurityScanManager />
        </div>
      ) : selectedThreatId ? (
        <div data-testid="security-threat-detail">
          <button
            type="button"
            data-testid="security-threat-detail-close"
            onClick={() => setSelectedThreatId(null)}
            className="mb-4 inline-flex items-center gap-2 text-sm font-medium text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="h-4 w-4" />
            {t("securityScansPage.backToThreats")}
          </button>
          <ThreatDetail threatId={selectedThreatId} />
        </div>
      ) : (
        <div data-testid="security-threat-list">
          <ThreatList onSelectThreat={setSelectedThreatId} />
        </div>
      )}
    </div>
  );
}
