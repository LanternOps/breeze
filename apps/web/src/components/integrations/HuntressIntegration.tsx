import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  Check,
  CheckCircle2,
  Copy,
  Eye,
  EyeOff,
  Loader2,
  RefreshCw,
  Save,
  Search,
  Shield,
  Unplug,
  Webhook,
  X,
} from "lucide-react";
import { getJwtClaims } from "../../lib/authScope";
import { fetchWithAuth, resolveApiOrigin } from "../../stores/auth";
import { type Organization, useOrgStore } from "../../stores/orgStore";
import { formatDateTime } from "@/lib/dateTimeFormat";
import { useTranslation } from "react-i18next";
import "@/lib/i18n";

type Integration = {
  id: string;
  partnerId: string;
  name: string;
  accountId: string | null;
  apiBaseUrl: string;
  isActive: boolean;
  lastSyncAt: string | null;
  lastSyncStatus: string | null;
  lastSyncError: string | null;
  lastSyncAgents: number | null;
  lastSyncIncidents: number | null;
  lastSyncOrgs: number | null;
  // Bumped on every status write (running/success/error), so the poll can detect
  // "this run wrote something new" without depending on lastSyncAt (which only
  // advances on success) or on having witnessed the best-effort 'running' write.
  updatedAt: string | null;
  hasWebhookSecret: boolean;
  hasAccountKey?: boolean;
};

// After triggering a sync we poll the integration row to a terminal state
// (running → success/error) rather than guessing with a single fixed timeout —
// the Huntress fetch alone is ~20s, so a 3s reload always showed stale state
// (#1736).
const SYNC_POLL_INTERVAL_MS = 2500;
const SYNC_POLL_MAX_MS = 120_000;
// Stop polling and report an error once this many *consecutive* status reads
// fail, rather than silently spinning to the deadline on a persistently broken
// endpoint.
const SYNC_POLL_MAX_FAILURES = 4;
const MAPPING_PAGE_SIZE = 25;

type StatusSummary = {
  totalAgents: number;
  mappedAgents: number;
  unmappedAgents: number;
  offlineAgents: number;
};

type IncidentSummary = {
  open: number;
  bySeverity: { severity: string | null; count: number }[];
  byStatus: { status: string | null; count: number }[];
};

type Incident = {
  id: string;
  severity: string | null;
  title: string;
  status: string;
  reportedAt: string | null;
};

type HuntressOrgMapping = {
  huntressOrgId: string;
  huntressOrgName: string | null;
  huntressOrgKey: string | null;
  huntressAccountId: string | null;
  agentsCount: number;
  incidentsCount: number;
  mappedOrgId: string | null;
  mappedOrgName: string | null;
  lastSeenAt: string | null;
};

type SaveState = {
  status: "idle" | "saving" | "saved" | "error";
  message?: string;
};
type SyncState = {
  status: "idle" | "syncing" | "done" | "warning" | "error";
  message?: string;
};

const severityStyles: Record<string, string> = {
  critical: "border-rose-200 bg-rose-50 text-rose-700",
  high: "border-orange-200 bg-orange-50 text-orange-700",
  medium: "border-amber-200 bg-amber-50 text-amber-700",
  low: "border-slate-200 bg-slate-50 text-slate-600",
};

function SeverityBadge({ severity }: { severity: string | null }) {
  const { t } = useTranslation("integrations");
  const label = severity || "unknown";
  const style = severityStyles[label.toLowerCase()] ?? severityStyles.low;
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs capitalize ${style}`}
    >
      {t(/* i18n-dynamic */ `huntressIntegration.severity.${label.toLowerCase()}`, {
        defaultValue: label,
      })}
    </span>
  );
}

function readError(json: unknown, fallback: string): string {
  if (json && typeof json === "object" && "error" in json) {
    return String((json as { error?: unknown }).error ?? fallback);
  }
  return fallback;
}

// "Synced 12 agents · 3 incidents · 26 orgs" from the persisted last-run counts.
function formatSyncResult(
  integration: Integration,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  const parts: string[] = [];
  if (typeof integration.lastSyncAgents === "number")
    parts.push(
      t("huntressIntegration.agentCount", {
        count: integration.lastSyncAgents,
      }),
    );
  if (typeof integration.lastSyncIncidents === "number")
    parts.push(
      t("huntressIntegration.incidentCount", {
        count: integration.lastSyncIncidents,
      }),
    );
  if (typeof integration.lastSyncOrgs === "number")
    parts.push(
      t("huntressIntegration.orgCount", { count: integration.lastSyncOrgs }),
    );
  return parts.length > 0
    ? t("huntressIntegration.syncedSummary", { summary: parts.join(" · ") })
    : t("huntressIntegration.syncComplete");
}

function syncStatusBadge(
  integration: Integration | null,
  t: (key: string) => string,
) {
  if (!integration) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs text-slate-600">
        <Unplug className="h-3.5 w-3.5" />{" "}
        {t("huntressIntegration.notConfigured")}
      </span>
    );
  }
  if (integration.lastSyncStatus === "success") {
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
        {t("huntressIntegration.syncing")}
      </span>
    );
  }
  if (integration.lastSyncStatus === "error") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-red-200 bg-red-50 px-3 py-1 text-xs text-red-700">
        <AlertTriangle className="h-3.5 w-3.5" />{" "}
        {t("huntressIntegration.error")}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs text-slate-600">
      <Activity className="h-3.5 w-3.5" /> {t("common:states.pending")}
    </span>
  );
}

export default function HuntressIntegration() {
  const { t } = useTranslation("integrations");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [integration, setIntegration] = useState<Integration | null>(null);
  const [mappedForOrg, setMappedForOrg] = useState(true);
  const [coverage, setCoverage] = useState<StatusSummary | null>(null);
  const [incidents, setIncidents] = useState<IncidentSummary | null>(null);
  const [recentIncidents, setRecentIncidents] = useState<Incident[]>([]);
  const [huntressOrgs, setHuntressOrgs] = useState<HuntressOrgMapping[]>([]);
  const [orgOptions, setOrgOptions] = useState<Organization[]>([]);

  const [name, setName] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [apiSecret, setApiSecret] = useState("");
  const [accountId, setAccountId] = useState("");
  const [accountKey, setAccountKey] = useState("");
  const [showAccountKey, setShowAccountKey] = useState(false);
  const [webhookSecret, setWebhookSecret] = useState("");
  const [showApiKey, setShowApiKey] = useState(false);
  const [showApiSecret, setShowApiSecret] = useState(false);
  const [showWebhookSecret, setShowWebhookSecret] = useState(false);
  // Set when Breeze generates a webhook secret for the user: copy-once banner
  // stays until the user saves (which clears webhookSecret) or dismisses it.
  const [generatedSecretNotice, setGeneratedSecretNotice] = useState(false);

  const [saveState, setSaveState] = useState<SaveState>({ status: "idle" });
  const [syncState, setSyncState] = useState<SyncState>({ status: "idle" });
  const [mappingSaving, setMappingSaving] = useState<Record<string, boolean>>(
    {},
  );
  const [mappingError, setMappingError] = useState<string | null>(null);
  const [mappingSearch, setMappingSearch] = useState("");
  const [showUnmappedOnly, setShowUnmappedOnly] = useState(false);
  const [mappingPage, setMappingPage] = useState(0);

  // Each sync run gets a monotonic token; the poll loop bails the moment a newer
  // run starts or the component unmounts, so stale polls never clobber state.
  const syncPollRef = useRef(0);
  useEffect(
    () => () => {
      syncPollRef.current = -1;
    },
    [],
  );

  const currentOrgId = useOrgStore((s) => s.currentOrgId);
  // Token-capability gate (two-layer context model): the partner configuration
  // UI is shown to any partner-scope token, regardless of which org is selected
  // in the header. currentOrgId is only used to (re)load data for the working
  // context — it must never gate which UI renders (the header selection is
  // transient and null during pre-hydration).
  const { scope: jwtScope, partnerId: jwtPartnerId } = getJwtClaims();
  const isPartnerAdmin = jwtScope === "partner" && !!jwtPartnerId;

  const hasCredentialInput =
    apiKey.trim().length > 0 || apiSecret.trim().length > 0;
  const hasCompleteCredential =
    apiKey.trim().length > 0 && apiSecret.trim().length > 0;
  const credentialPairError =
    hasCredentialInput && !hasCompleteCredential
      ? t("huntressIntegration.enterBothCredentials")
      : null;
  const canSave =
    name.trim().length > 0 &&
    (integration
      ? !hasCredentialInput || hasCompleteCredential
      : hasCompleteCredential);
  const unmappedCount = useMemo(
    () => huntressOrgs.filter((row) => !row.mappedOrgId).length,
    [huntressOrgs],
  );

  // Region-correct inbound webhook endpoint to paste into Huntress. Built from
  // the API origin (PUBLIC_API_URL, or the current page origin behind Caddy) and
  // the per-integration id used by the receiver to resolve tenancy.
  const webhookUrl = useMemo(() => {
    if (!integration) return "";
    const origin = resolveApiOrigin().replace(/\/$/, "");
    if (!origin) return "";
    return `${origin}/api/v1/huntress/webhook?integrationId=${encodeURIComponent(integration.id)}`;
  }, [integration]);

  const handleGenerateWebhookSecret = () => {
    // 32 random bytes → 64 hex chars. Surfaced once for copy; saved encrypted.
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    const secret = Array.from(bytes, (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("");
    setWebhookSecret(secret);
    setShowWebhookSecret(true);
    setGeneratedSecretNotice(true);
  };

  const filteredOrgs = useMemo(() => {
    const q = mappingSearch.trim().toLowerCase();
    return huntressOrgs.filter((row) => {
      if (showUnmappedOnly && row.mappedOrgId) return false;
      if (!q) return true;
      return (
        (row.huntressOrgName ?? "").toLowerCase().includes(q) ||
        row.huntressOrgId.toLowerCase().includes(q) ||
        (row.huntressOrgKey ?? "").toLowerCase().includes(q) ||
        (row.mappedOrgName ?? "").toLowerCase().includes(q)
      );
    });
  }, [huntressOrgs, mappingSearch, showUnmappedOnly]);

  const pageCount = Math.max(
    1,
    Math.ceil(filteredOrgs.length / MAPPING_PAGE_SIZE),
  );
  const safePage = Math.min(mappingPage, pageCount - 1);
  const pagedOrgs = useMemo(
    () =>
      filteredOrgs.slice(
        safePage * MAPPING_PAGE_SIZE,
        safePage * MAPPING_PAGE_SIZE + MAPPING_PAGE_SIZE,
      ),
    [filteredOrgs, safePage],
  );

  // Snap back to the first page whenever the result set changes underneath us.
  useEffect(() => {
    setMappingPage(0);
  }, [mappingSearch, showUnmappedOnly]);

  // Raw read used by both the initial load and the post-sync poll. Kept separate
  // from fetchIntegration so polling does NOT reset the credential/name form
  // fields the user may be editing.
  const fetchIntegrationData = useCallback(async (): Promise<{
    data: Integration | null;
    mapped: boolean;
  }> => {
    const res = await fetchWithAuth("/huntress/integration");
    const json = await res.json().catch(() => ({}));
    if (!res.ok)
      throw new Error(
        readError(json, `Failed to load integration (${res.status})`),
      );
    return {
      data: (json as { data?: Integration | null }).data ?? null,
      mapped: (json as { mapped?: boolean }).mapped !== false,
    };
  }, []);

  const fetchIntegration = useCallback(async () => {
    const { data, mapped } = await fetchIntegrationData();
    setMappedForOrg(mapped);
    setIntegration(data);
    if (data) {
      setName(data.name);
      setAccountId(data.accountId ?? "");
      setApiKey("");
      setApiSecret("");
    }
  }, [fetchIntegrationData]);

  const fetchStatus = useCallback(async () => {
    const res = await fetchWithAuth("/huntress/status");
    const json = await res.json().catch(() => ({}));
    if (!res.ok)
      throw new Error(
        readError(json, t("huntressIntegration.liveStatusError")),
      );
    setMappedForOrg((json as { mapped?: boolean }).mapped !== false);
    setCoverage((json as { coverage?: StatusSummary }).coverage ?? null);
    setIncidents((json as { incidents?: IncidentSummary }).incidents ?? null);
  }, []);

  const fetchRecentIncidents = useCallback(async () => {
    const res = await fetchWithAuth("/huntress/incidents?limit=5");
    const json = await res.json().catch(() => ({}));
    if (!res.ok)
      throw new Error(
        readError(json, t("huntressIntegration.liveStatusError")),
      );
    setRecentIncidents((json as { data?: Incident[] }).data ?? []);
  }, []);

  const fetchMappings = useCallback(async () => {
    if (!isPartnerAdmin) return;
    const [mappingRes, orgRes] = await Promise.all([
      fetchWithAuth("/huntress/organizations"),
      fetchWithAuth("/orgs/organizations"),
    ]);
    const mappingJson = await mappingRes.json().catch(() => ({}));
    if (!mappingRes.ok)
      throw new Error(
        readError(
          mappingJson,
          `Failed to load Huntress organizations (${mappingRes.status})`,
        ),
      );
    const orgJson = await orgRes.json().catch(() => ({}));
    if (!orgRes.ok)
      throw new Error(
        readError(
          orgJson,
          `Failed to load Breeze organizations (${orgRes.status})`,
        ),
      );
    setHuntressOrgs(
      (mappingJson as { data?: HuntressOrgMapping[] }).data ?? [],
    );
    setOrgOptions(
      Array.isArray((orgJson as { data?: unknown }).data)
        ? (orgJson as { data: Organization[] }).data
        : [],
    );
  }, [isPartnerAdmin]);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    setStatusError(null);
    try {
      await fetchIntegration();
      await Promise.all([
        fetchStatus().catch((err) => {
          console.error("[HuntressIntegration] Failed to load status:", err);
          setStatusError(t("huntressIntegration.liveStatusError"));
        }),
        fetchRecentIncidents().catch((err) => {
          console.error("[HuntressIntegration] Failed to load incidents:", err);
          setStatusError(t("huntressIntegration.liveStatusError"));
        }),
        fetchMappings(),
      ]);
    } catch (err) {
      setLoadError(
        err instanceof Error
          ? err.message
          : t("huntressIntegration.failedToLoadIntegration"),
      );
    } finally {
      setLoading(false);
    }
  }, [fetchIntegration, fetchMappings, fetchRecentIncidents, fetchStatus]);

  useEffect(() => {
    void load();
  }, [load, currentOrgId, isPartnerAdmin]);

  const handleSave = async () => {
    if (!isPartnerAdmin) return;
    setSaveState({ status: "saving" });
    try {
      if (credentialPairError) {
        setSaveState({ status: "error", message: credentialPairError });
        return;
      }
      const body: Record<string, unknown> = { name, isActive: true };
      if (hasCompleteCredential)
        body.apiKey = `${apiKey.trim()}:${apiSecret.trim()}`;
      if (accountId.trim()) body.accountId = accountId;
      if (accountKey.trim()) body.accountKey = accountKey.trim();
      if (webhookSecret.trim()) body.webhookSecret = webhookSecret;

      const res = await fetchWithAuth("/huntress/integration", {
        method: "POST",
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setSaveState({
          status: "error",
          message: readError(
            json,
            t("huntressIntegration.failedToSaveStatus", {
              status: res.status,
            }),
          ),
        });
        return;
      }
      setSaveState({
        status: "saved",
        message:
          (json as { syncWarning?: string }).syncWarning ??
          t("huntressIntegration.integrationSaved"),
      });
      setApiKey("");
      setApiSecret("");
      setWebhookSecret("");
      setGeneratedSecretNotice(false);
      await load();
    } catch (err) {
      setSaveState({
        status: "error",
        message:
          err instanceof Error
            ? err.message
            : t("huntressIntegration.networkError"),
      });
    }
  };

  const handleSync = async () => {
    if (!isPartnerAdmin) return;
    // updatedAt is bumped by every status write, so "row changed since we started"
    // detects this run's terminal write regardless of whether the best-effort
    // 'running' write landed and without waiting on lastSyncAt (success-only).
    const baselineUpdatedAt = integration?.updatedAt ?? null;
    const token = ++syncPollRef.current;
    setSyncState({
      status: "syncing",
      message: t("huntressIntegration.syncQueued"),
    });

    try {
      const res = await fetchWithAuth("/huntress/sync", {
        method: "POST",
        body: JSON.stringify({}),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setSyncState({
          status: "error",
          message: readError(
            json,
            t("huntressIntegration.syncFailedStatus", { status: res.status }),
          ),
        });
        return;
      }
    } catch (err) {
      setSyncState({
        status: "error",
        message:
          err instanceof Error
            ? err.message
            : t("huntressIntegration.networkError"),
      });
      return;
    }

    // Resolve `data.lastSyncStatus` to the syncState the UI should show, or null
    // if the row hasn't reached a terminal write for THIS run yet (keep polling).
    const settle = (data: Integration | null): SyncState | null => {
      if (!data) return null;
      const changed = data.updatedAt !== baselineUpdatedAt;
      if (data.lastSyncStatus === "success" && changed)
        return { status: "done", message: formatSyncResult(data, t) };
      if (data.lastSyncStatus === "error" && changed)
        return {
          status: "error",
          message: data.lastSyncError ?? t("huntressIntegration.syncFailed"),
        };
      return null;
    };

    // Poll the integration row until it reaches a terminal state, so we can
    // report the actual outcome — counts on success, the error otherwise —
    // instead of a static "Sync triggered" that proves nothing (the Huntress
    // fetch alone is ~20s, and BullMQ may retry across several attempts).
    const deadline = Date.now() + SYNC_POLL_MAX_MS;
    let consecutiveFailures = 0;
    while (Date.now() < deadline) {
      await new Promise((resolve) =>
        setTimeout(resolve, SYNC_POLL_INTERVAL_MS),
      );
      if (syncPollRef.current !== token) return; // superseded or unmounted

      let data: Integration | null;
      try {
        ({ data } = await fetchIntegrationData());
      } catch (err) {
        // Don't silently ride a broken endpoint to the deadline: log every
        // failed read and bail with a real error after several in a row.
        consecutiveFailures += 1;
        console.warn("[HuntressIntegration] Failed to poll sync status:", err);
        if (consecutiveFailures >= SYNC_POLL_MAX_FAILURES) {
          if (syncPollRef.current !== token) return;
          setSyncState({
            status: "error",
            message: t(
              "huntressIntegration.couldNotReadSyncStatusRefreshToCheck",
            ),
          });
          return;
        }
        continue;
      }
      if (syncPollRef.current !== token) return;
      consecutiveFailures = 0;

      if (data?.lastSyncStatus === "running") {
        setSyncState({
          status: "syncing",
          message: t("huntressIntegration.syncing2"),
        });
        continue;
      }
      const settled = settle(data);
      if (settled) {
        setSyncState(settled);
        await load();
        return;
      }
    }

    // Deadline hit. Do one final read so we report the truth — success/error if
    // it just landed, otherwise a neutral "still running" (NOT a green "done").
    if (syncPollRef.current !== token) return;
    try {
      const { data } = await fetchIntegrationData();
      if (syncPollRef.current !== token) return;
      const settled = settle(data);
      if (settled) {
        setSyncState(settled);
        await load();
        return;
      }
    } catch (err) {
      console.warn("[HuntressIntegration] Final sync-status read failed:", err);
    }
    if (syncPollRef.current !== token) return;
    setSyncState({
      status: "warning",
      message: t("huntressIntegration.syncIsTakingLongerThanExpectedItWill"),
    });
    await load();
  };

  const handleMap = async (huntressOrgId: string, orgId: string | null) => {
    if (!integration) return;
    setMappingSaving((prev) => ({ ...prev, [huntressOrgId]: true }));
    setMappingError(null);
    try {
      const res = await fetchWithAuth("/huntress/organizations/map", {
        method: "POST",
        body: JSON.stringify({
          integrationId: integration.id,
          huntressOrgId,
          orgId,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMappingError(
          readError(
            json,
            `Failed to map Huntress organization (${res.status})`,
          ),
        );
        return;
      }
      await fetchMappings();
      await Promise.all([fetchStatus(), fetchRecentIncidents()]).catch(() =>
        setStatusError(t("huntressIntegration.liveStatusError")),
      );
    } catch (err) {
      setMappingError(
        err instanceof Error
          ? err.message
          : t("huntressIntegration.networkError"),
      );
    } finally {
      setMappingSaving((prev) => ({ ...prev, [huntressOrgId]: false }));
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Shield className="h-5 w-5" />
        </div>
        <div>
          <h1 className="text-2xl font-semibold">
            {t("huntressIntegration.huntressIntegration")}
          </h1>
          <p className="text-sm text-muted-foreground">
            {t(
              "huntressIntegration.connectOnePartnerLevelHuntressAccountAndMap",
            )}
          </p>
        </div>
      </div>

      {loadError && (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {loadError}
        </div>
      )}
      {statusError && (
        <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-700">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{statusError}</span>
        </div>
      )}
      {!isPartnerAdmin && !integration && (
        <div className="rounded-xl border bg-card p-8 text-center shadow-xs">
          <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-lg bg-muted text-muted-foreground">
            <Unplug className="h-5 w-5" />
          </div>
          <h2 className="mt-3 text-lg font-semibold">
            {t("huntressIntegration.huntressIsntConnectedYet")}
          </h2>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
            {/* Org-scope audience only (partner admins always see the config
                form) — so the actionable path is their MSP admin, not a scope
                switch they can't perform. */}
            {t("huntressIntegration.askAdminToConnect")}
          </p>
        </div>
      )}
      {!isPartnerAdmin && integration && !mappedForOrg && (
        <div className="rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
          {t("huntressIntegration.thisBreezeOrganizationIsNotMappedToA")}
        </div>
      )}

      {isPartnerAdmin && (
        <div className="rounded-xl border bg-card p-6 shadow-xs">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold">
                {t("huntressIntegration.partnerConnection")}
              </h2>
              <p className="text-sm text-muted-foreground">
                {t("huntressIntegration.oneAPIKeyAndSecretCoversEveryHuntress")}
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
                placeholder={t("huntressIntegration.partnerHuntress")}
                className="h-10 w-full rounded-md border bg-background px-3 text-sm outline-hidden focus:ring-2 focus:ring-primary/30"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium">
                {t("huntressIntegration.accountID")}
                <span className="text-xs text-muted-foreground">
                  {t("huntressIntegration.optional")}
                </span>
              </label>
              <input
                type="text"
                value={accountId}
                onChange={(e) => setAccountId(e.target.value)}
                placeholder={t("huntressIntegration.huntressAccountID")}
                className="h-10 w-full rounded-md border bg-background px-3 text-sm outline-hidden focus:ring-2 focus:ring-primary/30"
              />
            </div>
            <SecretInput
              label={t("huntressIntegration.deploymentAccountKey")}
              hint={
                integration?.hasAccountKey
                  ? t("huntressIntegration.savedLeaveBlank")
                  : t("huntressIntegration.accountKeyRequired")
              }
              value={accountKey}
              onChange={setAccountKey}
              visible={showAccountKey}
              onToggle={() => setShowAccountKey((value) => !value)}
              placeholder={
                integration?.hasAccountKey
                  ? "************"
                  : t("huntressIntegration.accountKeyPlaceholder")
              }
            />
            <SecretInput
              label={t("huntressIntegration.apiKey")}
              value={apiKey}
              onChange={setApiKey}
              visible={showApiKey}
              onToggle={() => setShowApiKey((value) => !value)}
              placeholder={integration ? "hk_************" : "hk_..."}
            />
            <SecretInput
              label={t("huntressIntegration.apiSecret")}
              hint={
                integration
                  ? t("huntressIntegration.leaveCredentialsBlank")
                  : undefined
              }
              value={apiSecret}
              onChange={setApiSecret}
              visible={showApiSecret}
              onToggle={() => setShowApiSecret((value) => !value)}
              placeholder={integration ? "hs_************" : "hs_..."}
            />
            <div className="md:col-span-2">
              <p className="text-xs text-muted-foreground">
                {t("huntressIntegration.copyTheAPIKeyAndAPISecretFrom")}
              </p>
              {credentialPairError && (
                <p className="mt-1 text-xs text-red-600">
                  {credentialPairError}
                </p>
              )}
            </div>
            <div className="md:col-span-2">
              <div className="flex items-end gap-2">
                <div className="flex-1">
                  <SecretInput
                    label={t("huntressIntegration.webhookSecret")}
                    hint={
                      integration?.hasWebhookSecret
                        ? t("huntressIntegration.leaveBlankToKeepExisting")
                        : t("huntressIntegration.webhookSecretHint")
                    }
                    value={webhookSecret}
                    onChange={(value) => {
                      setWebhookSecret(value);
                      if (generatedSecretNotice)
                        setGeneratedSecretNotice(false);
                    }}
                    visible={showWebhookSecret}
                    onToggle={() => setShowWebhookSecret((value) => !value)}
                    placeholder={
                      integration?.hasWebhookSecret
                        ? "************"
                        : t("huntressIntegration.webhookSecretPlaceholder")
                    }
                  />
                </div>
                <button
                  type="button"
                  onClick={handleGenerateWebhookSecret}
                  className="inline-flex h-10 shrink-0 items-center gap-2 rounded-md border px-3 text-sm font-medium hover:bg-muted"
                >
                  <RefreshCw className="h-4 w-4" />{" "}
                  {t("huntressIntegration.generate")}
                </button>
              </div>
              {generatedSecretNotice && (
                <div className="mt-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
                  <p className="font-medium">
                    {t(
                      "huntressIntegration.copyThisWebhookSecretNowThenClickUpdate",
                    )}
                  </p>
                  <p className="mt-1">
                    {t(
                      "huntressIntegration.pasteTheSameValueIntoHuntresssWebhookConfiguration",
                    )}
                  </p>
                  <CopyButton
                    value={webhookSecret}
                    label={t("huntressIntegration.copySecret")}
                    className="mt-2"
                  />
                </div>
              )}
            </div>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={handleSave}
              disabled={!canSave || saveState.status === "saving"}
              className="inline-flex h-10 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
            >
              {saveState.status === "saving" ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Save className="h-4 w-4" />
              )}
              {integration
                ? t("huntressIntegration.update")
                : t("huntressIntegration.saveAndConnect")}
            </button>
            {integration && (
              <button
                type="button"
                onClick={handleSync}
                disabled={syncState.status === "syncing"}
                className="inline-flex h-10 items-center gap-2 rounded-md border px-3 text-sm font-medium hover:bg-muted disabled:opacity-50"
              >
                {syncState.status === "syncing" ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="h-4 w-4" />
                )}
                {t("huntressIntegration.syncNow")}
              </button>
            )}
            {saveState.message && (
              <span
                className={`text-sm ${saveState.status === "error" ? "text-red-600" : "text-emerald-600"}`}
              >
                {saveState.message}
              </span>
            )}
            {syncState.message && (
              <span
                className={`text-sm ${syncState.status === "error" ? "text-red-600" : syncState.status === "warning" ? "text-amber-600" : "text-emerald-600"}`}
              >
                {syncState.message}
              </span>
            )}
          </div>
        </div>
      )}

      {isPartnerAdmin && integration && (
        <div className="rounded-xl border bg-card p-6 shadow-xs">
          <div className="flex items-start gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Webhook className="h-4 w-4" />
            </div>
            <div>
              <h2 className="text-lg font-semibold">
                {t("huntressIntegration.inboundWebhookPushFromHuntress")}
              </h2>
              <p className="text-sm text-muted-foreground">
                {t("huntressIntegration.pasteThisEndpointIntoHuntressSoItCan")}
              </p>
            </div>
          </div>

          <div className="mt-4">
            <label className="mb-1 block text-sm font-medium">
              {t("huntressIntegration.webhookURL")}
            </label>
            {webhookUrl ? (
              <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2">
                <code
                  className="flex-1 truncate font-mono text-xs"
                  title={webhookUrl}
                >
                  {webhookUrl}
                </code>
                <CopyButton
                  value={webhookUrl}
                  label={t("common:actions.copy")}
                  className="shrink-0"
                />
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                {t("huntressIntegration.resolvingWebhookURL")}
              </p>
            )}
            <p className="mt-1 text-xs text-muted-foreground">
              {t("huntressIntegration.the")}
              <code className="font-mono">integrationId</code>{" "}
              {t(
                "huntressIntegration.queryParameterTellsBreezeWhichPartnerTheEvents",
              )}
            </p>
          </div>

          {!integration.hasWebhookSecret && (
            <div className="mt-3 flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                {t("huntressIntegration.noWebhookSecretIsSetYetGenerateOr")}
              </span>
            </div>
          )}

          <div className="mt-4 rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
            <p className="font-medium text-foreground">
              {t("huntressIntegration.signingSchemeToConfigureOnHuntress")}
            </p>
            <ul className="mt-1 list-disc space-y-1 pl-4">
              <li>
                {t("huntressIntegration.header")}
                <code className="font-mono">x-huntress-signature</code>:{" "}
                <code className="font-mono">
                  sha256=HMAC-SHA256(&#123;timestamp&#125;.&#123;rawBody&#125;,
                  secret)
                </code>
              </li>
              <li>
                {t("huntressIntegration.header")}
                <code className="font-mono">x-huntress-timestamp</code>
                {t(
                  "huntressIntegration.unixSecondsSignedAlongsideTheBodyRequestsOlder",
                )}
              </li>
              <li>
                {t("common:labels.optional")}
                <code className="font-mono">x-huntress-account-id</code> /{" "}
                <code className="font-mono">x-huntress-integration-id</code>{" "}
                {t("huntressIntegration.headersAreAlsoAcceptedInPlaceOfThe")}
              </li>
            </ul>
          </div>
        </div>
      )}

      {integration && (
        <div className="grid gap-6 lg:grid-cols-[1fr_1fr]">
          <div className="rounded-xl border bg-card p-6 shadow-xs">
            <div className="flex items-center justify-between gap-4">
              <h2 className="text-lg font-semibold">
                {t("huntressIntegration.syncStatus")}
              </h2>
              {syncStatusBadge(integration, t)}
            </div>
            <div className="mt-4 space-y-2 text-sm">
              <div className="flex justify-between text-muted-foreground">
                <span>{t("huntressIntegration.lastSync")}</span>
                <span className="text-foreground">
                  {integration.lastSyncAt
                    ? formatDateTime(integration.lastSyncAt)
                    : "Never"}
                </span>
              </div>
              {integration.lastSyncStatus === "success" && (
                <div className="flex justify-between text-muted-foreground">
                  <span>{t("huntressIntegration.lastResult")}</span>
                  <span className="text-foreground">
                    {formatSyncResult(integration, t)}
                  </span>
                </div>
              )}
              {integration.lastSyncStatus === "error" &&
                integration.lastSyncError && (
                  <div className="rounded-md border border-red-200 bg-red-50 p-3 text-xs text-red-700">
                    <span className="font-medium">
                      {t("huntressIntegration.lastSyncFailed")}
                    </span>{" "}
                    {integration.lastSyncError}
                  </div>
                )}
            </div>
          </div>

          <div className="rounded-xl border bg-card p-6 shadow-xs">
            <h2 className="text-lg font-semibold">
              {t("huntressIntegration.coverage")}
            </h2>
            {coverage && (
              <div className="mt-4 grid grid-cols-2 gap-4">
                <Metric
                  label={t("huntressIntegration.totalAgents")}
                  value={coverage.totalAgents}
                />
                <Metric
                  label={t("huntressIntegration.mappedDevices")}
                  value={coverage.mappedAgents}
                />
                <Metric
                  label={t("huntressIntegration.unmappedDevices")}
                  value={coverage.unmappedAgents}
                  warn={coverage.unmappedAgents > 0}
                />
                <Metric
                  label={t("huntressIntegration.offlineAgents")}
                  value={coverage.offlineAgents}
                />
              </div>
            )}
            {incidents && (
              <div className="mt-4 space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">
                    {t("huntressIntegration.openIncidents")}
                  </span>
                  <span
                    className={`font-semibold ${incidents.open > 0 ? "text-red-600" : ""}`}
                  >
                    {incidents.open}
                  </span>
                </div>
                <div className="flex flex-wrap gap-2">
                  {incidents.bySeverity.map((row) => (
                    <span
                      key={row.severity ?? "unknown"}
                      className="text-xs text-muted-foreground"
                    >
                      <SeverityBadge severity={row.severity} /> {row.count}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {isPartnerAdmin && integration && (
        <div className="rounded-xl border bg-card p-6 shadow-xs">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold">
                {t("huntressIntegration.organizationMapping")}
              </h2>
              <p className="text-sm text-muted-foreground">
                {t(
                  "huntressIntegration.unmappedHuntressOrganizationsStayQuarantinedUntilAssignedTo",
                )}
              </p>
            </div>
            {unmappedCount > 0 && (
              <span className="rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-xs text-amber-700">
                {unmappedCount} {t("huntressIntegration.unmapped")}
              </span>
            )}
          </div>
          {mappingError && (
            <div className="mt-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
              {mappingError}
            </div>
          )}

          {huntressOrgs.length > 0 && (
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <div className="relative flex-1 min-w-[200px]">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <input
                  type="text"
                  value={mappingSearch}
                  onChange={(event) => setMappingSearch(event.target.value)}
                  placeholder={t(
                    "huntressIntegration.searchHuntressOrBreezeOrganizations",
                  )}
                  className="h-9 w-full rounded-md border bg-background pl-9 pr-8 text-sm outline-hidden focus:ring-2 focus:ring-primary/30"
                />
                {mappingSearch && (
                  <button
                    type="button"
                    aria-label={t("huntressIntegration.clearSearch")}
                    onClick={() => setMappingSearch("")}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  >
                    <X className="h-4 w-4" />
                  </button>
                )}
              </div>
              <label className="inline-flex items-center gap-2 text-sm text-muted-foreground">
                <input
                  type="checkbox"
                  checked={showUnmappedOnly}
                  onChange={(event) =>
                    setShowUnmappedOnly(event.target.checked)
                  }
                  className="h-4 w-4 rounded border-input"
                />
                {t("huntressIntegration.unmappedOnly")}
              </label>
            </div>
          )}

          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[820px] text-sm">
              <thead>
                <tr className="border-b text-left text-xs font-semibold uppercase text-muted-foreground">
                  <th className="pb-2 pr-4">
                    {t("huntressIntegration.huntressOrg")}
                  </th>
                  <th className="pb-2 pr-4">
                    {t("huntressIntegration.agents")}
                  </th>
                  <th className="pb-2 pr-4">
                    {t("huntressIntegration.incidents")}
                  </th>
                  <th className="pb-2 pr-4">
                    {t("huntressIntegration.breezeOrganization")}
                  </th>
                  <th className="pb-2">{t("common:labels.status")}</th>
                </tr>
              </thead>
              <tbody>
                {pagedOrgs.map((row) => (
                  <tr
                    key={row.huntressOrgId}
                    className="border-b last:border-0"
                  >
                    <td className="py-3 pr-4">
                      <div className="font-medium">
                        {row.huntressOrgName || row.huntressOrgId}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        ID {row.huntressOrgId}
                        {row.huntressOrgKey ? ` - ${row.huntressOrgKey}` : ""}
                      </div>
                    </td>
                    <td className="py-3 pr-4 text-muted-foreground">
                      {row.agentsCount}
                    </td>
                    <td className="py-3 pr-4 text-muted-foreground">
                      {row.incidentsCount}
                    </td>
                    <td className="py-3 pr-4">
                      <div className="flex items-center gap-2">
                        <select
                          value={row.mappedOrgId ?? ""}
                          onChange={(event) =>
                            void handleMap(
                              row.huntressOrgId,
                              event.target.value || null,
                            )
                          }
                          disabled={mappingSaving[row.huntressOrgId]}
                          className="h-9 w-full max-w-xs rounded-md border bg-background px-2 text-sm outline-hidden focus:ring-2 focus:ring-primary/30 disabled:opacity-50"
                        >
                          <option value="">
                            {t("huntressIntegration.selectOrganization")}
                          </option>
                          {orgOptions.map((org) => (
                            <option key={org.id} value={org.id}>
                              {org.name}
                            </option>
                          ))}
                        </select>
                        {row.mappedOrgId && (
                          <button
                            type="button"
                            onClick={() =>
                              void handleMap(row.huntressOrgId, null)
                            }
                            disabled={mappingSaving[row.huntressOrgId]}
                            className="inline-flex h-9 shrink-0 items-center gap-1 rounded-md border px-2 text-xs font-medium text-muted-foreground hover:bg-muted disabled:opacity-50"
                          >
                            <Unplug className="h-3.5 w-3.5" />{" "}
                            {t("huntressIntegration.unmap")}
                          </button>
                        )}
                      </div>
                    </td>
                    <td className="py-3">
                      {mappingSaving[row.huntressOrgId] ? (
                        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                      ) : row.mappedOrgId ? (
                        <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                      ) : (
                        <AlertTriangle className="h-4 w-4 text-amber-500" />
                      )}
                    </td>
                  </tr>
                ))}
                {huntressOrgs.length === 0 && (
                  <tr>
                    <td
                      colSpan={5}
                      className="py-6 text-sm text-muted-foreground"
                    >
                      {t(
                        "huntressIntegration.noHuntressOrganizationsDiscoveredYetSaveCredentialsAnd",
                      )}
                    </td>
                  </tr>
                )}
                {huntressOrgs.length > 0 && filteredOrgs.length === 0 && (
                  <tr>
                    <td
                      colSpan={5}
                      className="py-6 text-sm text-muted-foreground"
                    >
                      {t(
                        "huntressIntegration.noOrganizationsMatchTheCurrentFilter",
                      )}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {filteredOrgs.length > MAPPING_PAGE_SIZE && (
            <div className="mt-4 flex items-center justify-between text-sm text-muted-foreground">
              <span>
                {t("huntressIntegration.showing")}
                {safePage * MAPPING_PAGE_SIZE + 1}–
                {Math.min(
                  (safePage + 1) * MAPPING_PAGE_SIZE,
                  filteredOrgs.length,
                )}{" "}
                {t("huntressIntegration.of")}
                {filteredOrgs.length}
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() =>
                    setMappingPage((page) => Math.max(0, page - 1))
                  }
                  disabled={safePage === 0}
                  className="inline-flex h-8 items-center rounded-md border px-3 hover:bg-muted disabled:opacity-50"
                >
                  {t("huntressIntegration.previous")}
                </button>
                <span className="text-foreground">
                  {t("huntressIntegration.page")}
                  {safePage + 1} {t("huntressIntegration.of")}
                  {pageCount}
                </span>
                <button
                  type="button"
                  onClick={() =>
                    setMappingPage((page) => Math.min(pageCount - 1, page + 1))
                  }
                  disabled={safePage >= pageCount - 1}
                  className="inline-flex h-8 items-center rounded-md border px-3 hover:bg-muted disabled:opacity-50"
                >
                  {t("huntressIntegration.next")}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {integration && recentIncidents.length > 0 && (
        <div className="rounded-xl border bg-card p-6 shadow-xs">
          <h2 className="text-lg font-semibold">
            {t("huntressIntegration.recentIncidents")}
          </h2>
          <div className="mt-4 space-y-3">
            {recentIncidents.map((incident) => (
              <div
                key={incident.id}
                className="flex items-center justify-between gap-4 border-b pb-3 last:border-0 last:pb-0"
              >
                <div>
                  <div className="font-medium">{incident.title}</div>
                  <div className="text-xs text-muted-foreground">
                    {incident.reportedAt
                      ? formatDateTime(incident.reportedAt)
                      : t("huntressIntegration.unknownTime")}{" "}
                    - {incident.status}
                  </div>
                </div>
                <SeverityBadge severity={incident.severity} />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function SecretInput(props: {
  label: string;
  hint?: string;
  value: string;
  onChange: (value: string) => void;
  visible: boolean;
  onToggle: () => void;
  placeholder: string;
}) {
  return (
    <div>
      <label className="mb-1 block text-sm font-medium">
        {props.label}
        {props.hint && (
          <span className="ml-1 text-xs text-muted-foreground">
            ({props.hint})
          </span>
        )}
      </label>
      <div className="relative">
        <input
          type={props.visible ? "text" : "password"}
          value={props.value}
          onChange={(event) => props.onChange(event.target.value)}
          placeholder={props.placeholder}
          className="h-10 w-full rounded-md border bg-background px-3 pr-10 text-sm outline-hidden focus:ring-2 focus:ring-primary/30"
        />
        <button
          type="button"
          aria-label={
            props.visible ? `Hide ${props.label}` : `Show ${props.label}`
          }
          onClick={props.onToggle}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
        >
          {props.visible ? (
            <EyeOff className="h-4 w-4" />
          ) : (
            <Eye className="h-4 w-4" />
          )}
        </button>
      </div>
    </div>
  );
}

function CopyButton({
  value,
  label = "Copy",
  className,
}: {
  value: string;
  label?: string;
  className?: string;
}) {
  const { t } = useTranslation("integrations");
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard blocked (insecure context / permissions); the value is still
      // selectable in the adjacent field, so fail quietly rather than toast.
    }
  };
  return (
    <button
      type="button"
      onClick={onCopy}
      disabled={!value}
      className={`inline-flex items-center gap-1.5 rounded-md border bg-background px-3 py-1 text-xs font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60 ${className ?? ""}`}
    >
      {copied ? (
        <Check className="h-3.5 w-3.5 text-emerald-600" />
      ) : (
        <Copy className="h-3.5 w-3.5" />
      )}
      {copied
        ? t("common:states.copied")
        : label === "Copy"
          ? t("common:actions.copy")
          : label}
    </button>
  );
}

function Metric({
  label,
  value,
  warn = false,
}: {
  label: string;
  value: number;
  warn?: boolean;
}) {
  return (
    <div>
      <p className={`text-2xl font-bold ${warn ? "text-amber-600" : ""}`}>
        {value}
      </p>
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  );
}
