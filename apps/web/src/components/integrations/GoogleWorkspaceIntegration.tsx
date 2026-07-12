import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Eye,
  EyeOff,
  Loader2,
  Save,
  Unplug,
  Users,
} from "lucide-react";
import { fetchWithAuth } from "../../stores/auth";
import { formatDateTime } from "@/lib/dateTimeFormat";
import { useTranslation } from "react-i18next";
import "@/lib/i18n";

type Connection = {
  connected: boolean;
  customerDomain?: string;
  adminEmail?: string;
  serviceAccountEmail?: string;
  status?: string;
  lastVerifiedAt?: string | null;
};

type SaveState = {
  status: "idle" | "saving" | "saved" | "error";
  message?: string;
};

// The exact domain-wide-delegation OAuth scopes the Google identity tools use.
// Keep in sync with ALL_DWD_SCOPES_CSV in apps/api/src/services/googleClient.ts.
const GOOGLE_DWD_SCOPES_CSV = [
  "https://www.googleapis.com/auth/admin.directory.user",
  "https://www.googleapis.com/auth/admin.directory.user.security",
  "https://www.googleapis.com/auth/admin.directory.user.alias",
  "https://www.googleapis.com/auth/admin.directory.group",
  "https://www.googleapis.com/auth/admin.directory.group.member",
  "https://www.googleapis.com/auth/admin.directory.device.mobile.action",
  "https://www.googleapis.com/auth/gmail.settings.basic",
  "https://www.googleapis.com/auth/gmail.settings.sharing",
  "https://www.googleapis.com/auth/calendar.acls",
  "https://www.googleapis.com/auth/apps.licensing",
].join(",");

export default function GoogleWorkspaceIntegration() {
  const { t } = useTranslation("integrations");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notEnabled, setNotEnabled] = useState(false);
  const [connection, setConnection] = useState<Connection | null>(null);

  const [customerDomain, setCustomerDomain] = useState("");
  const [adminEmail, setAdminEmail] = useState("");
  const [serviceAccountKey, setServiceAccountKey] = useState("");
  const [showKey, setShowKey] = useState(false);

  const [saveState, setSaveState] = useState<SaveState>({ status: "idle" });

  const isConnected = !!connection?.connected;
  // When already connected the key may be left blank to keep the stored one;
  // a fresh connection requires all three fields.
  const canSave =
    customerDomain.trim().length > 0 &&
    adminEmail.trim().length > 0 &&
    (serviceAccountKey.trim().length > 0 || isConnected);

  const fetchConnection = useCallback(async () => {
    try {
      const res = await fetchWithAuth("/google/connection");
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        const errorText = String((json as Record<string, unknown>).error ?? "");
        // A disabled feature flag (GOOGLE_WORKSPACE_ENABLED off) darks the whole
        // /google route group with a 404 "...is not enabled" body. That is a
        // normal state, not a failure — render a calm empty state, not a red error.
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
        setCustomerDomain(data.customerDomain ?? "");
        setAdminEmail(data.adminEmail ?? "");
        setServiceAccountKey("");
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
      const res = await fetchWithAuth("/google/connection", {
        method: "POST",
        body: JSON.stringify({
          customerDomain: customerDomain.trim(),
          adminEmail: adminEmail.trim(),
          serviceAccountKey: serviceAccountKey.trim(),
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        const hint = (json as Record<string, unknown>).hint;
        setSaveState({
          status: "error",
          message: `${(json as Record<string, unknown>).error ?? t("googleWorkspaceIntegration.failedToSave")}${hint ? ` — ${hint}` : ""}`,
        });
        return;
      }
      setSaveState({
        status: "saved",
        message: t("googleWorkspaceIntegration.connectionVerifiedAndSaved"),
      });
      setServiceAccountKey("");
      await fetchConnection();
    } catch (err) {
      setSaveState({
        status: "error",
        message:
          err instanceof Error
            ? err.message
            : t("googleWorkspaceIntegration.networkError"),
      });
    }
  };

  const handleDisconnect = async () => {
    setSaveState({ status: "saving" });
    try {
      const res = await fetchWithAuth("/google/connection", {
        method: "DELETE",
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        const err = (json as Record<string, unknown>).error;
        setSaveState({
          status: "error",
          message:
            typeof err === "string"
              ? err
              : t("googleWorkspaceIntegration.failedToDisconnect"),
        });
        return;
      }
      setSaveState({ status: "idle" });
      setConnection({ connected: false });
      setCustomerDomain("");
      setAdminEmail("");
      setServiceAccountKey("");
    } catch (err) {
      setSaveState({
        status: "error",
        message:
          err instanceof Error
            ? err.message
            : t("googleWorkspaceIntegration.networkError"),
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
            <Users className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-2xl font-semibold">
              {t("googleWorkspaceIntegration.googleWorkspace")}
            </h1>
            <p className="text-sm text-muted-foreground">
              {t(
                "googleWorkspaceIntegration.connectAWorkspaceDomainSoTheAIAssistant",
              )}
            </p>
          </div>
        </div>
        <div
          className="rounded-lg border bg-card p-6 text-sm text-muted-foreground"
          data-testid="google-workspace-not-enabled"
        >
          <p className="font-medium text-foreground">
            {t(
              "googleWorkspaceIntegration.googleWorkspaceIntegrationIsNotEnabledOnThis",
            )}
          </p>
          <p className="mt-1">
            {t("googleWorkspaceIntegration.anAdministratorEnablesItBySetting")}{" "}
            <code className="rounded bg-muted px-1">
              GOOGLE_WORKSPACE_ENABLED
            </code>{" "}
            {t(
              "googleWorkspaceIntegration.onTheAPIServerThenReloadingThisPage",
            )}
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
          <Users className="h-5 w-5" />
        </div>
        <div>
          <h1 className="text-2xl font-semibold">
            {t("googleWorkspaceIntegration.googleWorkspace")}
          </h1>
          <p className="text-sm text-muted-foreground">
            {t(
              "googleWorkspaceIntegration.connectAWorkspaceDomainSoTheAIAssistant2",
            )}
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
          {t("googleWorkspaceIntegration.connection")}
        </h2>
        <p className="mb-4 text-sm text-muted-foreground">
          {t("googleWorkspaceIntegration.pasteTheServiceAccountJSONKeyAndThe")}
          {!isConnected && " Saving requires MFA verification."}
        </p>

        <details className="mb-4 rounded-md border bg-muted/40 p-3 text-sm">
          <summary className="cursor-pointer font-medium">
            {t("googleWorkspaceIntegration.howToGetTheServiceAccountJSONAnd")}
          </summary>
          <ol className="mt-3 list-decimal space-y-1.5 pl-5 text-muted-foreground">
            <li>
              {t("googleWorkspaceIntegration.inThe")}
              <span className="font-medium text-foreground">
                {t("googleWorkspaceIntegration.googleCloudConsole")}
              </span>
              {t("googleWorkspaceIntegration.open")}{" "}
              <span className="font-medium text-foreground">
                {t("googleWorkspaceIntegration.iamAndAdminServiceAccounts")}
              </span>{" "}
              {t(
                "googleWorkspaceIntegration.andCreateOneOrPickAnExistingService",
              )}
            </li>
            <li>
              {t("googleWorkspaceIntegration.openTheServiceAccountGoToThe")}
              <span className="font-medium text-foreground">
                {t("googleWorkspaceIntegration.keys")}
              </span>{" "}
              {t("googleWorkspaceIntegration.tab")}{" "}
              <span className="font-medium text-foreground">
                {t("googleWorkspaceIntegration.addKeyCreateNewKeyJSONCreate")}
              </span>
              {t(
                "googleWorkspaceIntegration.theJSONDownloadsOnceThatFileIsWhat",
              )}{" "}
              <span className="font-medium text-foreground">
                {t("googleWorkspaceIntegration.clientID")}
              </span>{" "}
              {t("googleWorkspaceIntegration.itsNumericUniqueID")}
            </li>
            <li>
              {t("googleWorkspaceIntegration.enableTheAPIsTheToolsUseInThat")}{" "}
              <span className="font-medium text-foreground">
                {t(
                  "googleWorkspaceIntegration.adminSDKGmailCalendarEnterpriseLicenseManager",
                )}
              </span>
              .
            </li>
            <li>
              {t("googleWorkspaceIntegration.inThe")}
              <span className="font-medium text-foreground">
                {t("googleWorkspaceIntegration.googleAdminConsole")}
              </span>
              {t("googleWorkspaceIntegration.goTo")}{" "}
              <span className="font-medium text-foreground">
                {t(
                  "googleWorkspaceIntegration.securityAccessAndDataControlAPIControlsManage",
                )}
              </span>
              {t(
                "googleWorkspaceIntegration.pasteTheServiceAccountsClientIDAndIn",
              )}
            </li>
          </ol>
          <p className="mt-3 font-medium text-foreground">
            {t("googleWorkspaceIntegration.oauthScopesToAuthorize")}
          </p>
          <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded bg-background p-2 chart-legend-xs leading-relaxed text-muted-foreground">
            {GOOGLE_DWD_SCOPES_CSV}
          </pre>
        </details>

        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <label className="mb-1 block text-sm font-medium">
              {t("googleWorkspaceIntegration.primaryDomain")}
            </label>
            <input
              type="text"
              value={customerDomain}
              onChange={(e) => setCustomerDomain(e.target.value)}
              placeholder="example.com"
              className="h-10 w-full rounded-md border bg-background px-3 text-sm outline-hidden focus:ring-2 focus:ring-primary/30"
            />
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium">
              {t("googleWorkspaceIntegration.superAdminEmailImpersonated")}
            </label>
            <input
              type="email"
              value={adminEmail}
              onChange={(e) => setAdminEmail(e.target.value)}
              placeholder={t("googleWorkspaceIntegration.adminExampleCom")}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm outline-hidden focus:ring-2 focus:ring-primary/30"
            />
          </div>

          <div className="md:col-span-2">
            <label className="mb-1 block text-sm font-medium">
              {t("googleWorkspaceIntegration.serviceAccountJSONKey")}
              {isConnected && (
                <span className="ml-1 text-xs text-muted-foreground">
                  {t("googleWorkspaceIntegration.leaveBlankToKeepTheStoredKey")}
                </span>
              )}
            </label>
            <div className="relative">
              <textarea
                value={serviceAccountKey}
                onChange={(e) => setServiceAccountKey(e.target.value)}
                rows={showKey ? 10 : 3}
                placeholder={
                  isConnected
                    ? "•••••••••• (stored, encrypted)"
                    : "Paste the full service-account JSON key file here"
                }
                className={`w-full rounded-md border bg-background px-3 py-2 text-sm outline-hidden focus:ring-2 focus:ring-primary/30 ${showKey ? "" : "blur-[3px] focus:blur-0"}`}
              />
              <button
                type="button"
                onClick={() => setShowKey(!showKey)}
                className="absolute right-2 top-2 text-muted-foreground hover:text-foreground"
                aria-label={
                  showKey
                    ? t("googleWorkspaceIntegration.hideKey")
                    : t("googleWorkspaceIntegration.showKey")
                }
              >
                {showKey ? (
                  <EyeOff className="h-4 w-4" />
                ) : (
                  <Eye className="h-4 w-4" />
                )}
              </button>
            </div>
          </div>
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
              ? t("googleWorkspaceIntegration.updateConnection")
              : t("googleWorkspaceIntegration.saveAndVerify")}
          </button>
          {isConnected && (
            <button
              type="button"
              onClick={handleDisconnect}
              disabled={saveState.status === "saving"}
              className="inline-flex h-10 items-center gap-2 rounded-md border px-4 text-sm font-medium hover:bg-muted disabled:opacity-50"
            >
              <Unplug className="h-4 w-4" />{" "}
              {t("googleWorkspaceIntegration.disconnect")}
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
            {t("googleWorkspaceIntegration.connectionDetails")}
          </h2>
          <div className="mt-4 space-y-2 text-sm">
            <div className="flex justify-between text-muted-foreground">
              <span>{t("googleWorkspaceIntegration.domain")}</span>
              <span className="text-foreground">
                {connection?.customerDomain}
              </span>
            </div>
            <div className="flex justify-between text-muted-foreground">
              <span>{t("googleWorkspaceIntegration.adminImpersonated")}</span>
              <span className="text-foreground">{connection?.adminEmail}</span>
            </div>
            <div className="flex justify-between text-muted-foreground">
              <span>{t("googleWorkspaceIntegration.serviceAccount")}</span>
              <span className="text-foreground">
                {connection?.serviceAccountEmail}
              </span>
            </div>
            <div className="flex justify-between text-muted-foreground">
              <span>{t("googleWorkspaceIntegration.lastVerified")}</span>
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
