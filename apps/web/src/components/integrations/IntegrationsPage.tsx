import { useEffect, useLayoutEffect, useState } from "react";
import {
  Activity,
  BookOpen,
  Boxes,
  DollarSign,
  MessageSquare,
  Network,
  Plug,
  Shield,
  Users,
  Webhook,
} from "lucide-react";
import { DOCS_BASE_URL } from "@breeze/shared";
import WebhooksPage from "../webhooks/WebhooksPage";
import CommunicationIntegrations from "./CommunicationIntegrations";
import PsaConnectionsPage from "../psa/PsaConnectionsPage";
import SecurityIntegration from "./SecurityIntegration";
import HuntressIntegration from "./HuntressIntegration";
import MonitoringIntegration from "./MonitoringIntegration";
import GoogleWorkspaceIntegration from "./GoogleWorkspaceIntegration";
import M365Integration from "./M365Integration";
import M365CustomerGraphReadCard, {
  M365_CUSTOMER_GRAPH_READ_CALLBACK_RESULTS,
  type M365CustomerGraphReadCallbackResult,
} from "./M365CustomerGraphReadCard";
import Pax8Integration from "./Pax8Integration";
import TdSynnexCatalogPanel from "../settings/TdSynnexCatalogPanel";
import TdSynnexEcExpressPanel from "../settings/TdSynnexEcExpressPanel";
import TdSynnexSftpPanel from "../settings/TdSynnexSftpPanel";
import QuickbooksIntegration from "./QuickbooksIntegration";
import StripePaymentsIntegration from "./StripePaymentsIntegration";
import UnifiIntegration from "./UnifiIntegration";
import { getJwtClaims } from "../../lib/authScope";
import { useHelpStore, rebaseDocsUrl } from "../../stores/helpStore";
import { useOrgStore } from "../../stores/orgStore";
import { useTranslation } from "react-i18next";
import "@/lib/i18n";

type TabId =
  | "webhooks"
  | "notifications"
  | "psa"
  | "security"
  | "monitoring"
  | "identity"
  | "distributors"
  | "accounting"
  | "unifi";
type SecuritySubTab = "sentinelone" | "huntress";
type IdentitySubTab = "google" | "m365";
type DistributorSubTab = "pax8" | "tdsynnex" | "tdsynnex-ec" | "tdsynnex-sftp";
type AccountingSubTab = "quickbooks" | "stripe";

const tabs: { id: TabId; labelKey: string; icon: typeof Activity }[] = [
  { id: "webhooks", labelKey: "integrationsPage.webhooks", icon: Webhook },
  {
    id: "notifications",
    labelKey: "integrationsPage.notifications",
    icon: MessageSquare,
  },
  { id: "psa", labelKey: "integrationsPage.psa", icon: Plug },
  { id: "security", labelKey: "integrationsPage.security", icon: Shield },
  { id: "monitoring", labelKey: "integrationsPage.monitoring", icon: Activity },
  { id: "identity", labelKey: "integrationsPage.identity", icon: Users },
  {
    id: "distributors",
    labelKey: "integrationsPage.distributors",
    icon: Boxes,
  },
  {
    id: "accounting",
    labelKey: "integrationsPage.accounting",
    icon: DollarSign,
  },
  { id: "unifi", labelKey: "integrationsPage.unifi", icon: Network },
];

const securitySubTabs: { id: SecuritySubTab; labelKey: string }[] = [
  { id: "sentinelone", labelKey: "integrationsPage.sentinelone" },
  { id: "huntress", labelKey: "integrationsPage.huntress" },
];

const identitySubTabs: { id: IdentitySubTab; labelKey: string }[] = [
  { id: "google", labelKey: "integrationsPage.googleWorkspace" },
  { id: "m365", labelKey: "integrationsPage.microsoft365" },
];

const distributorSubTabs: { id: DistributorSubTab; labelKey: string }[] = [
  { id: "pax8", labelKey: "integrationsPage.pax8" },
  // The Digital Bridge "TD SYNNEX" tab is hidden for now. Its panel does have a
  // search/import UI, but the Digital Bridge API returns no usable catalog/price
  // data for our account (the catalog endpoint isn't entitled), so the tab is
  // hidden while EC Express is the working TD SYNNEX connector. The panel,
  // routes, and service remain; re-add this entry to restore the tab.
  { id: "tdsynnex-ec", labelKey: "integrationsPage.tdSYNNEXPricing" },
  { id: "tdsynnex-sftp", labelKey: "integrationsPage.tdSYNNEXPriceFile" },
];

const accountingSubTabs: { id: AccountingSubTab; labelKey: string }[] = [
  { id: "quickbooks", labelKey: "integrationsPage.quickbooks" },
  { id: "stripe", labelKey: "integrationsPage.payments" },
];

// Each top-level tab links to its own dedicated help-doc page. Opening the doc
// goes through the shared help panel (useHelpStore) so it respects the
// self-hosted PUBLIC_DOCS_URL rebasing and the trusted-origin gate.
const tabDocsPaths: Record<TabId, string> = {
  webhooks: "/features/webhooks/",
  notifications: "/features/notifications/",
  psa: "/features/psa-integrations/",
  security: "/features/edr-integrations/",
  monitoring: "/features/monitoring-integrations/",
  identity: "/features/identity-integrations/",
  distributors: "/features/distributor-integrations/",
  accounting: "/features/accounting-integrations/",
  unifi: "/features/unifi-integration/",
};

// Parse the URL hash into the tab — and, for a sub-tab hash like #huntress, its
// parent tab + sub-tab. Shared by the initial mount state and the hashchange
// listener so deep links, back/forward, and in-app tab clicks all agree. The
// legacy /settings/integrations/* routes 301-redirect here with such a hash.
function parseHash(fallbackTab: TabId): {
  tab: TabId;
  securitySub?: SecuritySubTab;
  identitySub?: IdentitySubTab;
  distributorSub?: DistributorSubTab;
  accountingSub?: AccountingSubTab;
  customerGraphReadResult?: M365CustomerGraphReadCallbackResult;
  consumeCustomerGraphReadResult?: boolean;
} {
  if (typeof window === "undefined") return { tab: fallbackTab };
  const hash = window.location.hash.replace(/^#/, "");
  const customerGraphReadPrefix = "m365/customer-graph-read/";
  if (hash.startsWith(customerGraphReadPrefix)) {
    const candidate = hash.slice(customerGraphReadPrefix.length);
    const customerGraphReadResult = M365_CUSTOMER_GRAPH_READ_CALLBACK_RESULTS.find(
      (result) => result === candidate,
    );
    return {
      tab: "identity",
      identitySub: "m365",
      customerGraphReadResult,
      consumeCustomerGraphReadResult: true,
    };
  }
  if (tabs.some((t) => t.id === hash)) return { tab: hash as TabId };
  if (securitySubTabs.some((s) => s.id === hash))
    return { tab: "security", securitySub: hash as SecuritySubTab };
  if (identitySubTabs.some((s) => s.id === hash))
    return { tab: "identity", identitySub: hash as IdentitySubTab };
  if (distributorSubTabs.some((s) => s.id === hash))
    return { tab: "distributors", distributorSub: hash as DistributorSubTab };
  if (accountingSubTabs.some((s) => s.id === hash))
    return { tab: "accounting", accountingSub: hash as AccountingSubTab };
  return { tab: fallbackTab };
}

// useLayoutEffect would warn during SSR (it is a no-op there); useEffect is the
// server-safe stand-in. On the client we want the layout variant so the hash is
// adopted before paint.
const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

interface IntegrationsPageProps {
  initialTab?: TabId;
}

export default function IntegrationsPage({
  initialTab = "webhooks",
}: IntegrationsPageProps) {
  const { t } = useTranslation("integrations");
  const currentOrgId = useOrgStore((value) => value.currentOrgId);
  const claims = getJwtClaims();
  const callbackOrgId = currentOrgId
    || (claims.scope === "organization" ? claims.orgId ?? null : null);
  // Deep-link support: the URL hash selects the initial tab — and sub-tab — on
  // load, e.g. /integrations#psa or /integrations#huntress.
  //
  // The hash is NOT available to the server (browsers never send the fragment),
  // so state must start from the server-rendered fallback and adopt the hash
  // after hydration — reading it during the first client render made React
  // discard the SSR tree with a hydration mismatch on every deep link.
  const [activeTab, setActiveTab] = useState<TabId>(initialTab);
  const [securitySubTab, setSecuritySubTab] = useState<SecuritySubTab>("sentinelone");
  const [identitySubTab, setIdentitySubTab] = useState<IdentitySubTab>("google");
  const [distributorSubTab, setDistributorSubTab] = useState<DistributorSubTab>("pax8");
  const [accountingSubTab, setAccountingSubTab] = useState<AccountingSubTab>("quickbooks");
  const [customerGraphReadCallback, setCustomerGraphReadCallback] = useState<{
    result: M365CustomerGraphReadCallbackResult | null;
    refreshKey: number;
    orgId: string | null;
  }>({ result: null, refreshKey: 0, orgId: null });

  // Adopt the hash post-commit / pre-paint (no visible flash of the fallback
  // tab), and keep following it for back/forward and externally-changed hashes.
  // The click handlers below set state directly, so this only handles hash
  // changes we didn't make ourselves.
  useIsomorphicLayoutEffect(() => {
    const applyHash = () => {
      const parsed = parseHash(initialTab);
      setActiveTab(parsed.tab);
      if (parsed.securitySub) setSecuritySubTab(parsed.securitySub);
      if (parsed.identitySub) setIdentitySubTab(parsed.identitySub);
      if (parsed.distributorSub) setDistributorSubTab(parsed.distributorSub);
      if (parsed.accountingSub) setAccountingSubTab(parsed.accountingSub);
      if (parsed.consumeCustomerGraphReadResult) {
        setCustomerGraphReadCallback((current) => ({
          result: parsed.customerGraphReadResult ?? null,
          refreshKey: current.refreshKey + 1,
          orgId: callbackOrgId,
        }));
        window.history.replaceState(
          window.history.state,
          "",
          `${window.location.pathname}${window.location.search}#m365`,
        );
      } else {
        setCustomerGraphReadCallback((current) =>
          current.result === null && current.orgId === null
            ? current
            : { ...current, result: null, orgId: null },
        );
      }
    };
    applyHash();
    window.addEventListener("hashchange", applyHash);
    return () => window.removeEventListener("hashchange", applyHash);
  }, [callbackOrgId, initialTab]);

  // Select a top-level tab and reflect it in the URL hash so the tab is
  // deep-linkable / shareable and survives a reload.
  const selectTab = (id: TabId) => {
    if (typeof window !== "undefined") window.location.hash = id;
    setActiveTab(id);
  };

  // Open the dedicated help doc for the active tab through the shared help
  // panel, which rebases onto a self-hosted docs origin when configured.
  const openTabDocs = () => {
    useHelpStore
      .getState()
      .open(rebaseDocsUrl(`${DOCS_BASE_URL}${tabDocsPaths[activeTab]}`));
  };

  const activeTabLabel = t(
    /* i18n-dynamic */ tabs.find((tab) => tab.id === activeTab)?.labelKey ??
      "integrationsPage.integrations",
  );

  // Pax8 and TD SYNNEX APIs both enforce requireScope('partner','system'). Gate
  // the Distributors tab on the JWT scope (never on useOrgStore().partners.length,
  // which is empty for real partner users — a known broken anti-pattern here) so
  // org-scope users get a clear message instead of 403 errors. getJwtClaims returns
  // null scope on a missing/undecodable token, so only a confirmed 'organization'
  // scope is blocked; everything else falls through to the server's own check.
  const isOrgScoped = claims.scope === "organization";
  const visibleCustomerGraphReadResult = callbackOrgId !== null
    && customerGraphReadCallback.orgId === callbackOrgId
    ? customerGraphReadCallback.result
    : null;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">
            {t("integrationsPage.integrations")}
          </h1>
          <p className="text-sm text-muted-foreground">
            {t(
              "integrationsPage.manageAllConnectionsAndKeepAutomationWorkflowsHealthy",
            )}
          </p>
        </div>
        <button
          type="button"
          onClick={openTabDocs}
          data-testid="integrations-docs-link"
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm text-muted-foreground transition hover:text-foreground"
        >
          <BookOpen className="h-4 w-4" />
          {t("integrationsPage.viewNameDocumentation", {
            name: activeTabLabel,
          })}
        </button>
      </div>

      {/* Top-level tabs */}
      <div className="flex flex-wrap gap-3">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const isActive = tab.id === activeTab;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => selectTab(tab.id)}
              className={`flex items-center gap-3 rounded-full border px-4 py-2 text-sm transition ${
                isActive
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border bg-background text-muted-foreground hover:text-foreground"
              }`}
            >
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-muted/60">
                <Icon className="h-4 w-4" />
              </span>
              <span className="font-medium">{t(/* i18n-dynamic */ tab.labelKey)}</span>
            </button>
          );
        })}
      </div>

      {/* Security sub-tabs */}
      {activeTab === "security" && (
        <div className="flex gap-2">
          {securitySubTabs.map((sub) => {
            const isActive = sub.id === securitySubTab;
            return (
              <button
                key={sub.id}
                type="button"
                onClick={() => {
                  if (typeof window !== "undefined")
                    window.location.hash = sub.id;
                  setSecuritySubTab(sub.id);
                }}
                className={`rounded-md border px-3 py-1.5 text-sm font-medium transition ${
                  isActive
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border bg-background text-muted-foreground hover:text-foreground"
                }`}
              >
                {t(/* i18n-dynamic */ sub.labelKey)}
              </button>
            );
          })}
        </div>
      )}

      {/* Identity sub-tabs */}
      {activeTab === "identity" && (
        <div className="flex gap-2">
          {identitySubTabs.map((sub) => {
            const isActive = sub.id === identitySubTab;
            return (
              <button
                key={sub.id}
                type="button"
                onClick={() => {
                  if (typeof window !== "undefined")
                    window.location.hash = sub.id;
                  setIdentitySubTab(sub.id);
                }}
                className={`rounded-md border px-3 py-1.5 text-sm font-medium transition ${
                  isActive
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border bg-background text-muted-foreground hover:text-foreground"
                }`}
              >
                {t(/* i18n-dynamic */ sub.labelKey)}
              </button>
            );
          })}
        </div>
      )}

      {/* Distributor sub-tabs (hidden for org-scope users, who can't use these APIs) */}
      {activeTab === "distributors" && !isOrgScoped && (
        <div className="flex gap-2">
          {distributorSubTabs.map((sub) => {
            const isActive = sub.id === distributorSubTab;
            return (
              <button
                key={sub.id}
                type="button"
                onClick={() => {
                  if (typeof window !== "undefined")
                    window.location.hash = sub.id;
                  setDistributorSubTab(sub.id);
                }}
                className={`rounded-md border px-3 py-1.5 text-sm font-medium transition ${
                  isActive
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border bg-background text-muted-foreground hover:text-foreground"
                }`}
              >
                {t(/* i18n-dynamic */ sub.labelKey)}
              </button>
            );
          })}
        </div>
      )}

      {/* Accounting sub-tabs (hidden for org-scope users, who can't use these APIs) */}
      {activeTab === "accounting" && !isOrgScoped && (
        <div className="flex gap-2">
          {accountingSubTabs.map((sub) => {
            const isActive = sub.id === accountingSubTab;
            return (
              <button
                key={sub.id}
                type="button"
                onClick={() => {
                  if (typeof window !== "undefined")
                    window.location.hash = sub.id;
                  setAccountingSubTab(sub.id);
                }}
                className={`rounded-md border px-3 py-1.5 text-sm font-medium transition ${
                  isActive
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border bg-background text-muted-foreground hover:text-foreground"
                }`}
              >
                {t(/* i18n-dynamic */ sub.labelKey)}
              </button>
            );
          })}
        </div>
      )}

      {/* Tab content */}
      {activeTab === "webhooks" && <WebhooksPage />}
      {activeTab === "notifications" && <CommunicationIntegrations />}
      {activeTab === "psa" && <PsaConnectionsPage />}
      {activeTab === "security" && securitySubTab === "sentinelone" && (
        <SecurityIntegration />
      )}
      {activeTab === "security" && securitySubTab === "huntress" && (
        <HuntressIntegration />
      )}
      {activeTab === "monitoring" && <MonitoringIntegration />}
      {activeTab === "identity" && identitySubTab === "google" && (
        <GoogleWorkspaceIntegration />
      )}
      {activeTab === "identity" && identitySubTab === "m365" && (
        <div className="space-y-6">
          <M365Integration />
          <M365CustomerGraphReadCard
            callbackResult={visibleCustomerGraphReadResult}
            callbackRefreshKey={customerGraphReadCallback.refreshKey}
          />
        </div>
      )}
      {activeTab === "distributors" && isOrgScoped && (
        <p
          className="py-12 text-center text-sm text-muted-foreground"
          data-testid="distributors-org-scope"
        >
          {t(
            "integrationsPage.distributorIntegrationsPax8AndTDSYNNEXAreAvailable",
          )}
        </p>
      )}
      {activeTab === "distributors" &&
        !isOrgScoped &&
        distributorSubTab === "pax8" && <Pax8Integration />}
      {activeTab === "distributors" &&
        !isOrgScoped &&
        distributorSubTab === "tdsynnex" && <TdSynnexCatalogPanel />}
      {activeTab === "distributors" &&
        !isOrgScoped &&
        distributorSubTab === "tdsynnex-ec" && <TdSynnexEcExpressPanel />}
      {activeTab === "distributors" &&
        !isOrgScoped &&
        distributorSubTab === "tdsynnex-sftp" && <TdSynnexSftpPanel />}
      {activeTab === "accounting" && isOrgScoped && (
        <p
          className="py-12 text-center text-sm text-muted-foreground"
          data-testid="accounting-org-scope"
        >
          {t(
            "integrationsPage.accountingIntegrationsAreAvailableToPartnerAccountsOnly",
          )}
        </p>
      )}
      {activeTab === "accounting" &&
        !isOrgScoped &&
        accountingSubTab === "quickbooks" && <QuickbooksIntegration />}
      {activeTab === "accounting" &&
        !isOrgScoped &&
        accountingSubTab === "stripe" && <StripePaymentsIntegration />}
      {activeTab === "unifi" && isOrgScoped && (
        <p
          className="py-12 text-center text-sm text-muted-foreground"
          data-testid="unifi-org-scope"
        >
          {t("integrationsPage.theUniFiNetworkIntegrationIsAvailableToPartner")}
        </p>
      )}
      {activeTab === "unifi" && !isOrgScoped && <UnifiIntegration />}
    </div>
  );
}
