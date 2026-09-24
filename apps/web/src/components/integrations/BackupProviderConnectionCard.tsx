import { useState } from "react";
import { Activity, AlertTriangle, CheckCircle2, Eye, EyeOff, Loader2, RefreshCw, Save, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import { fetchWithAuth } from "../../stores/auth";
import { showToast } from "../shared/Toast";
import { ActionError, handleActionError, runAction } from "@/lib/runAction";
import { formatRelativeTime } from "@/lib/dateTimeFormat";
import "@/lib/i18n";

export type BackupProviderConnection = {
  id: string;
  provider: string;
  name: string;
  baseUrl: string;
  vendorRootName: string | null;
  isActive: boolean;
  status: "connected" | "error" | "reauth_required";
  syncIntervalMinutes: number;
  showProviderNameInPortal: boolean;
  lastSyncAt: string | null;
  lastSyncStatus: "running" | "success" | "partial" | "error" | null;
  lastSyncError: string | null;
  lastSyncCustomers: number | null;
  lastSyncUnmappedCustomers: number | null;
  lastSyncDevices: number | null;
  lastSyncUnmappedDevices: number | null;
  lastSyncLinkedDevices: number | null;
  lastSyncAmbiguousDevices: number | null;
  hasCredentials: boolean;
};

export type BackupProviderTestResult = {
  success: boolean;
  message?: string;
  error?: string;
  rootName?: string;
  customerCount?: number;
};

/**
 * Copied from SecurityIntegration.tsx:76-119 rather than imported: that one is
 * file-local and typed against Huntress' own row shape. A shared badge would
 * have to satisfy two value domains for no gain.
 */
function syncStatusBadge(connection: BackupProviderConnection, t: (key: string) => string) {
  if (connection.lastSyncStatus === "success" || connection.lastSyncStatus === "partial") {
    return (
      <span data-testid="backup-connection-badge-active" className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs text-emerald-700">
        <CheckCircle2 className="h-3.5 w-3.5" /> {t("common:states.active")}
      </span>
    );
  }
  if (connection.lastSyncStatus === "running") {
    return (
      <span data-testid="backup-connection-badge-syncing" className="inline-flex items-center gap-1.5 rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-xs text-amber-700">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> {t("common:states.processing")}
      </span>
    );
  }
  if (connection.lastSyncStatus === "error") {
    return (
      <span data-testid="backup-connection-badge-error" className="inline-flex items-center gap-1.5 rounded-full border border-red-200 bg-red-50 px-3 py-1 text-xs text-red-700">
        <AlertTriangle className="h-3.5 w-3.5" /> {t("common:states.error")}
      </span>
    );
  }
  return (
    <span data-testid="backup-connection-badge-pending" className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs text-slate-600">
      <Activity className="h-3.5 w-3.5" /> {t("common:states.pending")}
    </span>
  );
}

function Counter({ testId, label, value }: { testId: string; label: string; value: number | null }) {
  // Label and number are SEPARATE elements on purpose: extractionQuality.test.ts
  // bans `{t('k')}{expr}` adjacency, and a `{{count}}` interpolation would pull
  // the whole key into keyUsage's plural contract.
  return (
    <div data-testid={testId} className="rounded-md border bg-muted/20 px-3 py-2">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm font-semibold text-foreground">{value ?? 0}</dd>
    </div>
  );
}

export default function BackupProviderConnectionCard({
  connection,
  onChanged,
  onTestResult,
}: {
  connection: BackupProviderConnection;
  onChanged: () => void;
  onTestResult: (result: BackupProviderTestResult) => void;
}) {
  const { t } = useTranslation("integrations");
  const [name, setName] = useState(connection.name);
  const [isActive, setIsActive] = useState(connection.isActive);
  const [showInPortal, setShowInPortal] = useState(connection.showProviderNameInPortal);
  const [editingCredentials, setEditingCredentials] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [partnerName, setPartnerName] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState<null | "test" | "sync" | "save" | "delete">(null);

  const handleTest = async () => {
    setBusy("test");
    try {
      // The route answers HTTP 200 with {success:false} on a rejected
      // credential; runAction treats that as a failure and toasts it. The modal
      // still opens in BOTH branches — it carries the provider's own message,
      // which a toast alone truncates the context of (PsaConnectionsPage.tsx:235).
      const result = await runAction<BackupProviderTestResult>({
        request: () => fetchWithAuth(`/backup/providers/connections/${connection.id}/test`, { method: "POST" }),
        errorFallback: t("backupProviders.errorTest"),
      });
      onTestResult(result);
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) showToast({ type: "error", message: t("backupProviders.errorTest") });
      const body = err instanceof ActionError ? (err.body as BackupProviderTestResult | undefined) : undefined;
      onTestResult({ success: false, error: body?.error ?? (err instanceof Error ? err.message : t("backupProviders.errorTest")) });
    } finally {
      setBusy(null);
    }
  };

  const handleSync = async () => {
    setBusy("sync");
    try {
      await runAction({
        request: () => fetchWithAuth(`/backup/providers/connections/${connection.id}/sync`, { method: "POST" }),
        errorFallback: t("backupProviders.errorSync"),
        successMessage: t("backupProviders.syncQueuedToast"),
      });
      onChanged();
    } catch (err) {
      handleActionError(err, t("backupProviders.errorSync"));
    } finally {
      setBusy(null);
    }
  };

  const handleSave = async () => {
    setBusy("save");
    const body: Record<string, unknown> = { name, isActive, showProviderNameInPortal: showInPortal };
    // A blank password means "keep the stored secret" — never send an empty
    // credentials blob, which the API would re-encrypt over a working one.
    if (editingCredentials && password.trim()) {
      body.credentials = { partnerName: partnerName.trim(), username: username.trim(), password };
    }
    try {
      await runAction({
        request: () =>
          fetchWithAuth(`/backup/providers/connections/${connection.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }),
        errorFallback: t("backupProviders.errorSave"),
        successMessage: t("backupProviders.savedToast"),
      });
      setEditingCredentials(false);
      setPassword("");
      onChanged();
    } catch (err) {
      handleActionError(err, t("backupProviders.errorSave"));
    } finally {
      setBusy(null);
    }
  };

  const handleDelete = async () => {
    if (!window.confirm(t("backupProviders.deleteConfirm", { name: connection.name }))) return;
    setBusy("delete");
    try {
      await runAction({
        request: () => fetchWithAuth(`/backup/providers/connections/${connection.id}`, { method: "DELETE" }),
        errorFallback: t("backupProviders.errorDelete"),
        successMessage: t("backupProviders.deletedToast"),
      });
      onChanged();
    } catch (err) {
      handleActionError(err, t("backupProviders.errorDelete"));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div data-testid={`backup-connection-${connection.id}`} className="rounded-lg border bg-card p-5 shadow-xs">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-foreground">{connection.name}</h3>
          <p className="text-sm text-muted-foreground">{t("backupProviders.cove")}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {connection.lastSyncAt
              ? t("backupProviders.lastSync", { relative: formatRelativeTime(connection.lastSyncAt) })
              : t("backupProviders.neverSynced")}
          </p>
        </div>
        {syncStatusBadge(connection, t)}
      </div>

      {connection.status === "reauth_required" && (
        <div className="mt-4 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">
          <p className="font-medium">{t("backupProviders.reauthRequired")}</p>
          <button
            type="button"
            data-testid="backup-connection-reauth"
            onClick={() => setEditingCredentials(true)}
            className="mt-2 rounded-md border border-amber-400 bg-white px-3 py-1.5 text-xs font-medium text-amber-900"
          >
            {t("backupProviders.reenterCredentials")}
          </button>
        </div>
      )}

      {connection.lastSyncError && (
        <div data-testid="backup-connection-sync-error" className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
          <p className="font-medium">{t("backupProviders.syncErrorTitle")}</p>
          <p className="mt-1 break-words">{connection.lastSyncError}</p>
        </div>
      )}

      <dl className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-5">
        <Counter testId="backup-connection-customers" label={t("backupProviders.customers")} value={connection.lastSyncCustomers} />
        <Counter testId="backup-connection-devices" label={t("backupProviders.devices")} value={connection.lastSyncDevices} />
        <Counter testId="backup-connection-linked" label={t("backupProviders.linked")} value={connection.lastSyncLinkedDevices} />
        <Counter testId="backup-connection-unmapped-devices" label={t("backupProviders.unmappedDevices")} value={connection.lastSyncUnmappedDevices} />
        <Counter testId="backup-connection-ambiguous" label={t("backupProviders.ambiguous")} value={connection.lastSyncAmbiguousDevices} />
      </dl>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <label className="text-sm">
          <span className="text-xs text-muted-foreground">{t("common:labels.name")}</span>
          <input
            data-testid="backup-connection-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm"
          />
        </label>
        <div className="flex flex-col justify-end gap-2">
          <label className="flex items-center gap-2 text-sm">
            <input data-testid="backup-connection-active" type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
            <span>{t("common:states.active")}</span>
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input data-testid="backup-connection-portal-toggle" type="checkbox" checked={showInPortal} onChange={(e) => setShowInPortal(e.target.checked)} />
            <span>{t("backupProviders.portalLabelToggle")}</span>
          </label>
          <p className="text-xs text-muted-foreground">{t("backupProviders.portalLabelHelp")}</p>
        </div>
      </div>

      {editingCredentials && (
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <label className="text-sm">
            <span className="text-xs text-muted-foreground">{t("backupProviders.partnerNameLabel")}</span>
            <input data-testid="backup-connection-partner-name" value={partnerName} onChange={(e) => setPartnerName(e.target.value)} className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm" />
          </label>
          <label className="text-sm">
            <span className="text-xs text-muted-foreground">{t("backupProviders.usernameLabel")}</span>
            <input data-testid="backup-connection-username" autoComplete="off" value={username} onChange={(e) => setUsername(e.target.value)} className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm" />
          </label>
          <label className="text-sm">
            <span className="text-xs text-muted-foreground">{t("backupProviders.passwordLabel")}</span>
            <div className="mt-1 flex items-center gap-1">
              <input
                data-testid="backup-connection-password"
                type={showPassword ? "text" : "password"}
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="h-9 w-full rounded-md border bg-background px-2 text-sm"
              />
              <button
                type="button"
                data-testid="backup-connection-password-toggle"
                aria-label={showPassword ? t("backupProviders.hidePassword") : t("backupProviders.showPassword")}
                onClick={() => setShowPassword((v) => !v)}
                className="rounded-md border px-2 py-1.5"
              >
                {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </label>
        </div>
      )}

      <div className="mt-4 flex flex-wrap gap-2">
        <button type="button" data-testid="backup-connection-test" disabled={busy !== null} onClick={() => void handleTest()} className="inline-flex items-center gap-2 rounded-md border bg-card px-3 py-1.5 text-sm font-medium disabled:opacity-50">
          {busy === "test" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Activity className="h-4 w-4" />}
          {t("backupProviders.test")}
        </button>
        <button type="button" data-testid="backup-connection-sync" disabled={busy !== null} onClick={() => void handleSync()} className="inline-flex items-center gap-2 rounded-md border bg-card px-3 py-1.5 text-sm font-medium disabled:opacity-50">
          <RefreshCw className="h-4 w-4" /> {t("backupProviders.syncNow")}
        </button>
        <button type="button" data-testid="backup-connection-save" disabled={busy !== null} onClick={() => void handleSave()} className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50">
          <Save className="h-4 w-4" /> {t("common:actions.save")}
        </button>
        <button type="button" data-testid="backup-connection-delete" disabled={busy !== null} onClick={() => void handleDelete()} className="ml-auto inline-flex items-center gap-2 rounded-md border border-destructive/40 px-3 py-1.5 text-sm font-medium text-destructive disabled:opacity-50">
          <Trash2 className="h-4 w-4" /> {t("common:actions.delete")}
        </button>
      </div>
    </div>
  );
}
