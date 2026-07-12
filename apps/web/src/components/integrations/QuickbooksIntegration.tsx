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
import { formatDateTime } from "@/lib/dateTimeFormat";
import { showToast } from "../shared/Toast";
import QuickbooksCustomerImport from "./QuickbooksCustomerImport";
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

  const [status, setStatus] = useState<QuickbooksStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [savingMode, setSavingMode] = useState(false);

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
          </dl>

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
