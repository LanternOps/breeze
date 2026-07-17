import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Eye,
  EyeOff,
  Loader2,
  RefreshCw,
  Save,
  Shield,
  Unplug,
} from "lucide-react";
import { fetchWithAuth } from "../../stores/auth";
import { runAction, handleActionError, ActionError } from "../../lib/runAction";
import { navigateTo } from "@/lib/navigation";
import { getJwtClaims, loginPathWithNext } from "../../lib/authScope";
import { type Organization, useOrgStore } from "../../stores/orgStore";
import { formatDateTime } from "@/lib/dateTimeFormat";
import { useTranslation } from "react-i18next";
import "@/lib/i18n";

type Integration = {
  id: string;
  partnerId: string;
  name: string;
  managementUrl: string;
  isActive: boolean;
  lastSyncAt: string | null;
  lastSyncStatus: string | null;
  lastSyncError: string | null;
  createdAt: string;
  updatedAt: string;
};

type StatusSummary = {
  totalAgents: number;
  mappedDevices: number;
  infectedAgents: number;
  activeThreats: number;
  highOrCriticalThreats: number;
  pendingActions: number;
  reportedThreatCount: number;
};

// One discovered SentinelOne site (from s1_org_mappings). `provisional` rows are
// legacy name-keyed mappings awaiting the next sync to bind their real site id.
type SiteRow = {
  s1SiteId: string;
  s1SiteName: string;
  agentsCount: number;
  mappedOrgId: string | null;
  mappedOrgName: string | null;
  provisional: boolean;
};

type SaveState = {
  status: "idle" | "saving" | "saved" | "error";
  message?: string;
};
type SyncState = {
  status: "idle" | "syncing" | "done" | "error";
  message?: string;
};

const UNAUTHORIZED = () =>
  void navigateTo(loginPathWithNext(), { replace: true });

function readError(json: unknown, fallback: string): string {
  if (json && typeof json === "object" && "error" in json) {
    return String((json as { error?: unknown }).error ?? fallback);
  }
  return fallback;
}

function syncStatusBadge(
  integration: Integration | null,
  t: (key: string) => string,
) {
  if (!integration) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs text-slate-600">
        <Unplug className="h-3.5 w-3.5" />{" "}
        {t("securityIntegration.notConfigured")}
      </span>
    );
  }
  if (
    integration.lastSyncStatus === "success" ||
    integration.lastSyncStatus === "partial"
  ) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs text-emerald-700">
        <CheckCircle2 className="h-3.5 w-3.5" /> {t("common:states.active")}
      </span>
    );
  }
  if (integration.lastSyncStatus === "running") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-xs text-amber-700">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />{" "}
        {t("securityIntegration.syncing")}
      </span>
    );
  }
  if (integration.lastSyncStatus === "error") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-red-200 bg-red-50 px-3 py-1 text-xs text-red-700">
        <AlertTriangle className="h-3.5 w-3.5" />{" "}
        {t("securityIntegration.error")}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs text-slate-600">
      <Activity className="h-3.5 w-3.5" /> {t("common:states.pending")}
    </span>
  );
}

export default function SecurityIntegration() {
  const { t } = useTranslation("integrations");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [integration, setIntegration] = useState<Integration | null>(null);
  const [mappedForOrg, setMappedForOrg] = useState(true);
  // Whether the PARTNER has a SentinelOne integration connected at all. In org
  // scope an unmapped org receives `{ data: null, mapped: false, connected: true }`
  // — `data` is null (no managementUrl/token leak) but the partner IS connected,
  // which is what distinguishes "your org isn't mapped" from "not connected yet".
  const [partnerConnected, setPartnerConnected] = useState(false);
  const [summary, setSummary] = useState<StatusSummary | null>(null);
  const [sites, setSites] = useState<SiteRow[]>([]);
  const [integrationId, setIntegrationId] = useState<string | null>(null);
  const [orgOptions, setOrgOptions] = useState<Organization[]>([]);

  const [name, setName] = useState("");
  const [managementUrl, setManagementUrl] = useState("");
  const [apiToken, setApiToken] = useState("");
  const [showToken, setShowToken] = useState(false);

  const [saveState, setSaveState] = useState<SaveState>({ status: "idle" });
  const [syncState, setSyncState] = useState<SyncState>({ status: "idle" });
  const [mappingSaving, setMappingSaving] = useState<Record<string, boolean>>(
    {},
  );
  const [mappingError, setMappingError] = useState<string | null>(null);

  // SentinelOne is configured once at the partner level and shared across
  // every organization. Whether the caller can manage that partner connection
  // is a property of the TOKEN (partner scope + partnerId claim), not of the
  // org currently selected in the header — a partner admin keeps the config +
  // mapping UI while working in a single org's context. Org-scope tokens get
  // the read-only per-org views. currentOrgId is kept only as a data
  // dependency (fetchWithAuth scopes /s1/status coverage to the selected
  // org); it must never gate which UI renders.
  const currentOrgId = useOrgStore((s) => s.currentOrgId);
  const { scope: jwtScope, partnerId: jwtPartnerId } = getJwtClaims();
  const isPartnerAdmin = jwtScope === "partner" && !!jwtPartnerId;

  const unmappedCount = useMemo(
    () => sites.filter((row) => !row.mappedOrgId).length,
    [sites],
  );
  const canSave =
    name.trim().length > 0 &&
    managementUrl.trim().length > 0 &&
    (apiToken.trim().length > 0 || !!integration);

  const fetchIntegration = useCallback(async () => {
    const res = await fetchWithAuth("/s1/integration");
    const json = await res.json().catch(() => ({}));
    if (!res.ok)
      throw new Error(
        readError(json, `Failed to load integration (${res.status})`),
      );
    const data = (json as { data?: Integration | null }).data ?? null;
    const mapped = (json as { mapped?: boolean }).mapped !== false;
    // Partner is connected if we got the full integration object back, or the
    // org-unmapped branch flagged `connected: true`.
    const connected =
      data !== null || (json as { connected?: boolean }).connected === true;
    setMappedForOrg(mapped);
    setPartnerConnected(connected);
    setIntegration(data);
    if (data) {
      setName(data.name);
      setManagementUrl(data.managementUrl);
      setApiToken("");
    }
  }, []);

  const fetchStatus = useCallback(async () => {
    const res = await fetchWithAuth("/s1/status");
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error(
        `[SecurityIntegration] Status fetch failed: HTTP ${res.status}`,
      );
      return;
    }
    setMappedForOrg((json as { mapped?: boolean }).mapped !== false);
    setSummary((json as { summary?: StatusSummary }).summary ?? null);
  }, []);

  const fetchSites = useCallback(async () => {
    if (!isPartnerAdmin) return;
    const res = await fetchWithAuth("/s1/sites");
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error(
        `[SecurityIntegration] Sites fetch failed: HTTP ${res.status}`,
      );
      return;
    }
    setSites((json as { data?: SiteRow[] }).data ?? []);
    const id = (json as { integrationId?: string }).integrationId;
    if (id) setIntegrationId(id);
  }, [isPartnerAdmin]);

  const fetchOrgs = useCallback(async () => {
    if (!isPartnerAdmin) return;
    const res = await fetchWithAuth("/orgs/organizations");
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error(
        `[SecurityIntegration] Organizations fetch failed: HTTP ${res.status}`,
      );
      return;
    }
    const data = (json as { data?: Organization[] }).data;
    setOrgOptions(Array.isArray(data) ? data : []);
  }, [isPartnerAdmin]);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      await fetchIntegration();
      await Promise.all([fetchStatus(), fetchSites(), fetchOrgs()]);
    } catch (err) {
      setLoadError(
        err instanceof Error
          ? err.message
          : t("securityIntegration.failedToLoadSentinelOneIntegration"),
      );
    } finally {
      setLoading(false);
    }
  }, [fetchIntegration, fetchStatus, fetchSites, fetchOrgs]);

  useEffect(() => {
    void load();
  }, [load, currentOrgId, isPartnerAdmin]);

  const handleSave = useCallback(async () => {
    if (!isPartnerAdmin) return;
    setSaveState({ status: "saving" });
    try {
      const body: Record<string, unknown> = {
        name: name.trim(),
        managementUrl: managementUrl.trim(),
        isActive: true,
      };
      if (apiToken.trim().length > 0) body.apiToken = apiToken.trim();

      const result = await runAction<{ warning?: string }>({
        request: () =>
          fetchWithAuth("/s1/integration", {
            method: "POST",
            body: JSON.stringify(body),
          }),
        errorFallback: t(
          "securityIntegration.failedToSaveTheSentinelOneIntegration",
        ),
        successMessage: integration
          ? t("securityIntegration.integrationUpdated")
          : t("securityIntegration.integrationConnected"),
        onUnauthorized: UNAUTHORIZED,
      });
      setSaveState({
        status: "saved",
        message: result?.warning ?? t("securityIntegration.integrationSaved"),
      });
      setApiToken("");
      await load();
    } catch (err) {
      const message =
        err instanceof ActionError ? err.message : "Network error";
      setSaveState({ status: "error", message });
      handleActionError(
        err,
        t("securityIntegration.failedToSaveTheSentinelOneIntegration"),
      );
    }
  }, [isPartnerAdmin, name, managementUrl, apiToken, integration, load]);

  const handleSync = useCallback(async () => {
    if (!isPartnerAdmin) return;
    setSyncState({ status: "syncing" });
    try {
      await runAction({
        request: () =>
          fetchWithAuth("/s1/sync", {
            method: "POST",
            body: JSON.stringify({}),
          }),
        errorFallback: t(
          "securityIntegration.failedToScheduleASentinelOneSync",
        ),
        successMessage: t("securityIntegration.sentineloneSyncTriggered"),
        onUnauthorized: UNAUTHORIZED,
      });
      setSyncState({
        status: "done",
        message: t("securityIntegration.syncTriggered"),
      });
      // The sync runs in the background; re-load shortly to surface lastSync*.
      setTimeout(() => {
        void load();
      }, 3000);
    } catch (err) {
      const message =
        err instanceof ActionError ? err.message : "Network error";
      setSyncState({ status: "error", message });
      handleActionError(
        err,
        t("securityIntegration.failedToScheduleASentinelOneSync"),
      );
    }
  }, [isPartnerAdmin, load]);

  const handleMap = useCallback(
    async (s1SiteId: string, orgId: string | null) => {
      if (!integrationId) return;
      setMappingSaving((prev) => ({ ...prev, [s1SiteId]: true }));
      setMappingError(null);
      try {
        await runAction({
          request: () =>
            fetchWithAuth("/s1/organizations/map", {
              method: "POST",
              body: JSON.stringify({ integrationId, s1SiteId, orgId }),
            }),
          errorFallback: t("securityIntegration.failedToMapTheSentinelOneSite"),
          successMessage: orgId
            ? t("securityIntegration.siteMapped")
            : t("securityIntegration.siteUnmapped"),
          onUnauthorized: UNAUTHORIZED,
        });
        await fetchSites();
        await fetchStatus();
      } catch (err) {
        setMappingError(
          err instanceof ActionError ? err.message : "Network error",
        );
        handleActionError(
          err,
          t("securityIntegration.failedToMapTheSentinelOneSite"),
        );
      } finally {
        setMappingSaving((prev) => ({ ...prev, [s1SiteId]: false }));
      }
    },
    [integrationId, fetchSites, fetchStatus],
  );

  if (loading) {
    return (
      <div
        className="flex items-center justify-center py-20"
        data-testid="s1-loading"
      >
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6" data-testid="s1-panel">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Shield className="h-5 w-5" />
        </div>
        <div>
          <h1 className="text-2xl font-semibold">
            {t("securityIntegration.sentineloneIntegration")}
          </h1>
          <p className="text-sm text-muted-foreground">
            {t(
              "securityIntegration.connectOnePartnerLevelSentinelOneTenantAndMap",
            )}
          </p>
        </div>
      </div>

      {loadError && (
        <div
          className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700"
          data-testid="s1-load-error"
        >
          {loadError}
        </div>
      )}

      {/* Org scope, partner not connected: SentinelOne is partner-level. */}
      {!isPartnerAdmin && !partnerConnected && (
        <div
          className="rounded-xl border bg-card p-8 text-center shadow-xs"
          data-testid="s1-org-not-connected"
        >
          <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-lg bg-muted text-muted-foreground">
            <Unplug className="h-5 w-5" />
          </div>
          <h2 className="mt-3 text-lg font-semibold">
            {t("securityIntegration.sentineloneIsntConnectedYet")}
          </h2>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
            {/* Org-scope audience only (partner admins always see the config
                form) — so the actionable path is their MSP admin, not a scope
                switch they can't perform. */}
            {t("securityIntegration.askAdminToConnect")}
          </p>
        </div>
      )}

      {/* Org scope, partner connected but this org isn't mapped to a site. */}
      {!isPartnerAdmin && partnerConnected && !mappedForOrg && (
        <div
          className="rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800"
          data-testid="s1-org-unmapped"
        >
          {t(
            "securityIntegration.thisOrganizationIsntMappedToASentinelOneSite",
          )}
        </div>
      )}

      {/* Partner connection form */}
      {isPartnerAdmin && (
        <div
          className="rounded-xl border bg-card p-6 shadow-xs"
          data-testid="s1-connection"
        >
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold">
                {t("securityIntegration.partnerConnection")}
              </h2>
              <p className="text-sm text-muted-foreground">
                {t(
                  "securityIntegration.oneManagementURLAndAPITokenCoversEvery",
                )}
              </p>
            </div>
            {syncStatusBadge(integration, t)}
          </div>

          <div className="mt-5 grid gap-4 md:grid-cols-2">
            <div>
              <label className="mb-1 block text-sm font-medium">
                {t("common:labels.name")}
              </label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t("securityIntegration.myS1Tenant")}
                className="h-10 w-full rounded-md border bg-background px-3 text-sm outline-hidden focus:ring-2 focus:ring-primary/30"
                data-testid="s1-name"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium">
                {t("securityIntegration.managementURL")}
              </label>
              <input
                type="url"
                value={managementUrl}
                onChange={(e) => setManagementUrl(e.target.value)}
                placeholder="https://your-tenant.sentinelone.net"
                className="h-10 w-full rounded-md border bg-background px-3 text-sm outline-hidden focus:ring-2 focus:ring-primary/30"
                data-testid="s1-management-url"
              />
            </div>
            <div className="md:col-span-2">
              <label className="mb-1 block text-sm font-medium">
                {t("securityIntegration.apiToken")}
                {integration && (
                  <span className="ml-1 text-xs text-muted-foreground">
                    {t("securityIntegration.leaveBlankToKeepExisting")}
                  </span>
                )}
              </label>
              <div className="relative">
                <input
                  type={showToken ? "text" : "password"}
                  value={apiToken}
                  onChange={(e) => setApiToken(e.target.value)}
                  placeholder={
                    integration ? "••••••••••••••••" : "Paste your API token"
                  }
                  className="h-10 w-full rounded-md border bg-background px-3 pr-10 text-sm outline-hidden focus:ring-2 focus:ring-primary/30"
                  data-testid="s1-api-token"
                />
                <button
                  type="button"
                  aria-label={
                    showToken
                      ? t("securityIntegration.hideApiToken")
                      : t("securityIntegration.showApiToken")
                  }
                  onClick={() => setShowToken((value) => !value)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  {showToken ? (
                    <EyeOff className="h-4 w-4" />
                  ) : (
                    <Eye className="h-4 w-4" />
                  )}
                </button>
              </div>
            </div>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={!canSave || saveState.status === "saving"}
              className="inline-flex h-10 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
              data-testid="s1-save"
            >
              {saveState.status === "saving" ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Save className="h-4 w-4" />
              )}
              {integration
                ? t("securityIntegration.update")
                : t("securityIntegration.saveAndConnect")}
            </button>
            {integration && (
              <button
                type="button"
                onClick={() => void handleSync()}
                disabled={syncState.status === "syncing"}
                className="inline-flex h-10 items-center gap-2 rounded-md border px-3 text-sm font-medium hover:bg-muted disabled:opacity-50"
                data-testid="s1-sync"
              >
                {syncState.status === "syncing" ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="h-4 w-4" />
                )}
                {t("securityIntegration.syncNow")}
              </button>
            )}
            {saveState.message && (
              <span
                className={`text-sm ${saveState.status === "error" ? "text-red-600" : "text-emerald-600"}`}
                data-testid="s1-save-message"
              >
                {saveState.message}
              </span>
            )}
            {syncState.message && (
              <span
                className={`text-sm ${syncState.status === "error" ? "text-red-600" : "text-emerald-600"}`}
              >
                {syncState.message}
              </span>
            )}
          </div>
        </div>
      )}

      {/* Sync status + coverage (any scope, once connected) */}
      {integration && (
        <div className="grid gap-6 lg:grid-cols-[1fr_1fr]">
          <div
            className="rounded-xl border bg-card p-6 shadow-xs"
            data-testid="s1-sync-status"
          >
            <div className="flex items-center justify-between gap-4">
              <h2 className="text-lg font-semibold">
                {t("securityIntegration.syncStatus")}
              </h2>
              {syncStatusBadge(integration, t)}
            </div>
            <div className="mt-4 space-y-2 text-sm">
              <div className="flex justify-between text-muted-foreground">
                <span>{t("securityIntegration.lastSync")}</span>
                <span className="text-foreground">
                  {integration.lastSyncAt
                    ? formatDateTime(integration.lastSyncAt)
                    : "Never"}
                </span>
              </div>
              {integration.lastSyncError && (
                <div className="rounded-md border border-red-200 bg-red-50 p-3 text-xs text-red-700">
                  {integration.lastSyncError}
                </div>
              )}
            </div>
          </div>

          {summary && (
            <div
              className="rounded-xl border bg-card p-6 shadow-xs"
              data-testid="s1-coverage"
            >
              <h2 className="text-lg font-semibold">
                {t("securityIntegration.coverage")}
              </h2>
              <div className="mt-4 grid grid-cols-2 gap-4">
                <Metric
                  label={t("securityIntegration.s1Agents")}
                  value={summary.totalAgents ?? 0}
                />
                <Metric
                  label={t("securityIntegration.mappedDevices")}
                  value={summary.mappedDevices ?? 0}
                />
                <Metric
                  label={t("securityIntegration.infected")}
                  value={summary.infectedAgents ?? 0}
                  warn={(summary.infectedAgents ?? 0) > 0}
                  danger
                />
                <Metric
                  label={t("securityIntegration.activeThreats")}
                  value={summary.activeThreats ?? 0}
                  warn={(summary.activeThreats ?? 0) > 0}
                  danger
                />
                <Metric
                  label={t("securityIntegration.pendingActions")}
                  value={summary.pendingActions ?? 0}
                />
                <Metric
                  label="High/Critical"
                  value={summary.highOrCriticalThreats ?? 0}
                  warn={(summary.highOrCriticalThreats ?? 0) > 0}
                />
              </div>
            </div>
          )}
        </div>
      )}

      {/* Site → organization mapping (partner scope, once connected) */}
      {isPartnerAdmin && integration && (
        <div
          className="rounded-xl border bg-card p-6 shadow-xs"
          data-testid="s1-mapping"
        >
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold">
                {t("securityIntegration.siteMapping")}
              </h2>
              <p className="text-sm text-muted-foreground">
                {t(
                  "securityIntegration.mapEachSentinelOneSiteToABreezeOrganization",
                )}
              </p>
            </div>
            {unmappedCount > 0 && (
              <span className="rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-xs text-amber-700">
                {unmappedCount} {t("securityIntegration.unmapped")}
              </span>
            )}
          </div>

          {mappingError && (
            <div
              className="mt-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700"
              data-testid="s1-mapping-error"
            >
              {mappingError}
            </div>
          )}

          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead>
                <tr className="border-b text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  <th className="pb-2 pr-4">
                    {t("securityIntegration.s1Site")}
                  </th>
                  <th className="pb-2 pr-4">
                    {t("securityIntegration.agents")}
                  </th>
                  <th className="pb-2 pr-4">
                    {t("securityIntegration.breezeOrganization")}
                  </th>
                  <th className="pb-2">{t("common:labels.status")}</th>
                </tr>
              </thead>
              <tbody>
                {sites.map((site) => (
                  <tr
                    key={site.s1SiteId}
                    className="border-b last:border-0"
                    data-testid={`s1-site-${site.s1SiteId}`}
                  >
                    <td className="py-3 pr-4">
                      <div className="font-medium">
                        {site.s1SiteName || site.s1SiteId}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        ID {site.s1SiteId}
                        {site.provisional && (
                          <span className="ml-2 inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-700">
                            {t("securityIntegration.pendingSync")}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="py-3 pr-4 text-muted-foreground">
                      {site.agentsCount}
                    </td>
                    <td className="py-3 pr-4">
                      <select
                        value={site.mappedOrgId ?? ""}
                        onChange={(e) =>
                          void handleMap(site.s1SiteId, e.target.value || null)
                        }
                        disabled={mappingSaving[site.s1SiteId]}
                        className="h-9 w-full max-w-xs rounded-md border bg-background px-2 text-sm outline-hidden focus:ring-2 focus:ring-primary/30 disabled:opacity-50"
                        data-testid={`s1-site-map-${site.s1SiteId}`}
                        aria-label={`Map ${site.s1SiteName || site.s1SiteId} to a Breeze organization`}
                      >
                        <option value="">
                          {t("securityIntegration.selectOrganization")}
                        </option>
                        {orgOptions.map((org) => (
                          <option key={org.id} value={org.id}>
                            {org.name}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="py-3">
                      {mappingSaving[site.s1SiteId] ? (
                        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                      ) : site.mappedOrgId ? (
                        <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                      ) : (
                        <AlertTriangle className="h-4 w-4 text-amber-500" />
                      )}
                    </td>
                  </tr>
                ))}
                {sites.length === 0 && (
                  <tr>
                    <td
                      colSpan={4}
                      className="py-6 text-sm text-muted-foreground"
                      data-testid="s1-sites-empty"
                    >
                      {t(
                        "securityIntegration.noSentinelOneSitesDiscoveredYetSaveCredentialsAnd",
                      )}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function Metric({
  label,
  value,
  warn = false,
  danger = false,
}: {
  label: string;
  value: number;
  warn?: boolean;
  danger?: boolean;
}) {
  const color = warn ? (danger ? "text-red-600" : "text-amber-600") : "";
  return (
    <div>
      <p className={`text-2xl font-bold ${color}`}>{value}</p>
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  );
}
