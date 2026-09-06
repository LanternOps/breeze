import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Plug,
  RefreshCw,
  Unplug,
} from "lucide-react";
import { fetchWithAuth } from "../../stores/auth";
import { runAction, handleActionError, ActionError } from "../../lib/runAction";
import { navigateTo } from "@/lib/navigation";
import { loginPathWithNext, getJwtClaims } from "../../lib/authScope";
import { usePermissions } from "../../lib/permissions";
import { formatDateTime } from "@/lib/dateTimeFormat";
import { showToast } from "../shared/Toast";
import QuickbooksCustomerImport from "./QuickbooksCustomerImport";
import QuickbooksMappingWorkbench from "./QuickbooksMappingWorkbench";
import { useTranslation } from "react-i18next";
import "@/lib/i18n";

type ConnectionStatus =
  | "connected"
  | "disconnected"
  | "reauth_required"
  | "error";
type PushMode = "auto" | "manual";

interface QuickbooksStatus {
  status: ConnectionStatus;
  environment: "sandbox" | "production" | null;
  pushMode: PushMode;
  connectedAt: string | null;
  lastError: string | null;
  defaultIncomeAccountRef?: string | null;
  defaultTaxCodeRef?: string | null;
  /** Realm home currency captured at connect time (ISO 4217). */
  homeCurrency?: string | null;
  /**
   * QuickBooks `Preferences.CurrencyPrefs.MultiCurrencyEnabled`. Nullable BY
   * DESIGN — `null`/absent means "not captured yet", which is a different fact
   * from `false`. GET /accounting/quickbooks does not currently carry it, so
   * on a cold load it is only learned from POST /settings/refresh; typed
   * optional here so it is picked up for free if the status route ever adds it.
   */
  multiCurrencyEnabled?: boolean | null;
  /**
   * Phase D — whether the accounting-reconcile worker pulls QuickBooks payments
   * back onto Breeze invoices. GET /accounting/quickbooks answers with it on
   * BOTH branches (connected and disconnected), so the switch always has a
   * value; typed optional only so an older API build degrades to "off" rather
   * than rendering `undefined`.
   */
  pullPayments?: boolean;
  /** When the reconcile worker last completed a pull for this connection. */
  lastReconcileAt?: string | null;
}

function isMfaError(err: unknown): boolean {
  return (
    err instanceof ActionError &&
    err.status === 403 &&
    /mfa required/i.test(err.message)
  );
}

export default function QuickbooksIntegration() {
  const { t } = useTranslation("integrations");
  const claims = getJwtClaims();
  const isOrgScoped = claims.scope === "organization";
  /**
   * Both direction-of-travel switches are the same authority the invoice-push
   * routes require, and `PATCH /accounting/:provider/settings` now 403s without
   * it (finding D). Hidden rather than disabled: a control that cannot be
   * operated is noise, and the org-scope gate above already sets that precedent.
   * UX only — the route re-checks server-side.
   */
  const canWriteInvoices = usePermissions().can("invoices", "write");

  const [status, setStatus] = useState<QuickbooksStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [savingMode, setSavingMode] = useState(false);
  const [refreshingSettings, setRefreshingSettings] = useState(false);
  const [savingPullPayments, setSavingPullPayments] = useState(false);
  const [reconciling, setReconciling] = useState(false);

  const onUnauthorized = useCallback(() => {
    navigateTo(loginPathWithNext());
  }, []);

  const fetchStatus = useCallback(async () => {
    const res = await fetchWithAuth("/accounting/quickbooks");
    if (res.status === 401) {
      onUnauthorized();
      return null;
    }
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(
        t("quickbooksIntegration.failedToLoadStatusCode", {
          status: res.status,
        }),
      );
    }
    return json as QuickbooksStatus;
  }, [onUnauthorized]);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const data = await fetchStatus();
      if (data) setStatus(data);
    } catch (err) {
      setLoadError(
        err instanceof Error
          ? err.message
          : t("quickbooksIntegration.failedToLoadQuickBooksStatus"),
      );
    } finally {
      setLoading(false);
    }
  }, [fetchStatus]);

  // Surface the OAuth round-trip result. The API callback redirects back to
  // /integrations?accounting=quickbooks&connected=1 (or &error=...). Show a
  // toast, strip the params so a refresh doesn't re-toast, then load status.
  useEffect(() => {
    if (isOrgScoped || typeof window === "undefined") {
      setLoading(false);
      return;
    }
    const params = new URLSearchParams(window.location.search);
    if (params.get("accounting") === "quickbooks") {
      if (params.get("connected") === "1") {
        showToast({
          type: "success",
          message: t("quickbooksIntegration.quickbooksConnected"),
        });
      } else if (params.get("error")) {
        showToast({
          type: "error",
          message: t(
            "quickbooksIntegration.quickbooksConnectionFailedPleaseTryAgain",
          ),
        });
      }
      params.delete("accounting");
      params.delete("connected");
      params.delete("error");
      const next = `${window.location.pathname}${params.toString() ? `?${params}` : ""}${window.location.hash}`;
      window.history.replaceState({}, "", next);
    }
    void load();
  }, [isOrgScoped, load]);

  const handleConnect = useCallback(async () => {
    setConnecting(true);
    setLoadError(null);
    try {
      const result = await runAction<{ authUrl: string }>({
        request: () => fetchWithAuth("/accounting/quickbooks/connect"),
        errorFallback: t(
          "quickbooksIntegration.failedToStartTheQuickBooksConnection",
        ),
        onUnauthorized,
      });
      // Full-page navigation to Intuit's consent screen.
      window.location.assign(result.authUrl);
    } catch (err) {
      if (isMfaError(err))
        setLoadError(t("quickbooksIntegration.mfaRequiredHint"));
      else if (!(err instanceof ActionError))
        handleActionError(
          err,
          t("quickbooksIntegration.failedToStartTheQuickBooksConnection"),
        );
      setConnecting(false);
    }
  }, [onUnauthorized]);

  const handleDisconnect = useCallback(async () => {
    setDisconnecting(true);
    try {
      await runAction({
        request: () =>
          fetchWithAuth("/accounting/quickbooks/disconnect", {
            method: "POST",
          }),
        errorFallback: t("quickbooksIntegration.failedToDisconnectQuickBooks"),
        successMessage: t("quickbooksIntegration.quickbooksDisconnected"),
        onUnauthorized,
      });
      await load();
    } catch (err) {
      if (isMfaError(err))
        setLoadError(t("quickbooksIntegration.mfaRequiredHint"));
      else if (!(err instanceof ActionError))
        handleActionError(
          err,
          t("quickbooksIntegration.failedToDisconnectQuickBooks"),
        );
    } finally {
      setDisconnecting(false);
    }
  }, [load, onUnauthorized]);

  const handleSetPushMode = useCallback(
    async (pushMode: PushMode) => {
      if (savingMode || status?.pushMode === pushMode) return;
      setSavingMode(true);
      try {
        const updated = await runAction<QuickbooksStatus>({
          request: () =>
            fetchWithAuth("/accounting/quickbooks/settings", {
              method: "PATCH",
              body: JSON.stringify({ pushMode }),
            }),
          errorFallback: t(
            "quickbooksIntegration.failedToUpdateThePushSetting",
          ),
          successMessage:
            pushMode === "auto"
              ? t("quickbooksIntegration.invoicesPushAutomatically")
              : t("quickbooksIntegration.invoicesPushManually"),
          onUnauthorized,
        });
        setStatus((prev) =>
          prev ? { ...prev, pushMode: updated.pushMode } : prev,
        );
      } catch (err) {
        if (isMfaError(err))
          setLoadError(t("quickbooksIntegration.mfaRequiredHint"));
        else if (!(err instanceof ActionError))
          handleActionError(
            err,
            t("quickbooksIntegration.failedToUpdateThePushSetting"),
          );
      } finally {
        setSavingMode(false);
      }
    },
    [savingMode, status?.pushMode, onUnauthorized],
  );

  // Phase D — turn the payment pull-back on or off. Same PATCH route and same
  // shape as handleSetPushMode above; the switch renders from the SERVER's
  // echoed value, never optimistically, so a rejected PATCH leaves it showing
  // the setting QuickBooks actually still has rather than a lie the operator
  // then acts on.
  const handleSetPullPayments = useCallback(
    async (next: boolean) => {
      if (savingPullPayments || (status?.pullPayments ?? false) === next) return;
      setSavingPullPayments(true);
      try {
        const updated = await runAction<QuickbooksStatus>({
          request: () =>
            fetchWithAuth("/accounting/quickbooks/settings", {
              method: "PATCH",
              body: JSON.stringify({ pullPayments: next }),
            }),
          errorFallback: t(
            "quickbooksIntegration.failedToUpdatePullPayments",
          ),
          successMessage: next
            ? t("quickbooksIntegration.pullPaymentsEnabled")
            : t("quickbooksIntegration.pullPaymentsDisabled"),
          onUnauthorized,
        });
        setStatus((prev) =>
          prev ? { ...prev, pullPayments: updated.pullPayments } : prev,
        );
      } catch (err) {
        if (isMfaError(err))
          setLoadError(t("quickbooksIntegration.mfaRequiredHint"));
        else if (!(err instanceof ActionError))
          handleActionError(
            err,
            t("quickbooksIntegration.failedToUpdatePullPayments"),
          );
      } finally {
        setSavingPullPayments(false);
      }
    },
    [savingPullPayments, status?.pullPayments, onUnauthorized],
  );

  // Phase D — "Sync now". POST /reconcile answers 200 with `{ enqueued }` in
  // BOTH outcomes: the route reports honestly rather than pretending a job it
  // could not hand to Redis is on its way. So there is no successMessage here —
  // the toast is chosen from the boolean, and `false` gets a warning. Toasting
  // "queued" on `enqueued: false` would leave the operator waiting on a sync
  // that will never run.
  //
  // Issue #4543 — a connection with pull_payments off gets a distinct 409
  // `{ code: 'pull_disabled' }` (not a `{ enqueued: false }` 200), so runAction
  // treats it as a failure and `friendly` swaps in the translated copy instead
  // of the route's raw English message.
  const handleReconcileNow = useCallback(async () => {
    setReconciling(true);
    try {
      const result = await runAction<{ enqueued: boolean }>({
        request: () =>
          fetchWithAuth("/accounting/quickbooks/reconcile", {
            method: "POST",
          }),
        errorFallback: t("quickbooksIntegration.failedToSyncNow"),
        friendly: (code) =>
          code === "pull_disabled"
            ? t("quickbooksIntegration.syncNowPullDisabled")
            : undefined,
        onUnauthorized,
      });
      showToast(
        result.enqueued
          ? {
              type: "success",
              message: t("quickbooksIntegration.syncNowQueued"),
            }
          : {
              type: "warning",
              message: t("quickbooksIntegration.syncNowNotQueued"),
            },
      );
    } catch (err) {
      if (isMfaError(err))
        setLoadError(t("quickbooksIntegration.mfaRequiredHint"));
      else if (!(err instanceof ActionError))
        handleActionError(err, t("quickbooksIntegration.failedToSyncNow"));
    } finally {
      setReconciling(false);
    }
  }, [onUnauthorized]);

  // On-demand realm settings refresh (Phase C). This makes a live QuickBooks
  // call server-side and persists what it finds, so it is a mutation (POST,
  // MFA-gated) and goes through runAction like every other one here.
  const handleRefreshSettings = useCallback(async () => {
    setRefreshingSettings(true);
    try {
      const settings = await runAction<{
        homeCurrency: string | null;
        multiCurrencyEnabled: boolean | null;
      }>({
        request: () =>
          fetchWithAuth("/accounting/quickbooks/settings/refresh", {
            method: "POST",
          }),
        errorFallback: t("quickbooksIntegration.failedToRefreshSettings"),
        successMessage: t("quickbooksIntegration.settingsRefreshed"),
        onUnauthorized,
      });
      setStatus((prev) =>
        prev
          ? {
              ...prev,
              homeCurrency: settings.homeCurrency,
              multiCurrencyEnabled: settings.multiCurrencyEnabled,
            }
          : prev,
      );
    } catch (err) {
      if (isMfaError(err))
        setLoadError(t("quickbooksIntegration.mfaRequiredHint"));
      else if (!(err instanceof ActionError))
        handleActionError(
          err,
          t("quickbooksIntegration.failedToRefreshSettings"),
        );
    } finally {
      setRefreshingSettings(false);
    }
  }, [onUnauthorized]);

  if (isOrgScoped) {
    return (
      <div className="space-y-6" data-testid="quickbooks-panel">
        <Header />
        <p
          className="text-center text-sm text-muted-foreground"
          data-testid="quickbooks-org-scope"
        >
          {t(
            "quickbooksIntegration.theQuickBooksAccountingIntegrationIsAvailableToPartner",
          )}
        </p>
      </div>
    );
  }

  if (loading) {
    return (
      <div
        className="flex items-center gap-2 py-12 text-sm text-muted-foreground"
        data-testid="quickbooks-loading"
      >
        <Loader2 className="h-4 w-4 animate-spin" />{" "}
        {t("quickbooksIntegration.loadingQuickBooksStatus")}
      </div>
    );
  }

  const isConnected = status?.status === "connected";
  const needsReauth = status?.status === "reauth_required";

  return (
    <div className="space-y-6" data-testid="quickbooks-panel">
      <div className="flex items-center gap-3">
        <Header />
        {isConnected ? (
          <span
            className="ml-auto inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs text-emerald-700"
            data-testid="quickbooks-status-connected"
          >
            <CheckCircle2 className="h-3.5 w-3.5" /> {t("common:states.active")}
          </span>
        ) : needsReauth ? (
          <span
            className="ml-auto inline-flex items-center gap-1.5 rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-xs text-amber-700"
            data-testid="quickbooks-status-reauth"
          >
            <AlertTriangle className="h-3.5 w-3.5" />{" "}
            {t("quickbooksIntegration.reconnectRequired")}
          </span>
        ) : (
          <span
            className="ml-auto inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs text-slate-600"
            data-testid="quickbooks-status-disconnected"
          >
            <Unplug className="h-3.5 w-3.5" /> {t("common:states.inactive")}
          </span>
        )}
      </div>

      {loadError && (
        <p
          className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800"
          data-testid="quickbooks-load-error"
        >
          {loadError}
        </p>
      )}

      {!isConnected && (
        <div className="rounded-lg border bg-card p-5">
          <p className="text-sm text-muted-foreground">
            {needsReauth
              ? t("quickbooksIntegration.authorizationExpired")
              : t("quickbooksIntegration.connectDescription")}
          </p>
          {needsReauth && status?.lastError && (
            <p
              className="mt-2 text-xs text-amber-700"
              data-testid="quickbooks-last-error"
            >
              {status.lastError}
            </p>
          )}
          <button
            type="button"
            onClick={() => void handleConnect()}
            disabled={connecting}
            className="mt-4 inline-flex h-10 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
            data-testid="quickbooks-connect"
          >
            {connecting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Plug className="h-4 w-4" />
            )}
            {needsReauth
              ? t("quickbooksIntegration.reconnectQuickBooks")
              : t("quickbooksIntegration.connectToQuickBooks")}
          </button>
        </div>
      )}

      {isConnected && status && (
        <div className="space-y-5 rounded-lg border bg-card p-5">
          <dl className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <dt className="text-muted-foreground">
                {t("quickbooksIntegration.environment")}
              </dt>
              <dd className="font-medium" data-testid="quickbooks-environment">
                {status.environment ?? "—"}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">
                {t("common:states.active")}
              </dt>
              <dd className="font-medium">
                {status.connectedAt ? formatDateTime(status.connectedAt) : "—"}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">
                {t("quickbooksIntegration.homeCurrency")}
              </dt>
              <dd className="font-medium" data-testid="quickbooks-home-currency">
                {status.homeCurrency ?? "—"}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">
                {t("quickbooksIntegration.multiCurrency")}
              </dt>
              {/* Three states, not two: `null`/absent is "not captured yet",
                  which must not read as a definitive "No" — foreign-currency
                  push behaviour hinges on this flag. */}
              <dd className="font-medium" data-testid="quickbooks-multi-currency">
                {status.multiCurrencyEnabled === true
                  ? t("common:labels.yes")
                  : status.multiCurrencyEnabled === false
                    ? t("common:labels.no")
                    : t("quickbooksIntegration.multiCurrencyUnknown")}
              </dd>
            </div>
          </dl>

          {canWriteInvoices && (
          <div>
            <p className="text-sm font-medium">
              {t("quickbooksIntegration.invoicePush")}
            </p>
            <p className="text-xs text-muted-foreground">
              {t(
                "quickbooksIntegration.controlWhenIssuedInvoicesAreSentToQuickBooks",
              )}
            </p>
            <div
              className="mt-2 inline-flex overflow-hidden rounded-md border"
              data-testid="quickbooks-pushmode"
            >
              {(["auto", "manual"] as PushMode[]).map((mode) => {
                const active = status.pushMode === mode;
                return (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => void handleSetPushMode(mode)}
                    disabled={savingMode}
                    className={`px-3 py-1.5 text-sm transition disabled:opacity-50 ${
                      active
                        ? "bg-primary text-primary-foreground"
                        : "bg-background text-muted-foreground hover:text-foreground"
                    }`}
                    data-testid={`quickbooks-pushmode-${mode}`}
                  >
                    {mode === "auto"
                      ? t("quickbooksIntegration.automaticOnIssue")
                      : t("quickbooksIntegration.manual")}
                  </button>
                );
              })}
            </div>
          </div>
          )}

          {/* Phase D: payment pull-back. Sits beside the push-mode row because
              the two together are the whole direction-of-travel story — push
              invoices out, pull payments back. */}
          {canWriteInvoices && (
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-sm font-medium">
                {t("quickbooksIntegration.pullPayments")}
              </p>
              <p className="text-xs text-muted-foreground">
                {t("quickbooksIntegration.pullPaymentsDescription")}
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={status.pullPayments === true}
              aria-label={t("quickbooksIntegration.pullPayments")}
              onClick={() =>
                void handleSetPullPayments(status.pullPayments !== true)
              }
              disabled={savingPullPayments}
              className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition disabled:opacity-50 ${
                status.pullPayments === true ? "bg-emerald-500/80" : "bg-muted"
              }`}
              data-testid="quickbooks-pullpayments"
            >
              <span
                className={`inline-block h-5 w-5 rounded-full bg-white transition ${
                  status.pullPayments === true
                    ? "translate-x-5"
                    : "translate-x-1"
                }`}
              />
            </button>
          </div>
          )}

          <div className="flex items-center gap-3 border-t pt-4">
            {canWriteInvoices && (
            <button
              type="button"
              onClick={() => void handleReconcileNow()}
              disabled={reconciling}
              className="inline-flex h-9 items-center gap-2 rounded-md border px-3 text-sm font-medium hover:bg-muted disabled:opacity-50"
              data-testid="quickbooks-reconcile-now"
            >
              {reconciling ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4" />
              )}
              {t("quickbooksIntegration.syncNow")}
            </button>
            )}
            <p
              className="text-xs text-muted-foreground"
              data-testid="quickbooks-last-reconcile"
            >
              {t("quickbooksIntegration.lastPaymentSync")}:{" "}
              {status.lastReconcileAt
                ? formatDateTime(status.lastReconcileAt)
                : t("quickbooksIntegration.never")}
            </p>
          </div>

          {/* Issue #4543 (silent-failure-hunter finding): the reconcile
              worker stamps a skip/failure reason onto `last_error` even while
              `status` stays "connected" (pull_disabled, run failures,
              a truncated CDC window). Without rendering it here, that stamp
              was DB-only — invisible to anyone who only clicks "Sync now"
              (the route's 409 already covers that click; this covers the
              15-minute sweep / webhook triggers racing a toggle-off). Mirrors
              the `needsReauth` block above. */}
          {status.lastError && (
            <p
              className="text-xs text-amber-700"
              data-testid="quickbooks-reconcile-last-error"
            >
              {status.lastError}
            </p>
          )}

          <div className="flex items-center gap-3 border-t pt-4">
            <button
              type="button"
              onClick={() => void load()}
              className="inline-flex h-9 items-center gap-2 rounded-md border px-3 text-sm font-medium hover:bg-muted"
              data-testid="quickbooks-refresh"
            >
              <RefreshCw className="h-4 w-4" /> {t("common:actions.refresh")}
            </button>
            <button
              type="button"
              onClick={() => void handleRefreshSettings()}
              disabled={refreshingSettings}
              className="inline-flex h-9 items-center gap-2 rounded-md border px-3 text-sm font-medium hover:bg-muted disabled:opacity-50"
              data-testid="quickbooks-settings-refresh"
            >
              {refreshingSettings ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4" />
              )}
              {t("quickbooksIntegration.refreshSettings")}
            </button>
            <button
              type="button"
              onClick={() => void handleDisconnect()}
              disabled={disconnecting}
              className="inline-flex h-9 items-center gap-2 rounded-md border border-red-200 px-3 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
              data-testid="quickbooks-disconnect"
            >
              {disconnecting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Unplug className="h-4 w-4" />
              )}
              {t("quickbooksIntegration.disconnect")}
            </button>
          </div>
        </div>
      )}

      {isConnected && status && (
        <QuickbooksMappingWorkbench
          onUnauthorized={onUnauthorized}
          defaultIncomeAccountRef={status.defaultIncomeAccountRef ?? null}
          onSettingsChanged={(settings) =>
            setStatus((prev) =>
              prev ? { ...prev, defaultIncomeAccountRef: settings.defaultIncomeAccountRef } : prev,
            )
          }
        />
      )}

      {isConnected && (
        <QuickbooksCustomerImport onUnauthorized={onUnauthorized} />
      )}
    </div>
  );
}

function Header() {
  const { t } = useTranslation("integrations");
  return (
    <div className="flex items-center gap-3">
      <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
        <span className="text-sm font-bold">QB</span>
      </div>
      <div>
        <h1 className="text-2xl font-semibold">
          {t("quickbooksIntegration.quickbooksOnline")}
        </h1>
        <p className="text-sm text-muted-foreground">
          {t(
            "quickbooksIntegration.syncCustomersInvoicesAndPaymentsToYourBooks",
          )}
        </p>
      </div>
    </div>
  );
}
