import { useState } from "react";
import {
  Activity,
  Boxes,
  DollarSign,
  MessageSquare,
  Network,
  Plug,
  Shield,
  Users,
  Webhook,
} from "lucide-react";
import WebhooksPage from "../webhooks/WebhooksPage";
import CommunicationIntegrations from "./CommunicationIntegrations";
import PsaConnectionsPage from "../psa/PsaConnectionsPage";
import SecurityIntegration from "./SecurityIntegration";
import HuntressIntegration from "./HuntressIntegration";
import MonitoringIntegration from "./MonitoringIntegration";
import GoogleWorkspaceIntegration from "./GoogleWorkspaceIntegration";
import M365Integration from "./M365Integration";
import Pax8Integration from "./Pax8Integration";
import TdSynnexCatalogPanel from "../settings/TdSynnexCatalogPanel";
import TdSynnexEcExpressPanel from "../settings/TdSynnexEcExpressPanel";
import QuickbooksIntegration from "./QuickbooksIntegration";
import StripePaymentsIntegration from "./StripePaymentsIntegration";
import UnifiIntegration from "./UnifiIntegration";
import { getJwtClaims } from "../../lib/authScope";
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
type DistributorSubTab = "pax8" | "tdsynnex" | "tdsynnex-ec";
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
];

const accountingSubTabs: { id: AccountingSubTab; labelKey: string }[] = [
  { id: "quickbooks", labelKey: "integrationsPage.quickbooks" },
  { id: "stripe", labelKey: "integrationsPage.payments" },
];

interface IntegrationsPageProps {
  initialTab?: TabId;
}

export default function IntegrationsPage({
  initialTab = "webhooks",
}: IntegrationsPageProps) {
  const { t } = useTranslation("integrations");
  // Deep-link support: the URL hash selects the initial tab — and sub-tab — on
  // load, e.g. /integrations#psa or /integrations#huntress. Used by the legacy
  // /settings/integrations/* routes, which now 301-redirect here with a hash. A
  // sub-tab hash (e.g. #huntress) also activates its parent tab.
  const initialFromHash: {
    tab: TabId;
    securitySub?: SecuritySubTab;
    identitySub?: IdentitySubTab;
    distributorSub?: DistributorSubTab;
    accountingSub?: AccountingSubTab;
  } = (() => {
    if (typeof window === "undefined") return { tab: initialTab };
    const hash = window.location.hash.replace(/^#/, "");
    if (tabs.some((t) => t.id === hash)) return { tab: hash as TabId };
    if (securitySubTabs.some((s) => s.id === hash))
      return { tab: "security", securitySub: hash as SecuritySubTab };
    if (identitySubTabs.some((s) => s.id === hash))
      return { tab: "identity", identitySub: hash as IdentitySubTab };
    if (distributorSubTabs.some((s) => s.id === hash))
      return { tab: "distributors", distributorSub: hash as DistributorSubTab };
    if (accountingSubTabs.some((s) => s.id === hash))
      return { tab: "accounting", accountingSub: hash as AccountingSubTab };
    return { tab: initialTab };
  })();
  const [activeTab, setActiveTab] = useState<TabId>(initialFromHash.tab);
  const [securitySubTab, setSecuritySubTab] = useState<SecuritySubTab>(
    initialFromHash.securitySub ?? "sentinelone",
  );
  const [identitySubTab, setIdentitySubTab] = useState<IdentitySubTab>(
    initialFromHash.identitySub ?? "google",
  );
  const [distributorSubTab, setDistributorSubTab] = useState<DistributorSubTab>(
    initialFromHash.distributorSub ?? "pax8",
  );
  const [accountingSubTab, setAccountingSubTab] = useState<AccountingSubTab>(
    initialFromHash.accountingSub ?? "quickbooks",
  );

  // Pax8 and TD SYNNEX APIs both enforce requireScope('partner','system'). Gate
  // the Distributors tab on the JWT scope (never on useOrgStore().partners.length,
  // which is empty for real partner users — a known broken anti-pattern here) so
  // org-scope users get a clear message instead of 403 errors. getJwtClaims returns
  // null scope on a missing/undecodable token, so only a confirmed 'organization'
  // scope is blocked; everything else falls through to the server's own check.
  const isOrgScoped = getJwtClaims().scope === "organization";

  return (
    <div className="space-y-6">
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

      {/* Top-level tabs */}
      <div className="flex flex-wrap gap-3">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const isActive = tab.id === activeTab;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
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
                onClick={() => setSecuritySubTab(sub.id)}
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
                onClick={() => setIdentitySubTab(sub.id)}
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
                onClick={() => setDistributorSubTab(sub.id)}
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
                onClick={() => setAccountingSubTab(sub.id)}
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
        <M365Integration />
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
