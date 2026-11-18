import { useCallback, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { useTranslation } from "react-i18next";
import "@/lib/i18n";
import { useHashState } from "@/lib/useHashState";
import SecurityPageHeader from "./SecurityPageHeader";
import SecurityScanManager from "./SecurityScanManager";
import ThreatList from "./ThreatList";
import ThreatDetail from "./ThreatDetail";
import SweepsPanel from "./sweeps/SweepsPanel";
import {
  DEFAULT_SCANS_HASH_STATE,
  encodeScansHash,
  parseScansHash,
  type ScansHashState,
  type ScansTab,
} from "./scansHash";

export default function SecurityScansPage() {
  const { t } = useTranslation("security");
  const [{ tab, group }, setHashState] = useHashState<ScansHashState>(
    DEFAULT_SCANS_HASH_STATE,
    parseScansHash,
  );
  // Local, not hash-backed: the hash holds the top-level tab and the selected
  // sweep group (`#sweeps&group=<id>`, see CLAUDE.md "URL State in
  // Components"); a selected-threat id isn't a tab.
  const [selectedThreatId, setSelectedThreatId] = useState<string | null>(
    null,
  );

  const writeState = useCallback(
    (next: ScansHashState) => {
      window.location.hash = encodeScansHash(next);
      setHashState(next);
    },
    [setHashState],
  );

  const switchTab = useCallback(
    (next: ScansTab) => {
      writeState({ tab: next, group: null });
      setSelectedThreatId(null);
    },
    [writeState],
  );

  const selectGroup = useCallback(
    (groupId: string | null) => writeState({ tab: "sweeps", group: groupId }),
    [writeState],
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
        <button
          type="button"
          data-testid="security-scans-tab-sweeps"
          onClick={() => switchTab("sweeps")}
          className={`rounded-md px-3 py-1 ${tab === "sweeps" ? "bg-background shadow-xs" : "text-muted-foreground"}`}
        >
          {t("securityScansPage.sweepsTab")}
        </button>
      </div>

      {tab === "scans" ? (
        <div data-testid="security-scan-manager">
          <SecurityScanManager />
        </div>
      ) : tab === "sweeps" ? (
        <SweepsPanel group={group} onSelectGroup={selectGroup} />
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
