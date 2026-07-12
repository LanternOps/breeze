import { useEffect, useState } from "react";
import { Package, ShieldCheck } from "lucide-react";
import SoftwareInventory from "./SoftwareInventory";
import ComplianceDashboard from "./ComplianceDashboard";
import { useTranslation } from "react-i18next";
import { i18n } from "@/lib/i18n";
type Tab = "inventory" | "policies";

const VALID_TABS: Tab[] = ["inventory", "policies"];

function getTabFromHash(fallback: Tab): Tab {
  if (typeof window === "undefined") return fallback;
  const hash = window.location.hash.replace(/^#/, "");
  return VALID_TABS.includes(hash as Tab) ? (hash as Tab) : fallback;
}
type Prefill = {
  name: string;
  vendor?: string;
  mode?: string;
};
export default function SoftwarePage({
  defaultTab = "inventory",
}: {
  defaultTab?: Tab;
}) {
  useTranslation("policies");
  const [tab, setTab] = useState<Tab>(() => getTabFromHash(defaultTab));
  const [prefill, setPrefill] = useState<Prefill | null>(null);

  // Reflect the tab in the URL hash so it's deep-linkable and the contextual
  // help button resolves to the right doc (inventory vs. software policies).
  const selectTab = (next: Tab) => {
    if (typeof window !== "undefined") window.location.hash = next;
    setTab(next);
  };

  // Sync with back/forward + external hash changes.
  useEffect(() => {
    const onHashChange = () => setTab(getTabFromHash(defaultTab));
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, [defaultTab]);

  const handleSwitchToPolicies = (data?: Prefill) => {
    setPrefill(data ?? null);
    selectTab("policies");
  };
  const tabs: {
    key: Tab;
    label: string;
    icon: typeof Package;
  }[] = [
    {
      key: "inventory",
      label: i18n.t("policies:software.softwarePage.inventory"),
      icon: Package,
    },
    {
      key: "policies",
      label: i18n.t("policies:software.softwarePage.policies"),
      icon: ShieldCheck,
    },
  ];
  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">
            {i18n.t("policies:software.softwarePage.software")}
          </h1>
          <p className="text-sm text-muted-foreground">
            {tab === "inventory"
              ? i18n.t(
                  "policies:software.softwarePage.aggregateViewOfSoftwareInstalledAcrossAll",
                )
              : i18n.t(
                  "policies:software.softwarePage.enforceAllowlistAndBlocklistControlsAcrossManaged",
                )}
          </p>
        </div>
      </div>

      <div className="flex gap-1 border-b">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => {
              if (t.key !== tab) setPrefill(null);
              selectTab(t.key);
            }}
            className={`inline-flex items-center gap-2 border-b-2 px-4 py-2 text-sm font-medium transition-colors ${
              tab === t.key
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:border-muted hover:text-foreground"
            }`}
          >
            <t.icon className="h-4 w-4" />
            {t.label}
          </button>
        ))}
      </div>

      {tab === "inventory" && (
        <SoftwareInventory onSwitchToPolicies={handleSwitchToPolicies} />
      )}
      {tab === "policies" && <ComplianceDashboard prefill={prefill} />}
    </div>
  );
}
