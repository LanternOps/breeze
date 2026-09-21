import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import "@/lib/i18n";
import SecurityPageHeader from "./SecurityPageHeader";
import SecurityScanManager from "./SecurityScanManager";
import ThreatList from "./ThreatList";

type ScansTab = "scans" | "threats";

function tabFromHash(hash: string): ScansTab {
  return hash.replace(/^#/, "") === "threats" ? "threats" : "scans";
}

export default function SecurityScansPage() {
  const { t } = useTranslation("security");
  const [tab, setTab] = useState<ScansTab>(() =>
    tabFromHash(typeof window !== "undefined" ? window.location.hash : ""),
  );

  useEffect(() => {
    const onHashChange = () => setTab(tabFromHash(window.location.hash));
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const switchTab = useCallback((next: ScansTab) => {
    window.location.hash = next;
    setTab(next);
  }, []);

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
      ) : (
        <div data-testid="security-threat-list">
          <ThreatList />
        </div>
      )}
    </div>
  );
}
