import { useEffect } from "react";
import { Loader2 } from "lucide-react";
import { useHashState } from "@/lib/useHashState";
import { usePermissions } from "@/lib/permissions";
import OrgsTab from "./OrgsTab";
import PolicyEditor from "./PolicyEditor";
import SessionsTab from "./SessionsTab";
import UsageTab from "./UsageTab";
import TemplatesTab from "./TemplatesTab";
import { useTranslation } from "react-i18next";
import "@/lib/i18n";

/**
 * AI for Office — MSP admin surface shell (spec §9). Tab state lives in
 * window.location.hash (#orgs default, #sessions, #usage, #templates,
 * #policy/<orgId>) per the DeviceDetails.tsx hash-tab convention — never
 * query params. Deep links and reloads land on the right tab.
 *
 * The Templates tab is shown only to holders of client_ai_templates:read
 * (UX only; the API enforces the same permission). A #templates deep link
 * shows a spinner while permissions load, and once they are known to lack
 * the grant it falls back to #orgs (the URL is rewritten to match).
 */

const SIMPLE_TABS = ["orgs", "sessions", "usage", "templates"] as const;
type SimpleTab = (typeof SIMPLE_TABS)[number];

export type TabState = { tab: SimpleTab } | { tab: "policy"; orgId: string };

// Pure parser (leading `#` already stripped by useHashState) so it is
// SSR-safe — the hash is adopted post-mount by the hook (#2421).
export function getStateFromHash(hash: string): TabState {
  if (hash.startsWith("policy/")) {
    const orgId = hash.slice("policy/".length);
    if (orgId) return { tab: "policy", orgId };
  }
  if ((SIMPLE_TABS as readonly string[]).includes(hash))
    return { tab: hash as SimpleTab };
  return { tab: "orgs" };
}

export default function AiForOfficePage() {
  const { t } = useTranslation("ai");
  const [state, setState] = useHashState<TabState>(
    { tab: "orgs" },
    getStateFromHash,
  );
  const { permissions, can } = usePermissions();
  const canReadTemplates = can("client_ai_templates", "read");
  // While permissions load, a #templates deep link keeps its tab selected
  // (next to the spinner) rather than leaving no tab active.
  const visibleTabs = SIMPLE_TABS.filter(
    (tab) =>
      tab !== "templates" ||
      canReadTemplates ||
      (permissions === undefined && state.tab === "templates"),
  );
  const templatesDenied =
    state.tab === "templates" && permissions !== undefined && !canReadTemplates;
  const view: TabState = templatesDenied ? { tab: "orgs" } : state;

  useEffect(() => {
    if (!templatesDenied) return;
    window.history.replaceState(
      window.history.state,
      "",
      `${window.location.pathname}${window.location.search}#orgs`,
    );
    setState({ tab: "orgs" });
  }, [templatesDenied, setState]);

  const switchTab = (tab: SimpleTab) => {
    window.location.hash = tab;
    setState({ tab });
  };

  const openPolicy = (orgId: string) => {
    window.location.hash = `policy/${orgId}`;
    setState({ tab: "policy", orgId });
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">
          {t("aiForOfficePage.title")}
        </h1>
        <p className="text-muted-foreground">
          {t("aiForOfficePage.description")}
        </p>
      </div>

      <div className="border-b">
        <nav className="-mb-px flex gap-4">
          {visibleTabs.map((tab) => {
            const active =
              view.tab === tab || (tab === "orgs" && view.tab === "policy");
            return (
              <button
                key={tab}
                type="button"
                onClick={() => switchTab(tab)}
                className={`border-b-2 px-1 pb-2 text-sm font-medium transition-colors ${
                  active
                    ? "border-primary text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                }`}
                data-testid={`ai-office-tab-${tab}`}
              >
                {t(/* i18n-dynamic */ `aiForOfficePage.tabs.${tab}`)}
              </button>
            );
          })}
        </nav>
      </div>

      {view.tab === "orgs" && <OrgsTab onOpenPolicy={openPolicy} />}
      {view.tab === "policy" && (
        <PolicyEditor orgId={view.orgId} onBack={() => switchTab("orgs")} />
      )}
      {view.tab === "sessions" && <SessionsTab />}
      {view.tab === "usage" && <UsageTab />}
      {view.tab === "templates" && permissions === undefined && (
        <div
          className="flex items-center justify-center py-12"
          data-testid="ai-office-tab-loading"
        >
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      )}
      {view.tab === "templates" && canReadTemplates && <TemplatesTab />}
    </div>
  );
}
