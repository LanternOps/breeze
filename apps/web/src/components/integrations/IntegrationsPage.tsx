import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  Activity,
  BookOpen,
  Boxes,
  Building2,
  DollarSign,
  HardDrive,
  MessageSquare,
  Network,
  Plug,
  Shield,
  Webhook,
} from "lucide-react";
import { DOCS_BASE_URL } from "@breeze/shared";
import { PageHeader } from "../shared/PageHeader";
import WebhooksPage from "../webhooks/WebhooksPage";
import CommunicationIntegrations from "./CommunicationIntegrations";
import PsaConnectionsPage from "../psa/PsaConnectionsPage";
import SecurityIntegration from "./SecurityIntegration";
import HuntressIntegration from "./HuntressIntegration";
import MonitoringIntegration from "./MonitoringIntegration";
import GoogleWorkspaceIntegration from "./GoogleWorkspaceIntegration";
import M365TenantSection from "./M365TenantSection";
import {
  M365_CUSTOMER_GRAPH_READ_CALLBACK_RESULTS,
  type M365CustomerGraphReadCallbackResult,
} from "./M365CustomerGraphReadCard";
import {
  M365_CUSTOMER_GRAPH_ACTIONS_CALLBACK_RESULTS,
  type M365CustomerGraphActionsCallbackResult,
} from "./M365CustomerGraphActionsCard";
import Pax8Integration from "./Pax8Integration";
import TdSynnexCatalogPanel from "../settings/TdSynnexCatalogPanel";
import TdSynnexEcExpressPanel from "../settings/TdSynnexEcExpressPanel";
import TdSynnexSftpPanel from "../settings/TdSynnexSftpPanel";
import AccountingConnectionPanel from "./AccountingConnectionPanel";
import AccountingProviderCards from "./AccountingProviderCards";
import StripePaymentsIntegration from "./StripePaymentsIntegration";
import UnifiIntegration from "./UnifiIntegration";
import BackupProvidersIntegration from "./BackupProvidersIntegration";
import AccessDenied from "../shared/AccessDenied";
import { usePermissions } from "../../lib/permissions";
import { getJwtClaims } from "../../lib/authScope";
import { useHelpStore, rebaseDocsUrl } from "../../stores/helpStore";
import { useOrgStore } from "../../stores/orgStore";
import { useTranslation } from "react-i18next";
import "@/lib/i18n";
import {
  ACCOUNTING_PROVIDER_IDS,
  isAccountingProviderId,
  isAccountingProviderVisible,
  type AccountingProviderId,
  type AccountingProvidersResponse,
} from "../../lib/accountingProviders";

type TabId =
  | "webhooks"
  | "notifications"
  | "psa"
  | "security"
  | "monitoring"
  | "cloud-tenants"
  | "distributors"
  | "accounting"
  | "unifi"
  | "backup";
type SecuritySubTab = "sentinelone" | "huntress";
type CloudTenantsSubTab = "google" | "m365";
type DistributorSubTab = "pax8" | "tdsynnex" | "tdsynnex-ec" | "tdsynnex-sftp";
type AccountingSubTab = AccountingProviderId | "stripe";

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
  {
    id: "cloud-tenants",
    labelKey: "integrationsPage.cloudTenants",
    icon: Building2,
  },
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
  { id: "backup", labelKey: "integrationsPage.backup", icon: HardDrive },
];

const securitySubTabs: { id: SecuritySubTab; labelKey: string }[] = [
  { id: "sentinelone", labelKey: "integrationsPage.sentinelone" },
  { id: "huntress", labelKey: "integrationsPage.huntress" },
];

const cloudTenantsSubTabs: { id: CloudTenantsSubTab; labelKey: string }[] = [
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

// Every accounting provider is listed statically so `#xero` / `#xero-items`
// route to the Accounting tab. Whether a provider's panel actually renders is
// decided by GET /accounting/providers (configured providers, plus the connected
// one — see isAccountingProviderVisible), never by the hash alone. Providers
// are picked from AccountingProviderCards; only the Stripe payments entry
// renders as a sub-tab button.
const accountingSubTabs: AccountingSubTab[] = [...ACCOUNTING_PROVIDER_IDS, "stripe"];

// Each top-level tab links to its own dedicated help-doc page. Opening the doc
// goes through the shared help panel (useHelpStore) so it respects the
// self-hosted PUBLIC_DOCS_URL rebasing and the trusted-origin gate.
const tabDocsPaths: Record<TabId, string> = {
  webhooks: "/features/webhooks/",
  notifications: "/features/notifications/",
  psa: "/features/psa-integrations/",
  security: "/features/edr-integrations/",
  monitoring: "/features/monitoring-integrations/",
  // The docs page keeps its original slug; only the tab was renamed.
  "cloud-tenants": "/features/identity-integrations/",
  distributors: "/features/distributor-integrations/",
  accounting: "/features/accounting-integrations/",
  unifi: "/features/unifi-integration/",
  backup: "/features/backup-provider-integrations/",
};

// Parse the URL hash into the tab — and, for a sub-tab hash like #huntress, its
// parent tab + sub-tab. Shared by the initial mount state and the hashchange
// listener so deep links, back/forward, and in-app tab clicks all agree. The
// legacy /settings/integrations/* routes 301-redirect here with such a hash.
function parseHash(fallbackTab: TabId): {
  tab: TabId;
  securitySub?: SecuritySubTab;
  cloudTenantsSub?: CloudTenantsSubTab;
  distributorSub?: DistributorSubTab;
  accountingSub?: AccountingSubTab;
  customerGraphReadResult?: M365CustomerGraphReadCallbackResult;
  consumeCustomerGraphReadResult?: boolean;
  customerGraphActionsResult?: M365CustomerGraphActionsCallbackResult;
  consumeCustomerGraphActionsResult?: boolean;
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
      tab: "cloud-tenants",
      cloudTenantsSub: "m365",
      customerGraphReadResult,
      consumeCustomerGraphReadResult: true,
    };
  }
  const customerGraphActionsPrefix = "m365/customer-graph-actions/";
  if (hash.startsWith(customerGraphActionsPrefix)) {
    const candidate = hash.slice(customerGraphActionsPrefix.length);
    const customerGraphActionsResult = M365_CUSTOMER_GRAPH_ACTIONS_CALLBACK_RESULTS.find(
      (result) => result === candidate,
    );
    return {
      tab: "cloud-tenants",
      cloudTenantsSub: "m365",
      customerGraphActionsResult,
      consumeCustomerGraphActionsResult: true,
    };
  }
  if (tabs.some((t) => t.id === hash)) return { tab: hash as TabId };
  // Legacy alias: this tab was "Identity" (#identity) before it was renamed to
  // Cloud tenants. Bookmarks and docs links still carry the old hash.
  if (hash === "identity") return { tab: "cloud-tenants" };
  if (securitySubTabs.some((s) => s.id === hash))
    return { tab: "security", securitySub: hash as SecuritySubTab };
  if (cloudTenantsSubTabs.some((s) => s.id === hash))
    return { tab: "cloud-tenants", cloudTenantsSub: hash as CloudTenantsSubTab };
  if (distributorSubTabs.some((s) => s.id === hash))
    return { tab: "distributors", distributorSub: hash as DistributorSubTab };
  if (accountingSubTabs.some((s) => s === hash))
    return { tab: "accounting", accountingSub: hash as AccountingSubTab };
  // Panels nested INSIDE an accounting sub-tab own their own hash segment,
  // namespaced with the sub-tab id they live under — the QuickBooks mapping
  // workbench writes `#quickbooks-customers` / `#quickbooks-items`. There is
  // one hash owner (this page), so those must route back to the owning tab +
  // sub-tab; treating them as unknown made the page fall back to Webhooks the
  // moment the workbench's Items tab was clicked, leaving it unreachable.
  // Anything nested deeper keeps this convention: `<subTabId>-<nested...>`.
  const nestedAccountingSub = accountingSubTabs.find((s) => hash.startsWith(`${s}-`));
  if (nestedAccountingSub)
    return { tab: "accounting", accountingSub: nestedAccountingSub };
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
  const [cloudTenantsSubTab, setCloudTenantsSubTab] = useState<CloudTenantsSubTab>("google");
  const [distributorSubTab, setDistributorSubTab] = useState<DistributorSubTab>("pax8");
  const [accountingSubTab, setAccountingSubTab] = useState<AccountingSubTab>("quickbooks");
  // GET /accounting/providers as loaded by AccountingProviderCards: undefined
  // while loading, null when it could not be loaded.
  const [accountingProviders, setAccountingProviders] = useState<
    AccountingProvidersResponse | null | undefined
  >(undefined);
  // Bumped after a connection change (disconnect, tenant pick) so the cards —
  // and the auto-pick effect below — see fresh data without a full reload.
  const [accountingProvidersRefreshKey, setAccountingProvidersRefreshKey] = useState(0);
  // True once the accounting sub-tab was chosen explicitly (a hash naming a
  // provider, the OAuth `?accounting=` return param, or a card/sub-tab click).
  // While false, a bare `#accounting` hash lets the auto-pick effect below
  // choose a provider once the provider list loads.
  const accountingSubTabExplicitRef = useRef(false);
  // Bumped every time applyHash lands on a bare `#accounting` hash (mount,
  // hashchange, back/forward), so the auto-pick effect below re-runs even when
  // `accountingProviders` hasn't changed — e.g. an explicit `#quickbooks`
  // selection followed by navigating back to bare `#accounting` must re-pick,
  // not leave the stale explicit panel showing.
  const [accountingAutoPickTrigger, setAccountingAutoPickTrigger] = useState(0);
  const [customerGraphReadCallback, setCustomerGraphReadCallback] = useState<{
    result: M365CustomerGraphReadCallbackResult | null;
    refreshKey: number;
    orgId: string | null;
  }>({ result: null, refreshKey: 0, orgId: null });
  const [customerGraphActionsCallback, setCustomerGraphActionsCallback] = useState<{
    result: M365CustomerGraphActionsCallbackResult | null;
    refreshKey: number;
    orgId: string | null;
  }>({ result: null, refreshKey: 0, orgId: null });

  // Keep the latest org id available to applyHash below without making it a
  // dependency of that effect (see the comment there). useRef's initial value
  // is set synchronously during render, so it's already correct for the
  // very-first-mount call to applyHash.
  const callbackOrgIdRef = useRef(callbackOrgId);
  useIsomorphicLayoutEffect(() => {
    callbackOrgIdRef.current = callbackOrgId;
  }, [callbackOrgId]);

  // Adopt the hash post-commit / pre-paint (no visible flash of the fallback
  // tab), and keep following it for back/forward and externally-changed hashes.
  // The click handlers below set state directly, so this only handles hash
  // changes we didn't make ourselves.
  //
  // #6684: on a real return from Microsoft, this runs on the very first
  // render of a cold page load — the org store hasn't hydrated yet, so
  // callbackOrgId is still null here. The hash is consumed (and rewritten to
  // #m365) immediately regardless, so it must NOT be in this effect's
  // dependency array: if it were, callbackOrgId resolving a tick later would
  // re-run applyHash against the now-stripped hash, take the "no result in
  // the hash" else-branch, and wipe the just-captured result before it ever
  // got a chance to match the resolved org id. A separate effect below
  // backfills orgId once it's known, without re-parsing the hash.
  useIsomorphicLayoutEffect(() => {
    const applyHash = () => {
      const parsed = parseHash(initialTab);
      setActiveTab(parsed.tab);
      if (parsed.securitySub) setSecuritySubTab(parsed.securitySub);
      if (parsed.cloudTenantsSub) setCloudTenantsSubTab(parsed.cloudTenantsSub);
      if (parsed.distributorSub) setDistributorSubTab(parsed.distributorSub);
      if (parsed.accountingSub) {
        setAccountingSubTab(parsed.accountingSub);
        accountingSubTabExplicitRef.current = true;
      } else if (parsed.tab === "accounting") {
        // The accounting OAuth callback returns to
        // /integrations?accounting=<provider>&…#accounting. Open that
        // provider's panel so it can report the result (and strip the params).
        const returning = new URLSearchParams(window.location.search).get("accounting");
        if (returning && isAccountingProviderId(returning)) {
          setAccountingSubTab(returning);
          accountingSubTabExplicitRef.current = true;
        } else {
          // A bare #accounting hash: let the auto-pick effect below choose a
          // provider once the list loads, rather than always defaulting to
          // whatever provider was last selected (or QuickBooks). Bump the
          // trigger so the effect re-runs even if `accountingProviders` itself
          // hasn't changed since the last pick (e.g. back/forward navigation
          // from an explicit `#quickbooks` to bare `#accounting`).
          accountingSubTabExplicitRef.current = false;
          setAccountingAutoPickTrigger((n) => n + 1);
        }
      }
      if (parsed.consumeCustomerGraphReadResult) {
        setCustomerGraphReadCallback((current) => ({
          result: parsed.customerGraphReadResult ?? null,
          refreshKey: current.refreshKey + 1,
          orgId: callbackOrgIdRef.current,
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
      if (parsed.consumeCustomerGraphActionsResult) {
        setCustomerGraphActionsCallback((current) => ({
          result: parsed.customerGraphActionsResult ?? null,
          refreshKey: current.refreshKey + 1,
          orgId: callbackOrgIdRef.current,
        }));
        window.history.replaceState(
          window.history.state,
          "",
          `${window.location.pathname}${window.location.search}#m365`,
        );
      } else {
        setCustomerGraphActionsCallback((current) =>
          current.result === null && current.orgId === null
            ? current
            : { ...current, result: null, orgId: null },
        );
      }
    };
    applyHash();
    window.addEventListener("hashchange", applyHash);
    return () => window.removeEventListener("hashchange", applyHash);
  }, [initialTab]);

  // Backfill a captured-but-unscoped callback result once the org id resolves
  // (cold load: the result was captured from the hash before the org store
  // hydrated, so it went in with orgId: null). This never re-parses the hash,
  // so it can't clobber a result the hashchange handler above just captured.
  useEffect(() => {
    if (callbackOrgId === null) return;
    setCustomerGraphReadCallback((current) =>
      current.result !== null && current.orgId === null
        ? { ...current, orgId: callbackOrgId }
        : current,
    );
    setCustomerGraphActionsCallback((current) =>
      current.result !== null && current.orgId === null
        ? { ...current, orgId: callbackOrgId }
        : current,
    );
  }, [callbackOrgId]);

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

  // The accounting provider routes require the dedicated
  // `accounting:read` capability. Gate the provider cards and every provider
  // panel on it so a caller without the grant gets the standard
  // permission-denied state instead of a screen of 403s. The Stripe payments
  // sub-tab is a separate integration with its own routes and is NOT gated on
  // the accounting capability. UX only — every route re-checks server-side.
  const canReadAccounting = usePermissions().can("accounting", "read");
  const selectedAccountingProvider = isAccountingProviderId(accountingSubTab)
    ? accountingSubTab
    : null;
  // A provider's panel renders only when it is visible — configured on this
  // instance, or holding the partner's active connection (so a connection whose
  // provider config was removed can still be disconnected). This is the same
  // predicate that decides which cards show, so a hand-typed `#xero` on an
  // instance without Xero configured is not a way into a dead panel.
  const selectedProviderVisible = !!selectedAccountingProvider
    && !!accountingProviders?.data.some(
      (p) => p.id === selectedAccountingProvider
        && isAccountingProviderVisible(p, accountingProviders.activeConnection),
    );
  const selectAccountingSubTab = (id: AccountingSubTab) => {
    accountingSubTabExplicitRef.current = true;
    if (typeof window !== "undefined") window.location.hash = id;
    setAccountingSubTab(id);
  };
  // Auto-pick a provider for a bare `#accounting` hash once the provider list
  // loads: the active connection's provider if it's visible, else the first
  // visible provider in `data` order, else nothing. Never overrides an
  // explicit hash/param/click, and never writes to the URL hash itself —
  // `#accounting` stays as-is. Depends on
  // `accountingAutoPickTrigger` (not just `accountingProviders`) so landing on
  // a bare `#accounting` hash re-applies the pick even when the provider list
  // is unchanged from the last time it ran (back/forward navigation away from
  // an explicit selection) — and intentionally re-applies whenever the
  // provider list itself refreshes while the selection is still not explicit
  // (e.g. after a connect/disconnect bumps `accountingProvidersRefreshKey`).
  useEffect(() => {
    if (accountingSubTabExplicitRef.current) return;
    if (!accountingProviders) return;
    const active = accountingProviders.activeConnection;
    const activeVisible = active
      && accountingProviders.data.find(
        (p) => p.id === active.provider && isAccountingProviderVisible(p, active),
      );
    const pick = activeVisible
      ? active.provider
      : accountingProviders.data.find((p) => isAccountingProviderVisible(p, active))?.id;
    if (pick) setAccountingSubTab(pick);
  }, [accountingProviders, accountingAutoPickTrigger]);
  const visibleCustomerGraphReadResult = callbackOrgId !== null
    && customerGraphReadCallback.orgId === callbackOrgId
    ? customerGraphReadCallback.result
    : null;
  const visibleCustomerGraphActionsResult = callbackOrgId !== null
    && customerGraphActionsCallback.orgId === callbackOrgId
    ? customerGraphActionsCallback.result
    : null;

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("integrationsPage.integrations")}
        description={t(
          "integrationsPage.manageAllConnectionsAndKeepAutomationWorkflowsHealthy",
        )}
        actions={
          <button
            type="button"
            onClick={openTabDocs}
            data-testid="integrations-docs-link"
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm text-muted-foreground transition hover:text-foreground"
          >
            <BookOpen className="h-4 w-4" />
            {t("integrationsPage.viewNameDocumentation", {
              name: activeTabLabel,
            })}
          </button>
        }
      />

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

      {/* Cloud tenants sub-tabs */}
      {activeTab === "cloud-tenants" && (
        <div className="flex gap-2">
          {cloudTenantsSubTabs.map((sub) => {
            const isActive = sub.id === cloudTenantsSubTab;
            return (
              <button
                key={sub.id}
                type="button"
                onClick={() => {
                  if (typeof window !== "undefined")
                    window.location.hash = sub.id;
                  setCloudTenantsSubTab(sub.id);
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

      {/* Accounting sub-navigation (hidden for org-scope users, who can't use
          these APIs): one card per visible accounting provider, plus the
          separate Stripe payments sub-tab. */}
      {activeTab === "accounting" && !isOrgScoped && (
        <div className="space-y-3">
          {canReadAccounting && (
            <AccountingProviderCards
              selected={selectedAccountingProvider}
              onSelect={selectAccountingSubTab}
              onLoaded={setAccountingProviders}
              refreshKey={accountingProvidersRefreshKey}
            />
          )}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => selectAccountingSubTab("stripe")}
              className={`rounded-md border px-3 py-1.5 text-sm font-medium transition ${
                accountingSubTab === "stripe"
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border bg-background text-muted-foreground hover:text-foreground"
              }`}
            >
              {t("integrationsPage.payments")}
            </button>
          </div>
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
      {activeTab === "cloud-tenants" && cloudTenantsSubTab === "google" && (
        <GoogleWorkspaceIntegration />
      )}
      {activeTab === "cloud-tenants" && cloudTenantsSubTab === "m365" && (
        <M365TenantSection
          readCallbackResult={visibleCustomerGraphReadResult}
          readCallbackRefreshKey={customerGraphReadCallback.refreshKey}
          actionsCallbackResult={visibleCustomerGraphActionsResult}
          actionsCallbackRefreshKey={customerGraphActionsCallback.refreshKey}
        />
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
        selectedAccountingProvider &&
        (!canReadAccounting ? (
          <AccessDenied testId={`accounting-${selectedAccountingProvider}-denied`} />
        ) : accountingProviders === null ? (
          <p
            className="py-12 text-center text-sm text-muted-foreground"
            data-testid="accounting-providers-error"
          >
            {t("accountingProviders.loadFailed")}
          </p>
        ) : selectedProviderVisible ? (
          <AccountingConnectionPanel
            key={selectedAccountingProvider}
            provider={selectedAccountingProvider}
            onConnectionChanged={() => setAccountingProvidersRefreshKey((k) => k + 1)}
          />
        ) : null)}
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
      {/* The panel owns its own partner-scope gate, so no isOrgScoped branch is
          needed here — see BackupProvidersIntegration. */}
      {activeTab === "backup" && <BackupProvidersIntegration />}
    </div>
  );
}
