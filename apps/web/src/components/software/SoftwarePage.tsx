import { useState } from "react";
import { Package, ShieldCheck } from "lucide-react";
import SoftwareInventory from "./SoftwareInventory";
import ComplianceDashboard from "./ComplianceDashboard";
import { useTranslation } from "react-i18next";
import { i18n } from "@/lib/i18n";
import { useHashTab } from "@/lib/useHashState";
type Tab = "inventory" | "policies";

const VALID_TABS: Tab[] = ["inventory", "policies"];
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
  // The hash is not available during SSR, so the tab starts at the
  // server-rendered default and adopts the hash post-mount (pre-paint) —
  // reading it in the useState initializer caused a hydration mismatch on
  // deep links to a non-default tab (#2421). The hook also syncs back/forward
  // + external hash changes.
  const [tab, setTab] = useHashTab<Tab>(VALID_TABS, defaultTab);
  const [prefill, setPrefill] = useState<Prefill | null>(null);

  // Reflect the tab in the URL hash so it's deep-linkable and the contextual
  // help button resolves to the right doc (inventory vs. software policies).
  const selectTab = (next: Tab) => {
    if (typeof window !== "undefined") window.location.hash = next;
    setTab(next);
  };

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
