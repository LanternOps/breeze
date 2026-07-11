import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Eye,
  EyeOff,
  Loader2,
  Save,
  Unplug,
  Building2,
} from "lucide-react";
import { fetchWithAuth } from "../../stores/auth";
import { formatDateTime } from "@/lib/dateTimeFormat";
import { useTranslation } from "react-i18next";
import "@/lib/i18n";

type Connection = {
  connected: boolean;
  tenantId?: string;
  clientId?: string;
  displayName?: string | null;
  status?: string;
  lastVerifiedAt?: string | null;
};

type SaveState = {
  status: "idle" | "saving" | "saved" | "error";
  message?: string;
};

export default function M365Integration() {
  const { t } = useTranslation("integrations");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notEnabled, setNotEnabled] = useState(false);
  const [connection, setConnection] = useState<Connection | null>(null);

  const [tenantId, setTenantId] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [showSecret, setShowSecret] = useState(false);

  const [saveState, setSaveState] = useState<SaveState>({ status: "idle" });

  const isConnected = !!connection?.connected;
  const canSave =
    tenantId.trim().length > 0 &&
    clientId.trim().length > 0 &&
    (clientSecret.trim().length > 0 || isConnected);

  const fetchConnection = useCallback(async () => {
    try {
      const res = await fetchWithAuth("/m365/connection");
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        const errorText = String((json as Record<string, unknown>).error ?? "");
        // A disabled feature flag (M365_ENABLED off) darks the whole /m365 route
        // group with a 404 "...is not enabled" body. That is a normal state, not
        // a failure — render a calm empty state, not a red error.
        if (res.status === 404 && /not enabled/i.test(errorText)) {
          setNotEnabled(true);
          return;
        }
        setLoadError(
          `Failed to load connection (${res.status}): ${(json as Record<string, unknown>).error ?? res.statusText}`,
        );
        return;
      }
      const data = (await res.json()) as Connection;
      setConnection(data);
      if (data.connected) {
        setTenantId(data.tenantId ?? "");
        setClientId(data.clientId ?? "");
        setClientSecret("");
      }
    } catch (err) {
      setLoadError(
        `Failed to load connection: ${err instanceof Error ? err.message : "Network error"}`,
      );
    }
  }, []);

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      await fetchConnection();
      setLoading(false);
    };
    load();
  }, [fetchConnection]);

  const handleSave = async () => {
    setSaveState({ status: "saving" });
    try {
      const res = await fetchWithAuth("/m365/connection", {
        method: "POST",
        body: JSON.stringify({
          tenantId: tenantId.trim(),
          clientId: clientId.trim(),
          clientSecret: clientSecret.trim(),
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        const hint = (json as Record<string, unknown>).hint;
        setSaveState({
          status: "error",
          message: `${(json as Record<string, unknown>).error ?? t("m365Integration.failedToSave")}${hint ? ` — ${hint}` : ""}`,
        });
        return;
      }
      setSaveState({
        status: "saved",
        message: t("m365Integration.connectionVerifiedAndSaved"),
      });
      setClientSecret("");
      await fetchConnection();
    } catch (err) {
      setSaveState({
        status: "error",
        message:
          err instanceof Error
            ? err.message
            : t("m365Integration.networkError"),
      });
    }
  };

  const handleDisconnect = async () => {
    setSaveState({ status: "saving" });
    try {
      const res = await fetchWithAuth("/m365/connection", { method: "DELETE" });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        const err = (json as Record<string, unknown>).error;
        setSaveState({
          status: "error",
          message:
            typeof err === "string"
              ? err
              : t("m365Integration.failedToDisconnect"),
        });
        return;
      }
      setSaveState({ status: "idle" });
      setConnection({ connected: false });
      setTenantId("");
      setClientId("");
      setClientSecret("");
    } catch (err) {
      setSaveState({
        status: "error",
        message:
          err instanceof Error
            ? err.message
            : t("m365Integration.networkError"),
      });
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (notEnabled) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Building2 className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-2xl font-semibold">
              {t("m365Integration.microsoft365")}
            </h1>
            <p className="text-sm text-muted-foreground">
              {t("m365Integration.connectAnEntraAzureADAppRegistrationSo")}
            </p>
          </div>
        </div>
        <div
          className="rounded-lg border bg-card p-6 text-sm text-muted-foreground"
          data-testid="m365-not-enabled"
        >
          <p className="font-medium text-foreground">
            {t("m365Integration.microsoft365IntegrationIsNotEnabledOnThis")}
          </p>
          <p className="mt-1">
            {t("m365Integration.anAdministratorEnablesItBySetting")}{" "}
            <code className="rounded bg-muted px-1">M365_ENABLED</code>{" "}
            {t("m365Integration.onTheAPIServerThenReloadingThisPage")}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Building2 className="h-5 w-5" />
        </div>
        <div>
          <h1 className="text-2xl font-semibold">
            {t("m365Integration.microsoft365")}
          </h1>
          <p className="text-sm text-muted-foreground">
            {t("m365Integration.connectAnEntraAzureADAppRegistrationSo2")}
          </p>
        </div>
        {isConnected ? (
          <span className="ml-auto inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs text-emerald-700">
            <CheckCircle2 className="h-3.5 w-3.5" /> {t("common:states.active")}
          </span>
        ) : (
          <span className="ml-auto inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs text-slate-600">
            <Unplug className="h-3.5 w-3.5" /> {t("common:states.inactive")}
          </span>
        )}
      </div>

      {loadError && (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {loadError}
        </div>
      )}

      {/* Connection card */}
      <div className="rounded-xl border bg-card p-6 shadow-xs">
        <h2 className="text-lg font-semibold">
          {t("m365Integration.connection")}
        </h2>
        <p className="mb-4 text-sm text-muted-foreground">
          {t("m365Integration.enterTheTenantIdAppClientIdAnd")}
          {!isConnected && " Saving requires MFA verification."}
        </p>

        <details className="mb-4 rounded-md border bg-muted/40 p-3 text-sm">
          <summary className="cursor-pointer font-medium">
            {t("m365Integration.howToGetTheTenantIdAppId")}
          </summary>
          <ol className="mt-3 list-decimal space-y-1.5 pl-5 text-muted-foreground">
            <li>
              {t("m365Integration.inThe")}
              <span className="font-medium text-foreground">
                {t("m365Integration.microsoftEntraAdminCenter")}
              </span>{" "}
              {t("m365Integration.entraMicrosoftComOrAzurePortalOpen")}
              <span className="font-medium text-foreground">
                {t("m365Integration.microsoftEntraIDAppRegistrations")}
              </span>
              {t("m365Integration.pickAnExistingAppOrClick")}
              <span className="font-medium text-foreground">
                {t("m365Integration.newRegistration")}
              </span>{" "}
              {t("m365Integration.giveItANameChooseAccountsInThis")}
            </li>
            <li>
              {t("m365Integration.onTheApp")}
              <span className="font-medium text-foreground">
                {t("m365Integration.overview")}
              </span>
              {t("m365Integration.copyThe")}{" "}
              <span className="font-medium text-foreground">
                {t("m365Integration.directoryTenantID")}
              </span>{" "}
              {t("m365Integration.andThe")}{" "}
              <span className="font-medium text-foreground">
                {t("m365Integration.applicationClientID")}
              </span>{" "}
              {t("m365Integration.intoTheFieldsBelow")}
            </li>
            <li>
              {t("m365Integration.goTo")}
              <span className="font-medium text-foreground">
                {t(
                  "m365Integration.certificatesAndSecretsClientSecretsNewClientSecret",
                )}
              </span>
              {t("m365Integration.setADescriptionAndExpiry24MonthsMax")}{" "}
              <span className="font-medium text-foreground">
                {t("m365Integration.copyTheSecretValueImmediately")}
              </span>{" "}
              {t("m365Integration.notTheSecretIDItIsShownOnly")}
            </li>
            <li>
              {t("m365Integration.under")}
              <span className="font-medium text-foreground">
                {t("m365Integration.apiPermissions")}
              </span>
              {t("m365Integration.addTheMicrosoftGraph")}{" "}
              <span className="font-medium text-foreground">
                {t("m365Integration.application")}
              </span>{" "}
              {t("m365Integration.permissionsListedBelowThen")}{" "}
              <span className="font-medium text-foreground">
                {t("m365Integration.grantAdminConsent")}
              </span>
              .
            </li>
          </ol>
        </details>

        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <label className="mb-1 block text-sm font-medium">
              {t("m365Integration.tenantID")}
            </label>
            <input
              type="text"
              value={tenantId}
              onChange={(e) => setTenantId(e.target.value)}
              placeholder={t(
                "m365Integration.contosoOnmicrosoftComOrTenantGUID",
              )}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm outline-hidden focus:ring-2 focus:ring-primary/30"
            />
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium">
              {t("m365Integration.appClientID")}
            </label>
            <input
              type="text"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              placeholder={t("m365Integration.applicationClientId")}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm outline-hidden focus:ring-2 focus:ring-primary/30"
            />
          </div>

          <div className="md:col-span-2">
            <label className="mb-1 block text-sm font-medium">
              {t("m365Integration.clientSecret")}
              {isConnected && (
                <span className="ml-1 text-xs text-muted-foreground">
                  {t("m365Integration.leaveBlankToKeepTheStoredSecret")}
                </span>
              )}
            </label>
            <div className="relative">
              <input
                type={showSecret ? "text" : "password"}
                value={clientSecret}
                onChange={(e) => setClientSecret(e.target.value)}
                placeholder={
                  isConnected
                    ? "•••••••••• (stored, encrypted)"
                    : "app client secret"
                }
                className="h-10 w-full rounded-md border bg-background px-3 pr-10 text-sm outline-hidden focus:ring-2 focus:ring-primary/30"
              />
              <button
                type="button"
                onClick={() => setShowSecret(!showSecret)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                aria-label={
                  showSecret
                    ? t("m365Integration.hideSecret")
                    : t("m365Integration.showSecret")
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
        </div>

        <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
          {t("m365Integration.readsLookupGroupsSignInsNeed")}
          <span className="font-medium">User.Read.All</span>,{" "}
          <span className="font-medium">Group.Read.All</span>,{" "}
          <span className="font-medium">AuditLog.Read.All</span>
          {t("m365Integration.toUseTheDisableUserAndResetPassword")}{" "}
          <span className="font-medium">User.ReadWrite.All</span> +{" "}
          <span className="font-medium">
            User-PasswordProfile.ReadWrite.All
          </span>{" "}
          {t("m365Integration.andThe")}{" "}
          <span className="font-medium">
            {t("m365Integration.userAdministrator")}
          </span>{" "}
          {t("m365Integration.entraRole")}
        </div>

        <div className="mt-4 flex items-center gap-3">
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
            {isConnected
              ? t("m365Integration.updateConnection")
              : t("m365Integration.saveAndVerify")}
          </button>
          {isConnected && (
            <button
              type="button"
              onClick={handleDisconnect}
              disabled={saveState.status === "saving"}
              className="inline-flex h-10 items-center gap-2 rounded-md border px-4 text-sm font-medium hover:bg-muted disabled:opacity-50"
            >
              <Unplug className="h-4 w-4" /> {t("m365Integration.disconnect")}
            </button>
          )}
          {saveState.status === "saved" && (
            <span className="text-sm text-emerald-600">
              {saveState.message}
            </span>
          )}
          {saveState.status === "error" && (
            <span className="inline-flex items-center gap-1 text-sm text-red-600">
              <AlertTriangle className="h-4 w-4" /> {saveState.message}
            </span>
          )}
        </div>
      </div>

      {/* Status card */}
      {isConnected && (
        <div className="rounded-xl border bg-card p-6 shadow-xs">
          <h2 className="text-lg font-semibold">
            {t("m365Integration.connectionDetails")}
          </h2>
          <div className="mt-4 space-y-2 text-sm">
            <div className="flex justify-between text-muted-foreground">
              <span>{t("m365Integration.tenant")}</span>
              <span className="text-foreground">
                {connection?.displayName ?? connection?.tenantId}
              </span>
            </div>
            <div className="flex justify-between text-muted-foreground">
              <span>{t("m365Integration.tenantID")}</span>
              <span className="text-foreground">{connection?.tenantId}</span>
            </div>
            <div className="flex justify-between text-muted-foreground">
              <span>{t("m365Integration.appClientID")}</span>
              <span className="text-foreground">{connection?.clientId}</span>
            </div>
            <div className="flex justify-between text-muted-foreground">
              <span>{t("m365Integration.lastVerified")}</span>
              <span className="text-foreground">
                {connection?.lastVerifiedAt
                  ? formatDateTime(connection.lastVerifiedAt)
                  : "Never"}
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
