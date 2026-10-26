import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { BookOpen } from "lucide-react";
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
import M365ActionsStaleManifestTable from "./M365ActionsStaleManifestTable";
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
import EdrProvidersIntegration from "./EdrProvidersIntegration";
import AccessDenied from "../shared/AccessDenied";
import ConnectionHealthPanel from "./ConnectionHealthPanel";
import ConnectionHealthSettingsCard from "./ConnectionHealthSettingsCard";
import { useConnectionHealth } from "./useConnectionHealth";
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
  | "overview"
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
type SecuritySubTab = "sentinelone" | "huntress" | "edr";
type CloudTenantsSubTab = "google" | "m365";
type DistributorSubTab = "pax8" | "tdsynnex" | "tdsynnex-ec" | "tdsynnex-sftp";
type AccountingSubTab = AccountingProviderId | "stripe";

// Order is the navigation order: health first, then the integrations an MSP
// lives in day to day, then plumbing.
const tabs: { id: TabId; labelKey: string }[] = [
  { id: "overview", labelKey: "connectionHealthPanel.title" },
  { id: "psa", labelKey: "integrationsPage.psa" },
  { id: "security", labelKey: "integrationsPage.security" },
  { id: "cloud-tenants", labelKey: "integrationsPage.cloudTenants" },
  { id: "monitoring", labelKey: "integrationsPage.monitoring" },
  { id: "backup", labelKey: "integrationsPage.backup" },
  { id: "unifi", labelKey: "integrationsPage.unifi" },
  { id: "distributors", labelKey: "integrationsPage.distributors" },
  { id: "accounting", labelKey: "integrationsPage.accounting" },
  { id: "notifications", labelKey: "integrationsPage.notifications" },
  { id: "webhooks", labelKey: "integrationsPage.webhooks" },
];

// Who a tab's settings apply to, shown above its panel: one organization (the
// one in the scope bar) or every organization under the partner.
const tabScope: Record<TabId, "org" | "partner" | null> = {
  overview: null,
  webhooks: "org",
  notifications: "org",
  psa: "org",
  monitoring: "org",
  "cloud-tenants": "org",
  security: "partner",
  distributors: "partner",
  accounting: "partner",
  unifi: "partner",
  backup: "partner",
};

const securitySubTabs: { id: SecuritySubTab; labelKey: string }[] = [
  { id: "sentinelone", labelKey: "integrationsPage.sentinelone" },
  { id: "huntress", labelKey: "integrationsPage.huntress" },
  { id: "edr", labelKey: "integrationsPage.edrProviders" },
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
  overview: "/features/integrations/",
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
type ParsedHash = {
  tab: TabId;
  securitySub?: SecuritySubTab;
  cloudTenantsSub?: CloudTenantsSubTab;
  distributorSub?: DistributorSubTab;
  accountingSub?: AccountingSubTab;
  customerGraphReadResult?: M365CustomerGraphReadCallbackResult;
  consumeCustomerGraphReadResult?: boolean;
  customerGraphActionsResult?: M365CustomerGraphActionsCallbackResult;
  consumeCustomerGraphActionsResult?: boolean;
};

function parseHash(fallbackTab: TabId): ParsedHash {
  if (typeof window === "undefined") return { tab: fallbackTab };
  return parseHashValue(window.location.hash.replace(/^#/, ""), fallbackTab);
}

function parseHashValue(hash: string, fallbackTab: TabId): ParsedHash {
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
  // The partner re-consent table writes `#m365-reconsent-<orgId>` for its
  // selected row; it lives inside the Microsoft 365 tenant section.
  if (hash.startsWith("m365-reconsent-"))
    return { tab: "cloud-tenants", cloudTenantsSub: "m365" };
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

// One entry per destination in the page's navigation. Tabs with sub-tabs list
// each sub-tab as its own entry under the tab's label, so every integration is
// one click away and can carry its own status. Accounting and Stripe payments
// share the Accounting tab in state but are separate entries: payments is not
// bookkeeping.
type NavItem = {
  /** Hash written on select, and the entry's identity for status counts. */
  hash: string;
  labelKey: string;
  tab: TabId;
};

function navItemsFor(tab: TabId, isOrgScoped: boolean): NavItem[] {
  switch (tab) {
    case "security":
      return securitySubTabs.map((s) => ({ hash: s.id, labelKey: s.labelKey, tab }));
    case "cloud-tenants":
      return cloudTenantsSubTabs.map((s) => ({ hash: s.id, labelKey: s.labelKey, tab }));
    case "distributors":
      // Org scope can't use these APIs; one entry leads to the explanation.
      return isOrgScoped
        ? [{ hash: tab, labelKey: "integrationsPage.distributors", tab }]
        : distributorSubTabs.map((s) => ({ hash: s.id, labelKey: s.labelKey, tab }));
    case "accounting":
      return isOrgScoped
        ? [{ hash: tab, labelKey: "integrationsPage.accounting", tab }]
        : [
            { hash: "accounting", labelKey: "integrationsPage.accounting", tab },
            { hash: "stripe", labelKey: "integrationsPage.payments", tab },
          ];
    default:
      return [{ hash: tab, labelKey: tabs.find((t) => t.id === tab)?.labelKey ?? tab, tab }];
  }
}

/**
 * The nav entry an incident's fix link lands on, or null when the fix lives
 * outside this page. Uses the same parser as the page's own hash routing, so a
 * badge can never point somewhere the Fix link doesn't go.
 */
function navHashForFixHref(fixHref: string): string | null {
  const match = /^\/integrations\/?#(.+)$/.exec(fixHref);
  if (!match) return null;
  const parsed = parseHashValue(match[1], "overview");
  switch (parsed.tab) {
    case "security":
      return parsed.securitySub ?? securitySubTabs[0].id;
    case "cloud-tenants":
      return parsed.cloudTenantsSub ?? cloudTenantsSubTabs[0].id;
    case "distributors":
      return parsed.distributorSub ?? distributorSubTabs[0].id;
    case "accounting":
      return parsed.accountingSub === "stripe" ? "stripe" : "accounting";
    case "overview":
      return null;
    default:
      return parsed.tab;
  }
}

type NavStatus = { count: number; permanent: boolean };

// useLayoutEffect would warn during SSR (it is a no-op there); useEffect is the
// server-safe stand-in. On the client we want the layout variant so the hash is
// adopted before paint.
const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

interface IntegrationsPageProps {
  initialTab?: TabId;
}

export default function IntegrationsPage({
  initialTab = "overview",
}: IntegrationsPageProps) {
  const { t } = useTranslation("integrations");
  const currentOrgId = useOrgStore((value) => value.currentOrgId);
  const claims = getJwtClaims();
  const callbackOrgId = currentOrgId
    || (claims.scope === "organization" ? claims.orgId ?? null : null);
  // #9318: name the org every card below configures. Same id the cards and the
  // save calls use (callbackOrgId), so the label cannot disagree with the write
  // target.
  const scopeOrgName = useOrgStore((value) => {
    const organizations = (value as { organizations?: { id: string; name: string }[] }).organizations;
    return callbackOrgId && Array.isArray(organizations)
      ? organizations.find((org) => org.id === callbackOrgId)?.name ?? null
      : null;
  });
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

  // Webhooks require `webhooks:read`. Without it the tab is not listed, and a
  // page opened without a hash starts on the first tab the user can see rather
  // than on Webhooks. A deep link to #webhooks still opens the webhooks panel,
  // which renders its own access-denied state. While grants are loading
  // (permissions undefined) the default is left alone, so nothing flashes.
  // UX only — every webhook route re-checks server-side.
  const { permissions: grants, can } = usePermissions();
  const canReadWebhooks = can("webhooks", "read");
  const webhooksDenied = grants !== undefined && !canReadWebhooks;
  // Pax8 and TD SYNNEX APIs both enforce requireScope('partner','system'). Gate
  // the Distributors tab on the JWT scope (never on useOrgStore().partners.length,
  // which is empty for real partner users — a known broken anti-pattern here) so
  // org-scope users get a clear message instead of 403 errors. getJwtClaims returns
  // null scope on a missing/undecodable token, so only a confirmed 'organization'
  // scope is blocked; everything else falls through to the server's own check.
  // The connection-health overview is partner/system only for the same reason.
  const isOrgScoped = claims.scope === "organization";
  const visibleTabs = tabs.filter(
    (tab) =>
      (tab.id !== "webhooks" || canReadWebhooks)
      && (tab.id !== "overview" || !isOrgScoped),
  );
  // True when the current hash names #webhooks explicitly (a deep link).
  const webhooksExplicitRef = useRef(false);

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
      webhooksExplicitRef.current = window.location.hash.replace(/^#/, "") === "webhooks";
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

  // Leave a default tab the user can't see (Webhooks without `webhooks:read`,
  // the health overview in org scope) for the first visible tab. Never
  // overrides an explicit #webhooks link and never writes the hash. The update
  // is functional because on mount this runs in the same commit as applyHash
  // above, so `activeTab` from this render can still be the SSR fallback.
  const firstVisibleTab = visibleTabs[0]?.id ?? initialTab;
  useIsomorphicLayoutEffect(() => {
    setActiveTab((current) => {
      if (current === "overview" && isOrgScoped) return firstVisibleTab;
      if (current === "webhooks" && webhooksDenied && !webhooksExplicitRef.current) {
        return firstVisibleTab;
      }
      return current;
    });
  }, [activeTab, webhooksDenied, isOrgScoped, firstVisibleTab]);

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

  // Select a nav entry and reflect it in the URL hash so it is deep-linkable /
  // shareable and survives a reload. State is set directly too: re-selecting
  // the current hash fires no hashchange.
  const selectNavItem = (item: NavItem) => {
    if (typeof window !== "undefined") window.location.hash = item.hash;
    setActiveTab(item.tab);
    if (item.tab === "security") setSecuritySubTab(item.hash as SecuritySubTab);
    if (item.tab === "cloud-tenants") setCloudTenantsSubTab(item.hash as CloudTenantsSubTab);
    if (item.tab === "distributors" && item.hash !== "distributors") {
      setDistributorSubTab(item.hash as DistributorSubTab);
    }
    if (item.hash === "stripe") {
      accountingSubTabExplicitRef.current = true;
      setAccountingSubTab("stripe");
    } else if (item.hash === "accounting" && accountingSubTab === "stripe") {
      // Leaving payments for bookkeeping: let the auto-pick choose the
      // provider, exactly as a bare #accounting deep link does.
      accountingSubTabExplicitRef.current = false;
      setAccountingSubTab("quickbooks");
      setAccountingAutoPickTrigger((n) => n + 1);
    }
  };

  const activeSubTab: Partial<Record<TabId, string>> = {
    security: securitySubTab,
    "cloud-tenants": cloudTenantsSubTab,
    distributors: isOrgScoped ? "distributors" : distributorSubTab,
    accounting: isOrgScoped ? "accounting" : accountingSubTab === "stripe" ? "stripe" : "accounting",
  };
  const activeNavHash = activeSubTab[activeTab] ?? activeTab;
  const navSections = visibleTabs.map((tab) => ({
    tab,
    items: navItemsFor(tab.id, isOrgScoped),
  }));
  const navItems = navSections.flatMap((section) => section.items);

  // Open incidents per nav entry, from the same fix links the overview's Fix
  // buttons use. Incidents fixed outside this page only count on the overview.
  const health = useConnectionHealth(!isOrgScoped);
  const navStatus = new Map<string, NavStatus>();
  if (health.state.kind === "ready") {
    for (const incident of health.state.open.data) {
      const hash = navHashForFixHref(incident.fixHref);
      for (const key of hash ? [hash, "overview"] : ["overview"]) {
        const prev = navStatus.get(key) ?? { count: 0, permanent: false };
        navStatus.set(key, {
          count: prev.count + 1,
          permanent: prev.permanent || incident.severity === "permanent",
        });
      }
    }
  }
  const organizations = useOrgStore(
    (value) => (value as { organizations?: { id: string; name: string }[] }).organizations,
  );
  const resolveOrgName = (orgId: string) =>
    (Array.isArray(organizations) ? organizations.find((org) => org.id === orgId)?.name : null)
    ?? null;

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

  // The accounting provider routes require the dedicated
  // `accounting:read` capability. Gate the provider cards and every provider
  // panel on it so a caller without the grant gets the standard
  // permission-denied state instead of a screen of 403s. The Stripe payments
  // sub-tab is a separate integration with its own routes and is NOT gated on
  // the accounting capability. UX only — every route re-checks server-side.
  const canReadAccounting = can("accounting", "read");
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

  const navStatusBadge = (hash: string) => {
    const status = navStatus.get(hash);
    if (!status) return null;
    return (
      <span
        data-testid={`integrations-nav-status-${hash}`}
        className={`ml-auto inline-flex shrink-0 items-center gap-1 text-xs font-medium tabular-nums ${
          status.permanent
            ? "text-red-700 dark:text-red-300"
            : "text-amber-700 dark:text-amber-300"
        }`}
      >
        <span
          aria-hidden="true"
          className={`h-1.5 w-1.5 rounded-full ${status.permanent ? "bg-red-500" : "bg-amber-500"}`}
        />
        <span aria-hidden="true">{status.count}</span>
        <span className="sr-only">
          {t("integrationsPage.nav.openProblems", { count: status.count })}
        </span>
      </span>
    );
  };

  const scope = tabScope[activeTab];

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

      <div className="md:grid md:grid-cols-[13rem_minmax(0,1fr)] md:gap-8">
        {/* Below md the list collapses to a native select: every entry, with
            its open-problem count, in one control. */}
        <label className="mb-4 block md:hidden">
          <span className="sr-only">{t("integrationsPage.nav.select")}</span>
          <select
            data-testid="integrations-nav-select"
            value={activeNavHash}
            onChange={(event) => {
              const item = navItems.find((entry) => entry.hash === event.target.value);
              if (item) selectNavItem(item);
            }}
            className="h-10 w-full rounded-md border border-border bg-background px-3 text-sm"
          >
            {navSections.map(({ tab, items }) => {
              const options = items.map((item) => {
                const status = navStatus.get(item.hash);
                const label = t(/* i18n-dynamic */ item.labelKey);
                return (
                  <option key={item.hash} value={item.hash}>
                    {status
                      ? `${label} (${t("integrationsPage.nav.openProblems", { count: status.count })})`
                      : label}
                  </option>
                );
              });
              return items.length > 1 && tab.id !== "accounting" ? (
                <optgroup key={tab.id} label={t(/* i18n-dynamic */ tab.labelKey)}>
                  {options}
                </optgroup>
              ) : (
                options
              );
            })}
          </select>
        </label>

        <nav
          aria-label={t("integrationsPage.integrations")}
          data-testid="integrations-nav"
          className="hidden md:sticky md:top-4 md:block md:self-start"
        >
          <ul className="space-y-0.5 text-sm">
            {navSections.map(({ tab, items }) => {
              const links = items.map((item) => {
                const active = item.hash === activeNavHash;
                return (
                  <li key={item.hash}>
                    <a
                      href={`#${item.hash}`}
                      aria-current={active ? "page" : undefined}
                      onClick={(event) => {
                        // Set the hash ourselves: the Astro client router
                        // swallows same-page hash clicks (see samePageHashClick).
                        event.preventDefault();
                        selectNavItem(item);
                      }}
                      className={`flex items-center gap-2 rounded-md px-2.5 py-1.5 transition-colors ${
                        active
                          ? "bg-muted font-medium text-foreground"
                          : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                      }`}
                    >
                      <span className="min-w-0 truncate">{t(/* i18n-dynamic */ item.labelKey)}</span>
                      {navStatusBadge(item.hash)}
                    </a>
                  </li>
                );
              });
              // Accounting and Payments are peers, not a group under an
              // "Accounting" label that would repeat its first entry.
              if (items.length === 1 || tab.id === "accounting") return links;
              return (
                <li key={tab.id} className="pt-3">
                  <span className="block px-2.5 pb-1 text-xs font-medium text-muted-foreground">
                    {t(/* i18n-dynamic */ tab.labelKey)}
                  </span>
                  <ul className="space-y-0.5">{links}</ul>
                </li>
              );
            })}
          </ul>
        </nav>

        <div className="min-w-0 space-y-4">
          {scope === "org" && callbackOrgId && (
            <div
              data-testid="integrations-scope-bar"
              className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border bg-muted/30 px-4 py-2 text-sm"
            >
              <span className="text-muted-foreground">{t("integrationsPage.scopeBar.configuringFor")}</span>
              <strong data-testid="integrations-scope-org" className="font-semibold text-foreground">
                {scopeOrgName ?? t("integrationsPage.scopeBar.thisOrganization")}
              </strong>
              {!isOrgScoped && (
                <button
                  type="button"
                  data-testid="integrations-scope-change"
                  onClick={() => window.dispatchEvent(new CustomEvent("breeze:open-org-switcher"))}
                  className="text-primary underline-offset-2 hover:underline"
                >
                  {t("integrationsPage.scopeBar.change")}
                </button>
              )}
            </div>
          )}
          {scope === "partner" && !isOrgScoped && (
            <div
              data-testid="integrations-scope-partner"
              className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border bg-muted/30 px-4 py-2 text-sm"
            >
              <strong className="font-semibold text-foreground">
                {t("integrationsPage.scope.partnerWide")}
              </strong>
              <span className="text-muted-foreground">
                {t("integrationsPage.scope.partnerWideDetail")}
              </span>
            </div>
          )}

          {activeTab === "overview" && (
            <div className="space-y-4">
              <ConnectionHealthPanel health={health} resolveOrgName={resolveOrgName} />
              {/* W5: who besides MSP staff hears about broken connections.
                  Partner and system scope only; the API refuses org scope. */}
              <ConnectionHealthSettingsCard orgId={currentOrgId ?? null} />
            </div>
          )}
          {activeTab === "webhooks" && <WebhooksPage embedded />}
          {activeTab === "notifications" && <CommunicationIntegrations />}
          {activeTab === "psa" && <PsaConnectionsPage embedded />}
          {activeTab === "security" && securitySubTab === "sentinelone" && (
            <SecurityIntegration />
          )}
          {activeTab === "security" && securitySubTab === "huntress" && (
            <HuntressIntegration />
          )}
          {activeTab === "security" && securitySubTab === "edr" && (
            <EdrProvidersIntegration />
          )}
          {activeTab === "monitoring" && <MonitoringIntegration />}
          {activeTab === "cloud-tenants" && cloudTenantsSubTab === "google" && (
            <GoogleWorkspaceIntegration />
          )}
          {activeTab === "cloud-tenants" && cloudTenantsSubTab === "m365" && (
            <>
              <M365TenantSection
                readCallbackResult={visibleCustomerGraphReadResult}
                readCallbackRefreshKey={customerGraphReadCallback.refreshKey}
                actionsCallbackResult={visibleCustomerGraphActionsResult}
                actionsCallbackRefreshKey={customerGraphActionsCallback.refreshKey}
              />
              {/* Partner-scoped view of connections still on an older permission
                  manifest. Gated on the JWT scope (never useOrgStore partners). */}
              {claims.scope === "partner" && <M365ActionsStaleManifestTable />}
            </>
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
          {activeTab === "accounting" && !isOrgScoped && accountingSubTab !== "stripe" && canReadAccounting && (
            <AccountingProviderCards
              selected={selectedAccountingProvider}
              onSelect={selectAccountingSubTab}
              onLoaded={setAccountingProviders}
              refreshKey={accountingProvidersRefreshKey}
            />
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
      </div>
    </div>
  );
}
