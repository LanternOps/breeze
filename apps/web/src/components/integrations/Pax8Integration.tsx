import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Boxes,
  CheckCircle2,
  Eye,
  EyeOff,
  Loader2,
  Plug,
  RefreshCw,
  Save,
  Unplug,
} from "lucide-react";
import { fetchWithAuth } from "../../stores/auth";
import { fetchAllOrganizationsFrom } from "../../lib/fetchAllOrganizations";
import { runAction, handleActionError, ActionError } from "../../lib/runAction";
import { showToast } from "../shared/Toast";
import { navigateTo } from "@/lib/navigation";
import { loginPathWithNext, getJwtClaims } from "../../lib/authScope";
import { formatDateTime } from "@/lib/dateTimeFormat";
import LinkSubscriptionPicker from "./LinkSubscriptionPicker";
import { useTranslation } from "react-i18next";
import "@/lib/i18n";
import { IntegrationPanelHeader } from "./IntegrationPanelHeader";
import { SuggestionChip } from "./matching/SuggestionChip";
import { SuggestedMatchReviewModal } from "./matching/SuggestedMatchReviewModal";
import {
  buildReviewLists,
  type Pax8CompanySuggestion,
  type Pax8MappingSummary,
} from "./matching/pax8Suggestions";
import { waitForSyncCompletion } from "./pax8SyncPoll";

// ── Types mirrored from apps/api/src/routes/pax8.ts ────────────────────────
interface Pax8Integration {
  id: string;
  partnerId: string;
  name: string;
  apiBaseUrl: string;
  tokenUrl: string;
  isActive: boolean;
  lastSyncAt: string | null;
  lastSyncStatus: string | null;
  lastSyncError: string | null;
  createdAt?: string;
  updatedAt?: string;
  hasClientId: boolean;
  hasClientSecret: boolean;
  hasWebhookSecret: boolean;
}

interface Pax8Company {
  pax8CompanyId: string;
  pax8CompanyName: string | null;
  status: string | null;
  mappedOrgId: string | null;
  mappedOrgName: string | null;
  ignored: boolean;
  lastSeenAt: string | null;
  updatedAt: string | null;
  firstSeenAt?: string | null;
  suggestion?: Pax8CompanySuggestion | null;
}

interface Pax8Subscription {
  id: string;
  pax8SubscriptionId: string;
  pax8CompanyId: string | null;
  pax8CompanyName: string | null;
  orgId: string | null;
  productId: string | null;
  productName: string | null;
  vendorName: string | null;
  status: string | null;
  billingTerm: string | null;
  quantity: number | null;
  unitPrice: string | null;
  unitCost: string | null;
  currencyCode: string | null;
  contractLineId: string | null;
  syncEnabled: boolean | null;
}

interface OrgOption {
  id: string;
  name: string;
}

const UNAUTHORIZED = () =>
  void navigateTo(loginPathWithNext(), { replace: true });
/** Pax8 writes are MFA-gated server-side; a 403 "MFA required" should read as a
 *  setup hint, not a raw permission error. */
function isMfaError(err: unknown): boolean {
  return (
    err instanceof ActionError &&
    err.status === 403 &&
    /mfa required/i.test(err.message)
  );
}

export default function Pax8Integration() {
  const { t } = useTranslation("integrations");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [integration, setIntegration] = useState<Pax8Integration | null>(null);

  // Config form
  const [name, setName] = useState("Pax8");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [showSecret, setShowSecret] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    message: string;
  } | null>(null);

  // Companies + subscriptions
  const [companies, setCompanies] = useState<Pax8Company[]>([]);
  const [subscriptions, setSubscriptions] = useState<Pax8Subscription[]>([]);
  const [orgOptions, setOrgOptions] = useState<OrgOption[]>([]);
  const [mappingCompanyId, setMappingCompanyId] = useState<string | null>(null);
  const [linkingSub, setLinkingSub] = useState<Pax8Subscription | null>(null);
  const [summary, setSummary] = useState<Pax8MappingSummary | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [staleNotice, setStaleNotice] = useState(false);
  const [newSinceSync, setNewSinceSync] = useState(0);
  const syncAbortRef = useRef<AbortController | null>(null);

  // Cancel any in-flight sync poll on unmount.
  useEffect(() => () => syncAbortRef.current?.abort(), []);

  const claims = getJwtClaims();
  const isOrgScoped = claims.scope === "organization";

  const isConfigured = !!integration;
  // A fresh integration needs both credentials; an existing one may save with
  // either field blank to keep the stored secret (the API keeps existing if omitted).
  const canSave =
    name.trim().length > 0 &&
    (isConfigured ||
      (clientId.trim().length > 0 && clientSecret.trim().length > 0));

  const fetchIntegration = useCallback(async () => {
    const res = await fetchWithAuth("/pax8/integration");
    if (res.status === 401) {
      UNAUTHORIZED();
      return null;
    }
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(
        `Failed to load Pax8 integration (${res.status}): ${(json as Record<string, unknown>).error ?? res.statusText}`,
      );
    }
    const data = (json as { data: Pax8Integration | null }).data;
    setIntegration(data);
    if (data) setName(data.name);
    return data;
  }, []);

  const reloadSubscriptions = useCallback(async () => {
    const res = await fetchWithAuth("/pax8/subscriptions?limit=100");
    const json = await res.json().catch(() => ({}));
    if (res.ok) {
      setSubscriptions((json as { data?: Pax8Subscription[] }).data ?? []);
    } else {
      // The mutation already toasted success; warn that the refreshed list could
      // not load so the user knows the rows below may be stale.
      showToast({
        type: "error",
        message: t("pax8Integration.subscriptionsListCouldNotBeRefreshedItMay"),
      });
    }
  }, []);

  const fetchCompaniesAndSubs = useCallback(async () => {
    const [companiesRes, subsRes] = await Promise.all([
      fetchWithAuth("/pax8/companies"),
      fetchWithAuth("/pax8/subscriptions?limit=100"),
    ]);
    const companiesJson = await companiesRes.json().catch(() => ({}));
    const subsJson = await subsRes.json().catch(() => ({}));
    let loadedCompanies: Pax8Company[] | null = null;
    if (companiesRes.ok) {
      const body = companiesJson as {
        data?: Pax8Company[];
        summary?: Pax8MappingSummary;
      };
      loadedCompanies = body.data ?? [];
      setCompanies(loadedCompanies);
      setSummary(body.summary ?? null);
    }
    if (subsRes.ok)
      setSubscriptions((subsJson as { data?: Pax8Subscription[] }).data ?? []);
    try {
      const orgs = await fetchAllOrganizationsFrom<OrgOption>("/orgs/organizations");
      setOrgOptions(orgs);
    } catch {
      // Preserve prior behavior: a failed org fetch leaves orgOptions as-is.
    }
    return loadedCompanies;
  }, []);

  /**
   * Re-read companies after a mutation that already succeeded. A failed or
   * non-OK refresh must never surface as a failed mutation: warn instead.
   */
  const refreshAfterMutation = useCallback(async () => {
    let loaded: Pax8Company[] | null = null;
    try {
      loaded = await fetchCompaniesAndSubs();
    } catch {
      loaded = null;
    }
    if (loaded === null) {
      showToast({
        type: "warning",
        message: t("pax8Integration.companiesRefreshFailed"),
      });
    }
  }, [fetchCompaniesAndSubs]);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const data = await fetchIntegration();
      if (data) await fetchCompaniesAndSubs();
    } catch (err) {
      setLoadError(
        err instanceof Error
          ? err.message
          : t("pax8Integration.failedToLoadPax8Integration"),
      );
    } finally {
      setLoading(false);
    }
  }, [fetchIntegration, fetchCompaniesAndSubs]);

  useEffect(() => {
    if (isOrgScoped) {
      setLoading(false);
      return;
    }
    void load();
  }, [load, isOrgScoped]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setTestResult(null);
    try {
      // Only include secrets the user actually entered so an update keeps the
      // stored credential when the field is left blank.
      const body: Record<string, unknown> = { name: name.trim() };
      if (clientId.trim()) body.clientId = clientId.trim();
      if (clientSecret.trim()) body.clientSecret = clientSecret.trim();
      if (webhookSecret.trim()) body.webhookSecret = webhookSecret.trim();

      const result = await runAction<
        Pax8Integration & { syncWarning?: string }
      >({
        request: () =>
          fetchWithAuth("/pax8/integration", {
            method: "POST",
            body: JSON.stringify(body),
          }),
        errorFallback: t("pax8Integration.failedToSaveThePax8Integration"),
        successMessage: isConfigured
          ? t("pax8Integration.integrationUpdated")
          : t("pax8Integration.integrationConnected"),
        onUnauthorized: UNAUTHORIZED,
      });
      setIntegration(result);
      setName(result.name);
      setClientId("");
      setClientSecret("");
      setWebhookSecret("");
      await fetchCompaniesAndSubs();
    } catch (err) {
      if (isMfaError(err)) setLoadError(t("pax8Integration.mfaRequiredHint"));
      handleActionError(
        err,
        t("pax8Integration.failedToSaveThePax8Integration"),
      );
    } finally {
      setSaving(false);
    }
  }, [
    name,
    clientId,
    clientSecret,
    webhookSecret,
    isConfigured,
    fetchCompaniesAndSubs,
  ]);

  const handleTest = useCallback(async () => {
    setTesting(true);
    setTestResult(null);
    try {
      await runAction({
        request: () =>
          fetchWithAuth("/pax8/integration/test", {
            method: "POST",
            body: JSON.stringify({}),
          }),
        errorFallback: t("pax8Integration.pax8ConnectionTestFailed"),
        successMessage: t("pax8Integration.pax8ConnectionTestSucceeded"),
        onUnauthorized: UNAUTHORIZED,
      });
      setTestResult({
        ok: true,
        message: t("pax8Integration.connectionTestSucceeded"),
      });
    } catch (err) {
      const message = isMfaError(err)
        ? t("pax8Integration.mfaRequiredHint")
        : err instanceof ActionError
          ? err.message
          : t("pax8Integration.pax8ConnectionTestFailed");
      setTestResult({ ok: false, message });
      handleActionError(err, t("pax8Integration.pax8ConnectionTestFailed"));
    } finally {
      setTesting(false);
    }
  }, []);

  const handleSync = useCallback(async () => {
    if (syncAbortRef.current) return; // a sync poll is already running
    const controller = new AbortController();
    syncAbortRef.current = controller;
    setSyncing(true);
    setNewSinceSync(0);
    // Snapshot first: the worker can finish before the enqueue response lands.
    const before = {
      lastSyncAt: integration?.lastSyncAt ?? null,
      updatedAt: integration?.updatedAt ?? null,
    };
    const knownIds = new Set(companies.map((c) => c.pax8CompanyId));
    try {
      await runAction({
        request: () =>
          fetchWithAuth("/pax8/sync", {
            method: "POST",
            body: JSON.stringify({}),
          }),
        errorFallback: t("pax8Integration.failedToScheduleAPax8Sync"),
        successMessage: t("pax8Integration.pax8SyncScheduled"),
        onUnauthorized: UNAUTHORIZED,
      });
      // The sync runs in a worker; wait for lastSyncAt to move before re-reading.
      const finished = await waitForSyncCompletion({
        before,
        signal: controller.signal,
        read: async () => {
          const res = await fetchWithAuth("/pax8/integration");
          if (!res.ok) return null;
          const json = (await res.json().catch(() => ({}))) as {
            data?: Pax8Integration | null;
          };
          return json.data ?? null;
        },
      });
      if (controller.signal.aborted) return;
      if (!finished) {
        showToast({
          type: "warning",
          message: t("pax8Integration.syncStillRunning"),
        });
      }
      await fetchIntegration();
      const loaded = await fetchCompaniesAndSubs();
      if (controller.signal.aborted) return;
      if (finished && loaded) {
        setNewSinceSync(
          loaded.filter((c) => !knownIds.has(c.pax8CompanyId)).length,
        );
      }
    } catch (err) {
      if (isMfaError(err)) setLoadError(t("pax8Integration.mfaRequiredHint"));
      handleActionError(err, t("pax8Integration.failedToScheduleAPax8Sync"));
    } finally {
      if (syncAbortRef.current === controller) syncAbortRef.current = null;
      if (!controller.signal.aborted) setSyncing(false);
    }
  }, [integration, companies, fetchIntegration, fetchCompaniesAndSubs]);

  const mapCompany = useCallback(
    async (
      company: Pax8Company,
      orgId: string | null,
      source?: "manual" | "suggestion",
    ) => {
      if (!integration) return;
      setMappingCompanyId(company.pax8CompanyId);
      try {
        await runAction({
          request: () =>
            fetchWithAuth("/pax8/companies/map", {
              method: "POST",
              body: JSON.stringify({
                integrationId: integration.id,
                pax8CompanyId: company.pax8CompanyId,
                orgId,
                ...(source ? { source } : {}),
              }),
            }),
          errorFallback: t("pax8Integration.failedToMapThePax8Company"),
          successMessage: orgId
            ? t("pax8Integration.companyMapped")
            : t("pax8Integration.companyUnmapped"),
          onUnauthorized: UNAUTHORIZED,
        });
      } catch (err) {
        handleActionError(err, t("pax8Integration.failedToMapThePax8Company"));
        setMappingCompanyId(null);
        return;
      }
      // Re-read: the server decides the row's final shape (mappedOrgId,
      // suggestion, summary), so never merge the POST response locally.
      try {
        await refreshAfterMutation();
      } finally {
        setMappingCompanyId(null);
      }
    },
    [integration, refreshAfterMutation],
  );

  const { items: reviewItems, blocked: reviewBlocked } = useMemo(
    () => buildReviewLists(companies),
    [companies],
  );

  /** Ambiguous rows only offer their candidates; a currently mapped org stays selectable. */
  const optionsFor = (company: Pax8Company): OrgOption[] => {
    const s = company.suggestion;
    if (!s || s.status !== "ambiguous") return orgOptions;
    const allowed = new Set(s.candidates.map((c) => c.orgId));
    if (company.mappedOrgId) allowed.add(company.mappedOrgId);
    return orgOptions.filter((o) => allowed.has(o.id));
  };

  const renderChip = (company: Pax8Company) => {
    const s = company.suggestion;
    if (!s || company.mappedOrgId) return null;
    const testId = `pax8-company-suggestion-${company.pax8CompanyId}`;
    const detail = t("externalMatch.matchedOn", { key: s.matchKey });
    return (
      <div className="mb-1">
        {s.status === "match" && (
          <SuggestionChip
            testId={testId}
            label={t("externalMatch.suggested", { target: s.orgName })}
            detail={detail}
            disabled={mappingCompanyId === company.pax8CompanyId}
            onAccept={() => void mapCompany(company, s.orgId, "suggestion")}
          />
        )}
        {s.status === "ambiguous" && (
          <SuggestionChip
            testId={testId}
            label={t("externalMatch.possibleMatches", { count: s.candidates.length })}
            detail={detail}
          />
        )}
        {s.status === "contested" && (
          <SuggestionChip
            testId={testId}
            label={t("externalMatch.alsoMatches", {
              names: s.contestedWith
                .map((w) => w.pax8CompanyName ?? w.pax8CompanyId)
                .join(", "),
            })}
            detail={detail}
          />
        )}
      </div>
    );
  };

  const confirmBulk = useCallback(
    async (keys: string[]) => {
      if (!integration) return;
      const orgByCompany = new Map(
        reviewItems.map((i) => {
          const s = companies.find((c) => c.pax8CompanyId === i.key)?.suggestion;
          return [i.key, s && s.status === "match" ? s.orgId : null] as const;
        }),
      );
      const items = keys.flatMap((key) => {
        const orgId = orgByCompany.get(key);
        return orgId
          ? [{ pax8CompanyId: key, orgId, expectedOrgId: null }]
          : [];
      });
      setStaleNotice(false);
      try {
        await runAction({
          request: () =>
            fetchWithAuth("/pax8/companies/map-bulk", {
              method: "POST",
              body: JSON.stringify({ integrationId: integration.id, items }),
            }),
          errorFallback: t("pax8Integration.failedToMapThePax8Company"),
          successMessage: t("externalMatch.bulkMapped", { count: items.length }),
          onUnauthorized: UNAUTHORIZED,
          // The stale-review outcome gets its own notice; avoid a second toast.
          suppressErrorToast: (status, code) =>
            status === 409 && code === "STALE_REVIEW",
        });
        setReviewOpen(false);
      } catch (err) {
        if (
          err instanceof ActionError &&
          err.status === 409 &&
          err.code === "STALE_REVIEW"
        ) {
          setStaleNotice(true);
          showToast({ type: "warning", message: t("externalMatch.staleReview") });
          // Reload and keep the modal open on the fresh rows.
          await refreshAfterMutation();
          return;
        }
        handleActionError(err, t("pax8Integration.failedToMapThePax8Company"));
        return;
      }
      await refreshAfterMutation();
    },
    [integration, companies, reviewItems, refreshAfterMutation],
  );

  const unlinkSubscription = useCallback(
    async (sub: Pax8Subscription) => {
      if (!integration) return;
      try {
        await runAction({
          request: () =>
            fetchWithAuth("/pax8/subscriptions/link", {
              method: "DELETE",
              body: JSON.stringify({
                integrationId: integration.id,
                subscriptionSnapshotId: sub.id,
              }),
            }),
          errorFallback: t("pax8Integration.couldNotUnlinkTheSubscription"),
          successMessage: t("pax8Integration.subscriptionUnlinked"),
          onUnauthorized: UNAUTHORIZED,
        });
        void reloadSubscriptions();
      } catch (err) {
        if (isMfaError(err)) {
          showToast({
            type: "error",
            message: t("pax8Integration.mfaRequiredHint"),
          });
          return;
        }
        handleActionError(
          err,
          t("pax8Integration.couldNotUnlinkTheSubscription"),
        );
      }
    },
    [integration, reloadSubscriptions],
  );

  const toggleSync = useCallback(
    async (sub: Pax8Subscription) => {
      if (!integration || !sub.contractLineId) return;
      try {
        await runAction({
          request: () =>
            fetchWithAuth("/pax8/subscriptions/link", {
              method: "POST",
              body: JSON.stringify({
                integrationId: integration.id,
                subscriptionSnapshotId: sub.id,
                contractLineId: sub.contractLineId,
                syncEnabled: !sub.syncEnabled,
              }),
            }),
          errorFallback: t("pax8Integration.couldNotUpdateObservationTracking"),
          successMessage: sub.syncEnabled
            ? t("pax8Integration.observationsPaused")
            : t("pax8Integration.observationsResumed"),
          onUnauthorized: UNAUTHORIZED,
        });
        void reloadSubscriptions();
      } catch (err) {
        if (isMfaError(err)) {
          showToast({
            type: "error",
            message: t("pax8Integration.mfaRequiredHint"),
          });
          return;
        }
        handleActionError(
          err,
          t("pax8Integration.couldNotUpdateObservationTracking"),
        );
      }
    },
    [integration, reloadSubscriptions],
  );

  if (isOrgScoped) {
    return (
      <div className="space-y-6" data-testid="pax8-panel">
        <IntegrationPanelHeader
          icon={<Boxes className="h-4 w-4" />}
          title={t("pax8Integration.pax8")}
        />
        <p
          className="text-center text-sm text-muted-foreground"
          data-testid="pax8-org-scope"
        >
          {t(
            "pax8Integration.thePax8DistributorIntegrationIsAvailableToPartner",
          )}
        </p>
      </div>
    );
  }

  if (loading) {
    return (
      <div
        className="flex items-center justify-center py-20"
        data-testid="pax8-loading"
      >
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const syncStatusColor =
    integration?.lastSyncStatus === "success"
      ? "text-emerald-600"
      : integration?.lastSyncStatus === "error" ||
          integration?.lastSyncStatus === "failed"
        ? "text-red-600"
        : "text-muted-foreground";

  return (
    <div className="space-y-6" data-testid="pax8-panel">
      {/* Header */}
      <IntegrationPanelHeader
        icon={<Boxes className="h-4 w-4" />}
        title={t("pax8Integration.pax8")}
        description={t(
          "pax8Integration.connectPax8ToSyncCompaniesAndLicenseSubscriptions",
        )}
        actions={
          isConfigured ? (
            <span
              className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs text-emerald-700"
              data-testid="pax8-status-connected"
            >
              <CheckCircle2 className="h-3.5 w-3.5" /> {t("common:states.active")}
            </span>
          ) : (
            <span
              className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs text-slate-600"
              data-testid="pax8-status-disconnected"
            >
              <Unplug className="h-3.5 w-3.5" /> {t("common:states.inactive")}
            </span>
          )
        }
      />

      {loadError && (
        <div
          className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
          data-testid="pax8-load-error"
        >
          {loadError}
        </div>
      )}

      {/* Connection card */}
      <div className="rounded-xl border bg-card p-6 shadow-xs">
        <h2 className="text-lg font-semibold">
          {t("pax8Integration.connection")}
        </h2>
        <p className="mb-4 text-sm text-muted-foreground">
          {t("pax8Integration.enterYourPax8OAuthClientCredentialsSecretsAre")}
        </p>

        <div className="grid gap-4 md:grid-cols-2">
          <div className="md:col-span-2">
            <label className="mb-1 block text-sm font-medium">
              {t("pax8Integration.displayName")}
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("pax8Integration.pax8")}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm outline-hidden focus:ring-2 focus:ring-primary/30"
              data-testid="pax8-name"
            />
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium">
              {t("pax8Integration.clientID")}
              {integration?.hasClientId && (
                <span
                  className="ml-1 inline-flex items-center gap-1 text-xs text-emerald-600"
                  data-testid="pax8-has-client-id"
                >
                  <CheckCircle2 className="h-3 w-3" />{" "}
                  {t("pax8Integration.configured")}
                </span>
              )}
            </label>
            <input
              type="text"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              placeholder={
                integration?.hasClientId
                  ? "•••••••••• (stored)"
                  : "Pax8 client ID"
              }
              className="h-10 w-full rounded-md border bg-background px-3 text-sm outline-hidden focus:ring-2 focus:ring-primary/30"
              data-testid="pax8-client-id"
            />
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium">
              {t("pax8Integration.clientSecret")}
              {integration?.hasClientSecret && (
                <span
                  className="ml-1 inline-flex items-center gap-1 text-xs text-emerald-600"
                  data-testid="pax8-has-client-secret"
                >
                  <CheckCircle2 className="h-3 w-3" />{" "}
                  {t("pax8Integration.configured")}
                </span>
              )}
            </label>
            <div className="relative">
              <input
                type={showSecret ? "text" : "password"}
                value={clientSecret}
                onChange={(e) => setClientSecret(e.target.value)}
                placeholder={
                  integration?.hasClientSecret
                    ? t("pax8Integration.storedSecret")
                    : t("pax8Integration.clientSecretPlaceholder")
                }
                className="h-10 w-full rounded-md border bg-background px-3 pr-10 text-sm outline-hidden focus:ring-2 focus:ring-primary/30"
                data-testid="pax8-client-secret"
              />
              <button
                type="button"
                onClick={() => setShowSecret(!showSecret)}
                className="absolute right-2 top-2.5 text-muted-foreground hover:text-foreground"
                aria-label={
                  showSecret
                    ? t("pax8Integration.hideSecret")
                    : t("pax8Integration.showSecret")
                }
              >
                {showSecret ? (
                  <EyeOff className="h-4 w-4" />
                ) : (
                  <Eye className="h-4 w-4" />
                )}
              </button>
            </div>
          </div>

          <div className="md:col-span-2">
            <label className="mb-1 block text-sm font-medium">
              {t("pax8Integration.webhookSecret")}
              <span className="text-xs text-muted-foreground">
                {t("pax8Integration.optional")}
              </span>
              {integration?.hasWebhookSecret && (
                <span
                  className="ml-1 inline-flex items-center gap-1 text-xs text-emerald-600"
                  data-testid="pax8-has-webhook-secret"
                >
                  <CheckCircle2 className="h-3 w-3" />{" "}
                  {t("pax8Integration.configured")}
                </span>
              )}
            </label>
            <input
              type="password"
              value={webhookSecret}
              onChange={(e) => setWebhookSecret(e.target.value)}
              placeholder={
                integration?.hasWebhookSecret
                  ? t("pax8Integration.storedSecret")
                  : t("pax8Integration.webhookSecretPlaceholder")
              }
              className="h-10 w-full rounded-md border bg-background px-3 text-sm outline-hidden focus:ring-2 focus:ring-primary/30"
              data-testid="pax8-webhook-secret"
            />
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={!canSave || saving}
            className="inline-flex h-10 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
            data-testid="pax8-save"
          >
            {saving ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Save className="h-4 w-4" />
            )}
            {isConfigured
              ? t("pax8Integration.updateConnection")
              : t("pax8Integration.connectPax8")}
          </button>
          {isConfigured && (
            <>
              <button
                type="button"
                onClick={() => void handleTest()}
                disabled={testing}
                className="inline-flex h-10 items-center gap-2 rounded-md border px-4 text-sm font-medium hover:bg-muted disabled:opacity-50"
                data-testid="pax8-test"
              >
                {testing ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Plug className="h-4 w-4" />
                )}
                {t("pax8Integration.testConnection")}
              </button>
              <button
                type="button"
                onClick={() => void handleSync()}
                disabled={syncing}
                className="inline-flex h-10 items-center gap-2 rounded-md border px-4 text-sm font-medium hover:bg-muted disabled:opacity-50"
                data-testid="pax8-sync"
              >
                {syncing ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="h-4 w-4" />
                )}
                {t("pax8Integration.syncNow")}
              </button>
            </>
          )}
          {testResult && (
            <span
              className={`inline-flex items-center gap-1 text-sm ${testResult.ok ? "text-emerald-600" : "text-red-600"}`}
              data-testid="pax8-test-result"
            >
              {testResult.ok ? (
                <CheckCircle2 className="h-4 w-4" />
              ) : (
                <AlertTriangle className="h-4 w-4" />
              )}
              {testResult.message}
            </span>
          )}
        </div>
      </div>

      {/* Sync status */}
      {isConfigured && (
        <div
          className="rounded-xl border bg-card p-6 shadow-xs"
          data-testid="pax8-sync-status"
        >
          <h2 className="text-lg font-semibold">
            {t("pax8Integration.syncStatus")}
          </h2>
          <div className="mt-4 space-y-2 text-sm">
            <div className="flex justify-between text-muted-foreground">
              <span>{t("pax8Integration.lastSync")}</span>
              <span className="text-foreground">
                {integration?.lastSyncAt
                  ? formatDateTime(integration.lastSyncAt)
                  : t("pax8Integration.never")}
              </span>
            </div>
            <div className="flex justify-between text-muted-foreground">
              <span>{t("common:labels.status")}</span>
              <span
                className={syncStatusColor}
                data-testid="pax8-sync-status-value"
              >
                {integration?.lastSyncStatus ?? t("pax8Integration.notYetRun")}
              </span>
            </div>
            {integration?.lastSyncError && (
              <div className="flex justify-between gap-4 text-muted-foreground">
                <span>{t("pax8Integration.lastError")}</span>
                <span
                  className="text-right text-red-600"
                  data-testid="pax8-sync-error"
                >
                  {integration.lastSyncError}
                </span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Company mapping */}
      {isConfigured && (
        <div
          className="rounded-xl border bg-card p-6 shadow-xs"
          data-testid="pax8-companies"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-lg font-semibold">
              {t("pax8Integration.companyMapping")}
            </h2>
            <div className="flex flex-wrap items-center gap-2">
              {summary && (
                <span
                  className="rounded-full border bg-muted/40 px-2.5 py-0.5 text-xs text-muted-foreground"
                  data-testid="pax8-mapping-summary"
                >
                  {t("externalMatch.summary", {
                    unmapped: summary.unmapped,
                    suggested: summary.suggested,
                  })}
                </span>
              )}
              {reviewItems.length > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    setStaleNotice(false);
                    setReviewOpen(true);
                  }}
                  className="h-8 rounded-md border px-3 text-xs font-medium hover:bg-muted"
                  data-testid="pax8-review-suggestions"
                >
                  {t("externalMatch.reviewButton", { count: reviewItems.length })}
                </button>
              )}
            </div>
          </div>
          <p className="mb-4 text-sm text-muted-foreground">
            {t("pax8Integration.mapEachPax8CompanyToABreezeOrganization")}
          </p>
          {newSinceSync > 0 && (
            <p
              className="mb-3 text-sm text-foreground"
              data-testid="pax8-sync-new-companies"
            >
              {t("externalMatch.newSinceSync", { count: newSinceSync })}
            </p>
          )}
          {staleNotice && (
            <p
              role="status"
              className="mb-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm"
              data-testid="pax8-review-stale"
            >
              {t("externalMatch.staleReview")}
            </p>
          )}
          <SuggestedMatchReviewModal
            open={reviewOpen}
            items={reviewItems}
            blocked={reviewBlocked}
            onConfirm={confirmBulk}
            onClose={() => setReviewOpen(false)}
            testIdPrefix="pax8"
          />
          {companies.length === 0 ? (
            <p
              className="text-sm text-muted-foreground"
              data-testid="pax8-companies-empty"
            >
              {t("pax8Integration.noPax8CompaniesYetRunASyncTo")}
            </p>
          ) : (
            <table
              className="min-w-full divide-y text-sm"
              data-testid="pax8-companies-table"
            >
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="px-3 py-2 font-medium">
                    {t("pax8Integration.pax8Company")}
                  </th>
                  <th className="px-3 py-2 font-medium">
                    {t("common:labels.status")}
                  </th>
                  <th className="px-3 py-2 font-medium">
                    {t("pax8Integration.breezeOrganization")}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {companies.map((company) => (
                  <tr
                    key={company.pax8CompanyId}
                    data-testid={`pax8-company-${company.pax8CompanyId}`}
                  >
                    <td className="px-3 py-2">
                      <div className="font-medium">
                        {company.pax8CompanyName ?? company.pax8CompanyId}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {company.status ?? "—"}
                    </td>
                    <td className="px-3 py-2">
                      {renderChip(company)}
                      <select
                        value={company.mappedOrgId ?? ""}
                        disabled={mappingCompanyId === company.pax8CompanyId}
                        onChange={(e) =>
                          void mapCompany(company, e.target.value || null)
                        }
                        className="h-9 w-full rounded-md border bg-background px-2 text-sm outline-hidden focus:ring-2 focus:ring-primary/30 disabled:opacity-50"
                        data-testid={`pax8-company-map-${company.pax8CompanyId}`}
                        aria-label={`Map ${company.pax8CompanyName ?? company.pax8CompanyId} to a Breeze organization`}
                      >
                        <option value="">
                          {t("pax8Integration.unmapped")}
                        </option>
                        {optionsFor(company).map((org) => (
                          <option key={org.id} value={org.id}>
                            {org.name}
                          </option>
                        ))}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* Subscriptions */}
      {isConfigured && (
        <div
          className="rounded-xl border bg-card p-6 shadow-xs"
          data-testid="pax8-subscriptions"
        >
          <h2 className="text-lg font-semibold">
            {t("pax8Integration.subscriptions")}
          </h2>
          <p className="mb-4 text-sm text-muted-foreground">
            {t(
              "pax8Integration.subscriptionObservationDescription",
            )}
          </p>
          {subscriptions.length === 0 ? (
            <p
              className="text-sm text-muted-foreground"
              data-testid="pax8-subscriptions-empty"
            >
              {t("pax8Integration.noSubscriptionsYetRunASyncToPull")}
            </p>
          ) : (
            <table
              className="min-w-full divide-y text-sm"
              data-testid="pax8-subscriptions-table"
            >
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="px-3 py-2 font-medium">
                    {t("pax8Integration.product")}
                  </th>
                  <th className="px-3 py-2 font-medium">
                    {t("pax8Integration.company")}
                  </th>
                  <th className="px-3 py-2 font-medium">
                    {t("pax8Integration.qty")}
                  </th>
                  <th className="px-3 py-2 font-medium">
                    {t("pax8Integration.unitCost")}
                  </th>
                  <th className="px-3 py-2 font-medium">
                    {t("pax8Integration.statusActions")}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {subscriptions.map((sub) => (
                  <tr key={sub.id} data-testid={`pax8-subscription-${sub.id}`}>
                    <td className="px-3 py-2">
                      <div className="font-medium">
                        {sub.productName ??
                          sub.productId ??
                          sub.pax8SubscriptionId}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {sub.vendorName ?? ""}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {sub.pax8CompanyName ?? sub.pax8CompanyId ?? "—"}
                    </td>
                    <td className="px-3 py-2">{sub.quantity ?? "—"}</td>
                    <td className="px-3 py-2">
                      {sub.unitCost
                        ? `${sub.currencyCode ?? "USD"} ${sub.unitCost}`
                        : "—"}
                    </td>
                    <td className="px-3 py-2">
                      {sub.orgId == null ? (
                        <span className="text-xs text-muted-foreground">
                          {t("pax8Integration.mapCompanyFirst")}
                        </span>
                      ) : sub.contractLineId ? (
                        <div className="flex flex-wrap gap-2">
                          <span className="inline-flex items-center gap-1 text-xs text-emerald-600">
                            {sub.syncEnabled
                              ? t("pax8Integration.observingQuantity")
                              : t("pax8Integration.observationPaused")}
                          </span>
                          <button
                            type="button"
                            onClick={() => setLinkingSub(sub)}
                            data-testid={`pax8-subscription-change-${sub.id}`}
                            className="text-xs underline hover:text-foreground"
                          >
                            {t("pax8Integration.changeLink")}
                          </button>
                          <button
                            type="button"
                            onClick={() => void toggleSync(sub)}
                            data-testid={`pax8-subscription-togglesync-${sub.id}`}
                            className="text-xs underline hover:text-foreground"
                          >
                            {sub.syncEnabled
                              ? t("pax8Integration.pauseObservations")
                              : t("pax8Integration.resumeObservations")}
                          </button>
                          <button
                            type="button"
                            onClick={() => void unlinkSubscription(sub)}
                            data-testid={`pax8-subscription-unlink-${sub.id}`}
                            className="text-xs underline text-destructive hover:opacity-80"
                          >
                            {t("pax8Integration.unlink")}
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setLinkingSub(sub)}
                          data-testid={`pax8-subscription-link-${sub.id}`}
                          className="rounded-md border px-2 py-1 text-xs font-medium hover:bg-muted"
                        >
                          {t("pax8Integration.linkForObservation")}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {linkingSub && integration && linkingSub.orgId && (
            <LinkSubscriptionPicker
              key={linkingSub.id}
              integrationId={integration.id}
              subscription={{
                id: linkingSub.id,
                orgId: linkingSub.orgId,
                productName: linkingSub.productName,
                quantity: linkingSub.quantity,
                unitPrice: linkingSub.unitPrice,
              }}
              onDone={() => {
                setLinkingSub(null);
                void reloadSubscriptions();
              }}
              onCancel={() => setLinkingSub(null)}
            />
          )}
        </div>
      )}
    </div>
  );
}
