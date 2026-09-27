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
import AccountingCustomerImport from "./AccountingCustomerImport";
import AccountingMappingWorkbench from "./AccountingMappingWorkbench";
import { useTranslation } from "react-i18next";
import "@/lib/i18n";
import {
  ACCOUNTING_PROVIDER_NAMES,
  accountingPath,
  type AccountingProviderId,
} from "../../lib/accountingProviders";

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
   * from `false`. GET /accounting/:provider does not currently carry it, so
   * on a cold load it is only learned from POST /settings/refresh; typed
   * optional here so it is picked up for free if the status route ever adds it.
   */
  multiCurrencyEnabled?: boolean | null;
  /**
   * Phase D — whether the accounting-reconcile worker pulls QuickBooks payments
   * back onto Breeze invoices. GET /accounting/:provider answers with it on
   * BOTH branches (connected and disconnected), so the switch always has a
   * value; typed optional only so an older API build degrades to "off" rather
   * than rendering `undefined`.
   */
  pullPayments?: boolean;
  /** When the reconcile worker last completed a pull for this connection. */
  lastReconcileAt?: string | null;
  /**
   * Phase D2 — whether Breeze pushes its own payments INTO QuickBooks for
   * this connection. GET /accounting/:provider answers with it on BOTH
   * branches (connected and disconnected), same story as pullPayments.
   */
  pushPayments?: boolean;
}

interface OwedOperations {
  count: number;
  data: Array<{
    id: string;
    pendingOp: "push" | "delete";
    lastError: string | null;
    pendingSince: string;
    ageSeconds: number;
    invoiceId: string | null;
    invoiceNumber: string | null;
  }>;
}

function isMfaError(err: unknown): boolean {
  return (
    err instanceof ActionError &&
    err.status === 403 &&
    /mfa required/i.test(err.message)
  );
}

interface Props {
  provider: AccountingProviderId;
}

/** Monogram for the panel header badge — a brand mark, never translated. */
const PROVIDER_MONOGRAMS: Record<AccountingProviderId, string> = { quickbooks: "QB", xero: "X" };

export default function AccountingConnectionPanel({ provider }: Props) {
  const { t, i18n } = useTranslation("integrations");
  const providerName = ACCOUNTING_PROVIDER_NAMES[provider];
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

  /**
   * SEC-2026-09-05-057: the QuickBooks routes now carry dedicated
   * `accounting:read` / `accounting:manage` capabilities on top of the
   * full-partner authority check. Every mutating control below is disabled or
   * hidden without `accounting:manage`, matching the server gate (the panel
   * itself only renders for a caller holding `accounting:read` — see
   * IntegrationsPage). UX only; every route re-checks server-side.
   */
  const canManageAccounting = usePermissions().can("accounting", "manage");

  const [status, setStatus] = useState<QuickbooksStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [owed, setOwed] = useState<OwedOperations | null>(null);
  const [owedError, setOwedError] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [savingMode, setSavingMode] = useState(false);
  const [refreshingSettings, setRefreshingSettings] = useState(false);
  const [savingPullPayments, setSavingPullPayments] = useState(false);
  const [savingPushPayments, setSavingPushPayments] = useState(false);
  const [reconciling, setReconciling] = useState(false);

  const onUnauthorized = useCallback(() => {
    navigateTo(loginPathWithNext());
  }, []);

  const fetchStatus = useCallback(async () => {
    const res = await fetchWithAuth(accountingPath(provider));
    if (res.status === 401) {
      onUnauthorized();
      return null;
    }
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(
        t("quickbooksIntegration.failedToLoadStatusCode", { provider: providerName,
          status: res.status,
        }),
      );
    }
    return json as QuickbooksStatus;
  }, [provider, providerName, onUnauthorized]);

  const fetchOwedOperations = useCallback(async () => {
    setOwed(null);
    setOwedError(false);
    try {
      const res = await fetchWithAuth(accountingPath(provider, "/owed-operations"));
      if (res.status === 401) {
        onUnauthorized();
        return;
      }
      if (!res.ok) throw new Error("Owed operations request failed");
      setOwed(await res.json() as OwedOperations);
    } catch {
      setOwedError(true);
    }
  }, [provider, providerName, onUnauthorized]);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const data = await fetchStatus();
      if (data) {
        setStatus(data);
        await fetchOwedOperations();
      }
    } catch (err) {
      setLoadError(
        err instanceof Error
          ? err.message
          : t("quickbooksIntegration.failedToLoadQuickBooksStatus", { provider: providerName }),
      );
    } finally {
      setLoading(false);
    }
  }, [fetchStatus, fetchOwedOperations]);

  // Surface the OAuth round-trip result. The API callback redirects back to
  // /integrations?accounting=<provider>&connected=1 (or &error=...). Show a
  // toast, strip the params so a refresh doesn't re-toast, then load status.
  // A return addressed to another provider is left for that provider's panel.
  useEffect(() => {
    if (isOrgScoped || typeof window === "undefined") {
      setLoading(false);
      return;
    }
    const params = new URLSearchParams(window.location.search);
    if (params.get("accounting") === provider) {
      const error = params.get("error");
      if (params.get("connected") === "1") {
        showToast({
          type: "success",
          message: t("quickbooksIntegration.quickbooksConnected", { provider: providerName }),
        });
      } else if (error === "provider_conflict") {
        // One accounting connection per partner: retrying cannot succeed
        // until the other provider is disconnected, so say that instead of
        // the generic "connection failed, try again".
        showToast({
          type: "error",
          message: t("quickbooksIntegration.providerConflict", { provider: providerName }),
        });
      } else if (error) {
        showToast({
          type: "error",
          message: t(
            "quickbooksIntegration.quickbooksConnectionFailedPleaseTryAgain", { provider: providerName },
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
  }, [isOrgScoped, load, provider, providerName]);

  const handleConnect = useCallback(async () => {
    setConnecting(true);
    setLoadError(null);
    try {
      const result = await runAction<{ authUrl: string }>({
        request: () => fetchWithAuth(accountingPath(provider, "/connect")),
        errorFallback: t(
          "quickbooksIntegration.failedToStartTheQuickBooksConnection", { provider: providerName },
        ),
        onUnauthorized,
      });
      // Full-page navigation to Intuit's consent screen.
      window.location.assign(result.authUrl);
    } catch (err) {
      if (isMfaError(err))
        setLoadError(t("quickbooksIntegration.mfaRequiredHint", { provider: providerName }));
      else if (!(err instanceof ActionError))
        handleActionError(
          err,
          t("quickbooksIntegration.failedToStartTheQuickBooksConnection", { provider: providerName }),
        );
      setConnecting(false);
    }
  }, [provider, providerName, onUnauthorized]);

  const handleDisconnect = useCallback(async () => {
    setDisconnecting(true);
    try {
      await runAction({
        request: () =>
          fetchWithAuth(accountingPath(provider, "/disconnect"), {
            method: "POST",
          }),
        errorFallback: t("quickbooksIntegration.failedToDisconnectQuickBooks", { provider: providerName }),
        successMessage: t("quickbooksIntegration.quickbooksDisconnected", { provider: providerName }),
        onUnauthorized,
      });
      await load();
    } catch (err) {
      if (isMfaError(err))
        setLoadError(t("quickbooksIntegration.mfaRequiredHint", { provider: providerName }));
      else if (!(err instanceof ActionError))
        handleActionError(
          err,
          t("quickbooksIntegration.failedToDisconnectQuickBooks", { provider: providerName }),
        );
    } finally {
      setDisconnecting(false);
    }
  }, [provider, providerName, load, onUnauthorized]);

  const handleSetPushMode = useCallback(
    async (pushMode: PushMode) => {
      if (savingMode || status?.pushMode === pushMode) return;
      setSavingMode(true);
      try {
        const updated = await runAction<QuickbooksStatus>({
          request: () =>
            fetchWithAuth(accountingPath(provider, "/settings"), {
              method: "PATCH",
              body: JSON.stringify({ pushMode }),
            }),
          errorFallback: t(
            "quickbooksIntegration.failedToUpdateThePushSetting", { provider: providerName },
          ),
          successMessage:
            pushMode === "auto"
              ? t("quickbooksIntegration.invoicesPushAutomatically", { provider: providerName })
              : t("quickbooksIntegration.invoicesPushManually", { provider: providerName }),
          onUnauthorized,
        });
        setStatus((prev) =>
          prev ? { ...prev, pushMode: updated.pushMode } : prev,
        );
      } catch (err) {
        if (isMfaError(err))
          setLoadError(t("quickbooksIntegration.mfaRequiredHint", { provider: providerName }));
        else if (!(err instanceof ActionError))
          handleActionError(
            err,
            t("quickbooksIntegration.failedToUpdateThePushSetting", { provider: providerName }),
          );
      } finally {
        setSavingMode(false);
      }
    },
    [savingMode, status?.pushMode, provider, providerName, onUnauthorized],
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
            fetchWithAuth(accountingPath(provider, "/settings"), {
              method: "PATCH",
              body: JSON.stringify({ pullPayments: next }),
            }),
          errorFallback: t(
            "quickbooksIntegration.failedToUpdatePullPayments", { provider: providerName },
          ),
          successMessage: next
            ? t("quickbooksIntegration.pullPaymentsEnabled", { provider: providerName })
            : t("quickbooksIntegration.pullPaymentsDisabled", { provider: providerName }),
          onUnauthorized,
        });
        setStatus((prev) =>
          prev ? { ...prev, pullPayments: updated.pullPayments } : prev,
        );
      } catch (err) {
        if (isMfaError(err))
          setLoadError(t("quickbooksIntegration.mfaRequiredHint", { provider: providerName }));
        else if (!(err instanceof ActionError))
          handleActionError(
            err,
            t("quickbooksIntegration.failedToUpdatePullPayments", { provider: providerName }),
          );
      } finally {
        setSavingPullPayments(false);
      }
    },
    [savingPullPayments, status?.pullPayments, provider, providerName, onUnauthorized],
  );

  // Phase D2 — the outbound half. Same non-optimistic shape as
  // handleSetPullPayments above: the switch renders from the SERVER's echoed
  // value, so a rejected PATCH leaves it showing the setting QuickBooks
  // actually still has rather than a lie the operator then acts on. This one
  // gates OUTBOUND money writes, which makes the honesty matter more, not less.
  const handleSetPushPayments = useCallback(
    async (next: boolean) => {
      if (savingPushPayments || (status?.pushPayments ?? false) === next) return;
      setSavingPushPayments(true);
      try {
        const updated = await runAction<QuickbooksStatus>({
          request: () =>
            fetchWithAuth(accountingPath(provider, "/settings"), {
              method: "PATCH",
              body: JSON.stringify({ pushPayments: next }),
            }),
          errorFallback: t("quickbooksIntegration.failedToUpdatePushPayments", { provider: providerName }),
          successMessage: next
            ? t("quickbooksIntegration.pushPaymentsEnabled", { provider: providerName })
            : t("quickbooksIntegration.pushPaymentsDisabled", { provider: providerName }),
          onUnauthorized,
        });
        setStatus((prev) =>
          prev ? { ...prev, pushPayments: updated.pushPayments } : prev,
        );
      } catch (err) {
        if (isMfaError(err))
          setLoadError(t("quickbooksIntegration.mfaRequiredHint", { provider: providerName }));
        else if (!(err instanceof ActionError))
          handleActionError(
            err,
            t("quickbooksIntegration.failedToUpdatePushPayments", { provider: providerName }),
          );
      } finally {
        setSavingPushPayments(false);
      }
    },
    [savingPushPayments, status?.pushPayments, provider, providerName, onUnauthorized],
  );

  // Phase D — "Sync now". POST /reconcile answers 200 with `{ enqueued }` in
  // BOTH outcomes: the route reports honestly rather than pretending a job it
  // could not hand to Redis is on its way. So there is no successMessage here —
  // the toast is chosen from the boolean, and `false` gets a warning. Toasting
  // "queued" on `enqueued: false` would leave the operator waiting on a sync
  // that will never run.
  //
  // Issue #4543 — a connection with BOTH payment switches off gets a distinct
  // 409 `{ code: 'payment_sync_disabled' }` (Phase D2: pull off alone still
  // runs, the gate is pull OR push) rather than a `{ enqueued: false }` 200, so runAction
  // treats it as a failure and `friendly` swaps in the translated copy instead
  // of the route's raw English message.
  const handleReconcileNow = useCallback(async () => {
    setReconciling(true);
    try {
      const result = await runAction<{ enqueued: boolean }>({
        request: () =>
          fetchWithAuth(accountingPath(provider, "/reconcile"), {
            method: "POST",
          }),
        errorFallback: t("quickbooksIntegration.failedToSyncNow", { provider: providerName }),
        friendly: (code) =>
          code === "payment_sync_disabled"
            ? t("quickbooksIntegration.syncNowPullDisabled", { provider: providerName })
            : undefined,
        onUnauthorized,
      });
      showToast(
        result.enqueued
          ? {
              type: "success",
              message: t("quickbooksIntegration.syncNowQueued", { provider: providerName }),
            }
          : {
              type: "warning",
              message: t("quickbooksIntegration.syncNowNotQueued", { provider: providerName }),
            },
      );
    } catch (err) {
      if (isMfaError(err))
        setLoadError(t("quickbooksIntegration.mfaRequiredHint", { provider: providerName }));
      else if (!(err instanceof ActionError))
        handleActionError(err, t("quickbooksIntegration.failedToSyncNow", { provider: providerName }));
    } finally {
      setReconciling(false);
    }
  }, [provider, providerName, onUnauthorized]);

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
          fetchWithAuth(accountingPath(provider, "/settings/refresh"), {
            method: "POST",
          }),
        errorFallback: t("quickbooksIntegration.failedToRefreshSettings", { provider: providerName }),
        successMessage: t("quickbooksIntegration.settingsRefreshed", { provider: providerName }),
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
        setLoadError(t("quickbooksIntegration.mfaRequiredHint", { provider: providerName }));
      else if (!(err instanceof ActionError))
        handleActionError(
          err,
          t("quickbooksIntegration.failedToRefreshSettings", { provider: providerName }),
        );
    } finally {
      setRefreshingSettings(false);
    }
  }, [provider, providerName, onUnauthorized]);

  if (isOrgScoped) {
    return (
      <div className="space-y-6" data-testid={`${provider}-panel`}>
        <Header provider={provider} />
        <p
          className="text-center text-sm text-muted-foreground"
          data-testid={`${provider}-org-scope`}
        >
          {t(
            "quickbooksIntegration.theQuickBooksAccountingIntegrationIsAvailableToPartner", { provider: providerName },
          )}
        </p>
      </div>
    );
  }

  if (loading) {
    return (
      <div
        className="flex items-center gap-2 py-12 text-sm text-muted-foreground"
        data-testid={`${provider}-loading`}
      >
        <Loader2 className="h-4 w-4 animate-spin" />{" "}
        {t("quickbooksIntegration.loadingQuickBooksStatus", { provider: providerName })}
      </div>
    );
  }

  const isConnected = status?.status === "connected";
  const needsReauth = status?.status === "reauth_required";

  return (
    <div className="space-y-6" data-testid={`${provider}-panel`}>
      <div className="flex items-center gap-3">
        <Header provider={provider} />
        {isConnected ? (
          <span
            className="ml-auto inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs text-emerald-700"
            data-testid={`${provider}-status-connected`}
          >
            <CheckCircle2 className="h-3.5 w-3.5" /> {t("common:states.active")}
          </span>
        ) : needsReauth ? (
          <span
            className="ml-auto inline-flex items-center gap-1.5 rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-xs text-amber-700"
            data-testid={`${provider}-status-reauth`}
          >
            <AlertTriangle className="h-3.5 w-3.5" />{" "}
            {t("quickbooksIntegration.reconnectRequired", { provider: providerName })}
          </span>
        ) : (
          <span
            className="ml-auto inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs text-slate-600"
            data-testid={`${provider}-status-disconnected`}
          >
            <Unplug className="h-3.5 w-3.5" /> {t("common:states.inactive")}
          </span>
        )}
      </div>

      {loadError && (
        <p
          className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800"
          data-testid={`${provider}-load-error`}
        >
          {loadError}
        </p>
      )}

      {!isConnected && (
        <div className="rounded-lg border bg-card p-5">
          <p className="text-sm text-muted-foreground">
            {needsReauth
              ? t("quickbooksIntegration.authorizationExpired", { provider: providerName })
              : t("quickbooksIntegration.connectDescription", { provider: providerName })}
          </p>
          {needsReauth && status?.lastError && (
            <p
              className="mt-2 text-xs text-amber-700"
              data-testid={`${provider}-last-error`}
            >
              {status.lastError}
            </p>
          )}
          <button
            type="button"
            onClick={() => void handleConnect()}
            disabled={connecting || !canManageAccounting}
            className="mt-4 inline-flex h-10 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
            data-testid={`${provider}-connect`}
          >
            {connecting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Plug className="h-4 w-4" />
            )}
            {needsReauth
              ? t("quickbooksIntegration.reconnectQuickBooks", { provider: providerName })
              : t("quickbooksIntegration.connectToQuickBooks", { provider: providerName })}
          </button>
        </div>
      )}

      {isConnected && status && (
        <div className="space-y-5 rounded-lg border bg-card p-5">
          <dl className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <dt className="text-muted-foreground">
                {t("quickbooksIntegration.environment", { provider: providerName })}
              </dt>
              <dd className="font-medium" data-testid={`${provider}-environment`}>
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
                {t("quickbooksIntegration.homeCurrency", { provider: providerName })}
              </dt>
              <dd className="font-medium" data-testid={`${provider}-home-currency`}>
                {status.homeCurrency ?? "—"}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">
                {t("quickbooksIntegration.multiCurrency", { provider: providerName })}
              </dt>
              {/* Three states, not two: `null`/absent is "not captured yet",
                  which must not read as a definitive "No" — foreign-currency
                  push behaviour hinges on this flag. */}
              <dd className="font-medium" data-testid={`${provider}-multi-currency`}>
                {status.multiCurrencyEnabled === true
                  ? t("common:labels.yes")
                  : status.multiCurrencyEnabled === false
                    ? t("common:labels.no")
                    : t("quickbooksIntegration.multiCurrencyUnknown", { provider: providerName })}
              </dd>
            </div>
          </dl>

          {canWriteInvoices && canManageAccounting && (
          <div>
            <p className="text-sm font-medium">
              {t("quickbooksIntegration.invoicePush", { provider: providerName })}
            </p>
            <p className="text-xs text-muted-foreground">
              {t(
                "quickbooksIntegration.controlWhenIssuedInvoicesAreSentToQuickBooks", { provider: providerName },
              )}
            </p>
            <div
              className="mt-2 inline-flex overflow-hidden rounded-md border"
              data-testid={`${provider}-pushmode`}
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
                    data-testid={`${provider}-pushmode-${mode}`}
                  >
                    {mode === "auto"
                      ? t("quickbooksIntegration.automaticOnIssue", { provider: providerName })
                      : t("quickbooksIntegration.manual", { provider: providerName })}
                  </button>
                );
              })}
            </div>
          </div>
          )}

          {/* Phase D: payment pull-back. Sits beside the push-mode row because
              the two together are the whole direction-of-travel story — push
              invoices out, pull payments back. */}
          {canWriteInvoices && canManageAccounting && (
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-sm font-medium">
                {t("quickbooksIntegration.pullPayments", { provider: providerName })}
              </p>
              <p className="text-xs text-muted-foreground">
                {t("quickbooksIntegration.pullPaymentsDescription", { provider: providerName })}
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={status.pullPayments === true}
              aria-label={t("quickbooksIntegration.pullPayments", { provider: providerName })}
              onClick={() =>
                void handleSetPullPayments(status.pullPayments !== true)
              }
              disabled={savingPullPayments}
              className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition disabled:opacity-50 ${
                status.pullPayments === true ? "bg-emerald-500/80" : "bg-muted"
              }`}
              data-testid={`${provider}-pullpayments`}
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

          {/* Phase D2: the outbound half. Sits under the pull toggle so the two
              read as one direction-of-travel pair. */}
          {canWriteInvoices && canManageAccounting && (
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-sm font-medium">
                {t("quickbooksIntegration.pushPayments", { provider: providerName })}
              </p>
              <p className="text-xs text-muted-foreground">
                {t("quickbooksIntegration.pushPaymentsDescription", { provider: providerName })}
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={status.pushPayments === true}
              aria-label={t("quickbooksIntegration.pushPayments", { provider: providerName })}
              onClick={() =>
                void handleSetPushPayments(status.pushPayments !== true)
              }
              disabled={savingPushPayments}
              className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition disabled:opacity-50 ${
                status.pushPayments === true ? "bg-emerald-500/80" : "bg-muted"
              }`}
              data-testid={`${provider}-pushpayments`}
            >
              <span
                className={`inline-block h-5 w-5 rounded-full bg-white transition ${
                  status.pushPayments === true
                    ? "translate-x-5"
                    : "translate-x-1"
                }`}
              />
            </button>
          </div>
          )}

          <div className="flex items-center gap-3 border-t pt-4">
            {canWriteInvoices && canManageAccounting && (
            <button
              type="button"
              onClick={() => void handleReconcileNow()}
              disabled={reconciling}
              className="inline-flex h-9 items-center gap-2 rounded-md border px-3 text-sm font-medium hover:bg-muted disabled:opacity-50"
              data-testid={`${provider}-reconcile-now`}
            >
              {reconciling ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4" />
              )}
              {t("quickbooksIntegration.syncNow", { provider: providerName })}
            </button>
            )}
            <p
              className="text-xs text-muted-foreground"
              data-testid={`${provider}-last-reconcile`}
            >
              {t("quickbooksIntegration.lastPaymentSync", { provider: providerName })}:{" "}
              {status.lastReconcileAt
                ? formatDateTime(status.lastReconcileAt)
                : t("quickbooksIntegration.never", { provider: providerName })}
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
              data-testid={`${provider}-reconcile-last-error`}
            >
              {status.lastError}
            </p>
          )}

          <div className="flex items-center gap-3 border-t pt-4">
            <button
              type="button"
              onClick={() => void load()}
              className="inline-flex h-9 items-center gap-2 rounded-md border px-3 text-sm font-medium hover:bg-muted"
              data-testid={`${provider}-refresh`}
            >
              <RefreshCw className="h-4 w-4" /> {t("common:actions.refresh")}
            </button>
            <button
              type="button"
              onClick={() => void handleRefreshSettings()}
              disabled={refreshingSettings || !canManageAccounting}
              className="inline-flex h-9 items-center gap-2 rounded-md border px-3 text-sm font-medium hover:bg-muted disabled:opacity-50"
              data-testid={`${provider}-settings-refresh`}
            >
              {refreshingSettings ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4" />
              )}
              {t("quickbooksIntegration.refreshSettings", { provider: providerName })}
            </button>
            <button
              type="button"
              onClick={() => void handleDisconnect()}
              disabled={disconnecting || !canManageAccounting}
              className="inline-flex h-9 items-center gap-2 rounded-md border border-red-200 px-3 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
              data-testid={`${provider}-disconnect`}
            >
              {disconnecting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Unplug className="h-4 w-4" />
              )}
              {t("quickbooksIntegration.disconnect", { provider: providerName })}
            </button>
          </div>
        </div>
      )}

      {status && (
        <section className="space-y-3 rounded-lg border bg-card p-5" data-testid={`${provider}-owed-operations`} aria-labelledby={`${provider}-owed-heading`}>
          <h2 id={`${provider}-owed-heading`} className="font-semibold">{t("quickbooksIntegration.owedTitle", { provider: providerName })}</h2>
          {owedError ? (
            <p role="alert" className="text-sm text-destructive" data-testid={`${provider}-owed-error`}>{t("quickbooksIntegration.owedLoadError", { provider: providerName })}</p>
          ) : !owed ? (
            <p className="text-sm text-muted-foreground">{t("common:states.loading")}</p>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">{t("quickbooksIntegration.owedCount", { provider: providerName, total: owed.count })}</p>
              {owed.count === 0 ? (
                <p className="text-sm">{t("quickbooksIntegration.owedEmpty", { provider: providerName })}</p>
              ) : (
                <ul className="divide-y">
                  {owed.data.map((operation) => (
                    <li key={operation.id} className="space-y-1 py-3 text-sm">
                      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                        <span className="font-medium">{operation.pendingOp === "delete" ? t("quickbooksIntegration.owedDelete", { provider: providerName }) : t("quickbooksIntegration.owedPush", { provider: providerName })}</span>
                        {operation.invoiceId ? (
                          <a className="text-primary underline underline-offset-2" data-testid={`${provider}-owed-invoice-${operation.id}`} href={`/billing/invoices/${operation.invoiceId}`}>
                            {operation.invoiceNumber ?? t("quickbooksIntegration.owedViewInvoice", { provider: providerName })}
                          </a>
                        ) : <span className="text-muted-foreground">{t("quickbooksIntegration.owedInvoiceUnavailable", { provider: providerName })}</span>}
                      </div>
                      <p className="text-muted-foreground">{t("quickbooksIntegration.owedAge", { provider: providerName, minutes: new Intl.NumberFormat(i18n.language).format(Math.floor(operation.ageSeconds / 60)) })}</p>
                      {operation.lastError && <p className="break-words text-destructive">{operation.lastError}</p>}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </section>
      )}

      {isConnected && status && (
        <AccountingMappingWorkbench
          provider={provider}
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
        <AccountingCustomerImport provider={provider} onUnauthorized={onUnauthorized} />
      )}
    </div>
  );
}

function Header({ provider }: Props) {
  const { t } = useTranslation("integrations");
  const providerName = ACCOUNTING_PROVIDER_NAMES[provider];
  return (
    <div className="flex items-center gap-3">
      <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
        <span className="text-sm font-bold">{PROVIDER_MONOGRAMS[provider]}</span>
      </div>
      <div>
        <h1 className="text-2xl font-semibold">
          {t("quickbooksIntegration.quickbooksOnline", { provider: providerName })}
        </h1>
        <p className="text-sm text-muted-foreground">
          {t(
            "quickbooksIntegration.syncCustomersInvoicesAndPaymentsToYourBooks", { provider: providerName },
          )}
        </p>
      </div>
    </div>
  );
}
