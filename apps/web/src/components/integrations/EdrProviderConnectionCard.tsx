import { useState } from "react";
import { Activity, AlertTriangle, CheckCircle2, Loader2, RefreshCw, Save, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import { ConfirmDialog } from "../shared/ConfirmDialog";
import { showToast } from "../shared/Toast";
import {
  deleteEdrConnection,
  disableEdrPush,
  enableEdrPush,
  edrProviderLabel,
  patchEdrConnection,
  sendEdrPushTest,
  syncEdrConnection,
  testEdrConnection,
  type EdrConnection,
  type EdrConnectionPatchBody,
  type EdrConnectionTestResult,
  type EdrDeleteConfirmCounts,
  type EdrProviderDescriptor,
} from "@/lib/edrProviders";
import { formatRelativeTime } from "@/lib/dateTimeFormat";
import { ActionError, handleActionError } from "@/lib/runAction";
import "@/lib/i18n";

export type { EdrConnection, EdrConnectionTestResult };

const INTERVAL_MIN = 1;
const INTERVAL_MAX = 1440;

/** Blank = provider default (null); otherwise an integer in range, else undefined (invalid). */
function parseInterval(raw: string): number | null | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  if (!/^\d+$/.test(trimmed)) return undefined;
  const n = Number(trimmed);
  return n >= INTERVAL_MIN && n <= INTERVAL_MAX ? n : undefined;
}

function Counter({ testId, label, value }: { testId: string; label: string; value: number | null }) {
  // Label and number are SEPARATE elements on purpose: extractionQuality.test.ts
  // bans `{t('k')}{expr}` adjacency.
  return (
    <div data-testid={testId} className="rounded-md border bg-muted/20 px-3 py-2">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm font-semibold text-foreground">{value ?? 0}</dd>
    </div>
  );
}

function StatusBadge({ status }: { status: EdrConnection["status"] }) {
  const { t } = useTranslation("integrations");
  if (status === "connected") {
    return (
      <span data-testid="edr-connection-badge-connected" className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs text-emerald-700">
        <CheckCircle2 className="h-3.5 w-3.5" /> {t("edrProviders.status.connected")}
      </span>
    );
  }
  if (status === "reauth_required") {
    return (
      <span data-testid="edr-connection-badge-reauth" className="inline-flex items-center gap-1.5 rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-xs text-amber-700">
        <AlertTriangle className="h-3.5 w-3.5" /> {t("edrProviders.status.reauth_required")}
      </span>
    );
  }
  return (
    <span data-testid="edr-connection-badge-error" className="inline-flex items-center gap-1.5 rounded-full border border-red-200 bg-red-50 px-3 py-1 text-xs text-red-700">
      <AlertTriangle className="h-3.5 w-3.5" /> {t("edrProviders.status.error")}
    </span>
  );
}

function StreamRow({
  testId,
  label,
  lastAt,
  lastStatus,
  lastError,
  cadenceMinutes,
}: {
  testId: string;
  label: string;
  lastAt: string | null;
  lastStatus: string | null;
  lastError: string | null;
  cadenceMinutes: number | null;
}) {
  const { t } = useTranslation("integrations");
  return (
    <div data-testid={testId} className="rounded-md border bg-muted/10 p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium text-foreground">{label}</span>
        {cadenceMinutes != null && (
          <span className="text-xs text-muted-foreground">{t("edrProviders.cadence", { minutes: cadenceMinutes })}</span>
        )}
      </div>
      <p className="mt-1 flex flex-wrap gap-x-2 text-xs text-muted-foreground">
        <span data-testid={`${testId}-last`}>
          {lastAt ? t("edrProviders.lastSync", { relative: formatRelativeTime(lastAt) }) : t("edrProviders.neverSynced")}
        </span>
        {lastStatus && (
          <span data-testid={`${testId}-status`}>{t(/* i18n-dynamic */ `edrProviders.syncStatus.${lastStatus}`)}</span>
        )}
      </p>
      {lastError && <p className="mt-1 break-words text-xs text-destructive">{lastError}</p>}
    </div>
  );
}

export default function EdrProviderConnectionCard({
  connection,
  provider,
  canManage,
  onChanged,
  onTestResult,
}: {
  connection: EdrConnection;
  provider: EdrProviderDescriptor | undefined;
  canManage: boolean;
  onChanged: () => void;
  onTestResult: (result: EdrConnectionTestResult) => void;
}) {
  const { t } = useTranslation("integrations");
  const [name, setName] = useState(connection.name);
  const [isActive, setIsActive] = useState(connection.isActive);
  const [detectionInterval, setDetectionInterval] = useState(
    connection.detectionIntervalMinutes != null ? String(connection.detectionIntervalMinutes) : "",
  );
  const [inventoryInterval, setInventoryInterval] = useState(
    connection.inventoryIntervalMinutes != null ? String(connection.inventoryIntervalMinutes) : "",
  );
  const [editingCredentials, setEditingCredentials] = useState(false);
  const [creds, setCreds] = useState<Record<string, string>>({});
  const [baseUrl, setBaseUrl] = useState("");
  const [busy, setBusy] = useState<null | "test" | "sync" | "save" | "delete" | "actions" | "push" | "pushTest">(null);
  const [confirmActions, setConfirmActions] = useState(false);
  const [testSent, setTestSent] = useState(false);

  const providerLabel = edrProviderLabel(connection.provider) ?? provider?.label ?? connection.provider;
  const fields = provider?.credentialFields ?? [];
  const detection = parseInterval(detectionInterval);
  const inventory = parseInterval(inventoryInterval);
  const enteredCreds = editingCredentials && fields.some((f) => (creds[f.name] ?? "").trim() !== "");
  const missingRequired = enteredCreds && fields.some((f) => f.required && (creds[f.name] ?? "").trim() === "");
  const saveDisabled = busy !== null || !name.trim() || detection === undefined || inventory === undefined || missingRequired;
  const actions = Array.isArray(connection.capabilitiesSnapshot?.actions)
    ? (connection.capabilitiesSnapshot.actions as unknown[]).filter((a): a is string => typeof a === "string")
    : [];

  const handleTest = async () => {
    setBusy("test");
    try {
      // A rejected credential answers HTTP 200 {success:false}; runAction toasts
      // it as a failure. The modal still opens in BOTH branches: it carries the
      // provider's own message.
      const result = await testEdrConnection(connection.id, { errorFallback: t("edrProviders.errorTest") });
      onTestResult(result);
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) showToast({ type: "error", message: t("edrProviders.errorTest") });
      const body = err instanceof ActionError ? (err.body as EdrConnectionTestResult | undefined) : undefined;
      onTestResult({
        success: false,
        error: body?.error ?? (err instanceof Error ? err.message : t("edrProviders.errorTest")),
        reauth: body?.reauth,
      });
    } finally {
      // The API persists the outcome (status, possibly reauth_required) right
      // away; refetch so the badge/banner reflect it without a reload.
      onChanged();
      setBusy(null);
    }
  };

  const handleSync = async () => {
    setBusy("sync");
    try {
      await syncEdrConnection(connection.id, {
        errorFallback: t("edrProviders.errorSync"),
        successMessage: t("edrProviders.syncQueuedToast"),
      });
      onChanged();
    } catch (err) {
      handleActionError(err, t("edrProviders.errorSync"));
    } finally {
      setBusy(null);
    }
  };

  const handleSave = async () => {
    if (detection === undefined || inventory === undefined) return;
    setBusy("save");
    const body: EdrConnectionPatchBody = {
      name: name.trim(),
      isActive,
      detectionIntervalMinutes: detection,
      inventoryIntervalMinutes: inventory,
    };
    // A blank form means "keep the stored secret" — never send an empty
    // credentials blob, which the API would re-encrypt over a working one.
    if (enteredCreds) {
      body.credentials = Object.fromEntries(
        fields.filter((f) => (creds[f.name] ?? "").trim() !== "").map((f) => [f.name, creds[f.name]!.trim()]),
      );
    }
    // Independent of enteredCreds: a URL-only edit (secret fields left blank)
    // must still PATCH the new URL.
    if (editingCredentials && provider?.baseUrlPolicy && baseUrl.trim()) body.baseUrl = baseUrl.trim();
    try {
      await patchEdrConnection(connection.id, body, {
        errorFallback: t("edrProviders.errorSave"),
        successMessage: t("edrProviders.savedToast"),
      });
      setEditingCredentials(false);
      setCreds({});
      setBaseUrl("");
      onChanged();
    } catch (err) {
      handleActionError(err, t("edrProviders.errorSave"));
    } finally {
      setBusy(null);
    }
  };

  const setActionsEnabled = async (next: boolean) => {
    setBusy("actions");
    try {
      await patchEdrConnection(connection.id, { actionsEnabled: next }, {
        errorFallback: t("edrProviders.actionsError"),
        successMessage: next ? t("edrProviders.actionsOnToast") : t("edrProviders.actionsOffToast"),
      });
      onChanged();
    } catch (err) {
      handleActionError(err, t("edrProviders.actionsError"));
    } finally {
      setBusy(null);
      setConfirmActions(false);
    }
  };

  const setPush = async (next: boolean) => {
    setBusy("push");
    const errorFallback = t("edrProviders.pushError");
    try {
      if (next) {
        await enableEdrPush(connection.id, {
          errorFallback,
          successMessage: t("edrProviders.pushOnToast"),
          friendly: (code) =>
            ["public_url_unset", "public_url_not_https", "connection_inactive"].includes(code)
              ? t(/* i18n-dynamic */ `edrProviders.pushErrors.${code}`)
              : undefined,
        });
      } else {
        const result = await disableEdrPush(connection.id, {
          errorFallback,
          successMessage: (r) => (r.warnings?.length ? "" : t("edrProviders.pushOffToast")),
        });
        if (result.warnings?.length) showToast({ type: "warning", message: result.warnings.join(" ") });
      }
      setTestSent(false);
      onChanged();
    } catch (err) {
      handleActionError(err, errorFallback);
    } finally {
      setBusy(null);
    }
  };

  const handlePushTest = async () => {
    setBusy("pushTest");
    try {
      await sendEdrPushTest(connection.id, {
        errorFallback: t("edrProviders.pushTestError"),
        successMessage: t("edrProviders.pushTestQueuedToast"),
      });
      setTestSent(true);
      onChanged();
    } catch (err) {
      handleActionError(err, t("edrProviders.pushTestError"));
    } finally {
      setBusy(null);
    }
  };

  const handleDelete = async () => {
    setBusy("delete");
    const errorFallback = t("edrProviders.errorDelete");
    try {
      // Step 1: a bare DELETE is refused with 409 CONFIRM_COUNTS carrying what
      // would be removed. That 409 is an expected step, not an error to toast.
      let counts: EdrDeleteConfirmCounts | null = null;
      try {
        await deleteEdrConnection(connection.id, null, {
          errorFallback,
          successMessage: t("edrProviders.deletedToast"),
          suppressErrorToast: (status, code) => status === 409 && code === "CONFIRM_COUNTS",
        });
        onChanged();
        return;
      } catch (err) {
        if (!(err instanceof ActionError) || err.status !== 409 || err.code !== "CONFIRM_COUNTS") throw err;
        const body = (err.body ?? {}) as Partial<EdrDeleteConfirmCounts>;
        counts = {
          detections: Number(body.detections ?? 0),
          endpoints: Number(body.endpoints ?? 0),
          tenants: Number(body.tenants ?? 0),
        };
      }
      if (
        !window.confirm(
          t("edrProviders.deleteConfirm", {
            name: connection.name,
            detections: counts.detections,
            endpoints: counts.endpoints,
            tenants: counts.tenants ?? 0,
          }),
        )
      ) {
        return;
      }
      // Step 2: repeat with the counts the user just saw.
      await deleteEdrConnection(
        connection.id,
        { detections: counts.detections, endpoints: counts.endpoints },
        { errorFallback, successMessage: t("edrProviders.deletedToast") },
      );
      onChanged();
    } catch (err) {
      handleActionError(err, errorFallback);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div data-testid={`edr-connection-${connection.id}`} className="rounded-lg border bg-card p-5 shadow-xs">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-foreground">{connection.name}</h3>
          <p data-testid="edr-connection-provider" className="text-sm text-muted-foreground">{providerLabel}</p>
          {connection.vendorRootName && (
            <p data-testid="edr-connection-root" className="mt-1 text-xs text-muted-foreground">
              {t("edrProviders.vendorRoot", { name: connection.vendorRootName })}
            </p>
          )}
        </div>
        <StatusBadge status={connection.status} />
      </div>

      {connection.status === "reauth_required" && (
        <div data-testid="edr-connection-reauth-banner" className="mt-4 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">
          <p className="font-medium">{t("edrProviders.reauthRequired")}</p>
          {canManage && (
            <button
              type="button"
              data-testid="edr-connection-reauth"
              onClick={() => setEditingCredentials(true)}
              className="mt-2 rounded-md border border-amber-400 bg-white px-3 py-1.5 text-xs font-medium text-amber-900"
            >
              {t("edrProviders.reenterCredentials")}
            </button>
          )}
        </div>
      )}

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <StreamRow
          testId={`edr-connection-inventory-${connection.id}`}
          label={t("edrProviders.streamInventory")}
          lastAt={connection.lastInventorySyncAt}
          lastStatus={connection.lastInventorySyncStatus}
          lastError={connection.lastInventorySyncError}
          cadenceMinutes={connection.effectiveInventoryIntervalMinutes ?? connection.inventoryIntervalMinutes}
        />
        <StreamRow
          testId={`edr-connection-detections-${connection.id}`}
          label={t("edrProviders.streamDetections")}
          lastAt={connection.lastDetectionSyncAt}
          lastStatus={connection.lastDetectionSyncStatus}
          lastError={connection.lastDetectionSyncError}
          cadenceMinutes={connection.effectiveDetectionIntervalMinutes ?? connection.detectionIntervalMinutes}
        />
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Counter testId="edr-connection-tenants" label={t("edrProviders.tenants")} value={connection.lastSyncTenants} />
        <Counter testId="edr-connection-unmapped-tenants" label={t("edrProviders.unmappedTenants")} value={connection.lastSyncUnmappedTenants} />
        <Counter testId="edr-connection-failed-tenants" label={t("edrProviders.failedTenants")} value={connection.lastSyncFailedTenants} />
        <Counter testId="edr-connection-endpoints" label={t("edrProviders.endpoints")} value={connection.lastSyncEndpoints} />
        <Counter testId="edr-connection-linked" label={t("edrProviders.linked")} value={connection.lastSyncLinkedEndpoints} />
        <Counter testId="edr-connection-ambiguous" label={t("edrProviders.ambiguous")} value={connection.lastSyncAmbiguousEndpoints} />
        <Counter testId="edr-connection-open-detections" label={t("edrProviders.openDetections")} value={connection.lastSyncOpenDetections} />
      </dl>

      {actions.length > 0 && (
        <div data-testid="edr-connection-capabilities" className="mt-4 flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">{t("edrProviders.capabilities")}</span>
          {actions.map((action) => (
            <span key={action} className="rounded-full border bg-muted/30 px-2 py-0.5 text-xs text-foreground">
              {action}
            </span>
          ))}
        </div>
      )}

      {canManage && (
        <>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <label className="text-sm">
              <span className="text-xs text-muted-foreground">{t("common:labels.name")}</span>
              <input
                data-testid="edr-connection-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm"
              />
            </label>
            <div className="flex flex-col justify-end gap-2">
              <label className="flex items-center gap-2 text-sm">
                <input data-testid="edr-connection-active" type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
                <span>{t("common:states.active")}</span>
              </label>
            </div>
            <label className="text-sm">
              <span className="text-xs text-muted-foreground">{t("edrProviders.detectionIntervalLabel")}</span>
              <input
                data-testid="edr-connection-detection-interval"
                inputMode="numeric"
                value={detectionInterval}
                placeholder={provider?.capabilities.defaultIntervals ? String(provider.capabilities.defaultIntervals.detectionsMinutes) : ""}
                onChange={(e) => setDetectionInterval(e.target.value)}
                aria-invalid={detection === undefined}
                className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm"
              />
            </label>
            <label className="text-sm">
              <span className="text-xs text-muted-foreground">{t("edrProviders.inventoryIntervalLabel")}</span>
              <input
                data-testid="edr-connection-inventory-interval"
                inputMode="numeric"
                value={inventoryInterval}
                placeholder={provider?.capabilities.defaultIntervals ? String(provider.capabilities.defaultIntervals.inventoryMinutes) : ""}
                onChange={(e) => setInventoryInterval(e.target.value)}
                aria-invalid={inventory === undefined}
                className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm"
              />
            </label>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">{t("edrProviders.intervalHelp")}</p>

          <div data-testid="edr-connection-switches" className="mt-4 space-y-3 rounded-md border bg-muted/10 p-3">
            <label className="flex items-start gap-2 text-sm">
              <input
                data-testid="edr-connection-actions-enabled"
                type="checkbox"
                role="switch"
                className="mt-1"
                checked={connection.actionsEnabled === true}
                disabled={busy !== null}
                onChange={(e) => (e.target.checked ? setConfirmActions(true) : void setActionsEnabled(false))}
              />
              <span>
                <span className="font-medium">{t("edrProviders.actionsLabel")}</span>
                <span className="block text-xs text-muted-foreground">{t("edrProviders.actionsHelp")}</span>
              </span>
            </label>
            {connection.pushSupported === true && (
              <div>
                <label className="flex items-start gap-2 text-sm">
                  <input
                    data-testid="edr-connection-push-enabled"
                    type="checkbox"
                    role="switch"
                    className="mt-1"
                    checked={connection.pushEnabled === true}
                    disabled={busy !== null}
                    onChange={(e) => void setPush(e.target.checked)}
                  />
                  <span>
                    <span className="font-medium">{t("edrProviders.pushLabel")}</span>
                    <span className="block text-xs text-muted-foreground">
                      {t("edrProviders.pushHelp", { provider: providerLabel })}
                    </span>
                  </span>
                </label>
                {connection.pushEnabled === true && (
                  <div className="mt-2 flex flex-wrap items-center gap-3 pl-6">
                    <span data-testid="edr-connection-push-last" className="text-xs text-muted-foreground">
                      {connection.lastHintAt
                        ? t("edrProviders.pushLast", { relative: formatRelativeTime(connection.lastHintAt) })
                        : t("edrProviders.pushNone")}
                    </span>
                    <button
                      type="button"
                      data-testid="edr-connection-push-test"
                      disabled={busy !== null}
                      onClick={() => void handlePushTest()}
                      className="rounded-md border bg-card px-3 py-1 text-xs font-medium disabled:opacity-50"
                    >
                      {t("edrProviders.pushTest")}
                    </button>
                    {testSent && (
                      <span data-testid="edr-connection-push-test-note" className="text-xs text-muted-foreground">
                        {t("edrProviders.pushTestNote")}
                      </span>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
          <ConfirmDialog
            open={confirmActions}
            onClose={() => busy === null && setConfirmActions(false)}
            onConfirm={() => void setActionsEnabled(true)}
            title={t("edrProviders.actionsConfirmTitle")}
            message={t("edrProviders.actionsConfirmMessage", { name: connection.name })}
            confirmLabel={t("edrProviders.actionsConfirmLabel")}
            variant="warning"
            isLoading={busy === "actions"}
            confirmTestId="edr-connection-actions-confirm"
          />

          {!editingCredentials && fields.length > 0 && (
            <button
              type="button"
              data-testid="edr-connection-edit-credentials"
              onClick={() => setEditingCredentials(true)}
              className="mt-3 rounded-md border px-3 py-1.5 text-xs font-medium"
            >
              {t("edrProviders.reenterCredentials")}
            </button>
          )}

          {editingCredentials && (
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              {fields.map((field) => (
                <label key={field.name} className="text-sm">
                  <span className="text-xs text-muted-foreground">{field.label}</span>
                  <input
                    data-testid={`edr-connection-cred-${field.name}`}
                    type={field.secret ? "password" : "text"}
                    autoComplete={field.secret ? "new-password" : "off"}
                    value={creds[field.name] ?? ""}
                    onChange={(e) => setCreds((c) => ({ ...c, [field.name]: e.target.value }))}
                    className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm"
                  />
                </label>
              ))}
              {provider?.baseUrlPolicy && (
                <label className="text-sm">
                  <span className="text-xs text-muted-foreground">{t("edrProviders.accessUrlLabel")}</span>
                  <input
                    data-testid="edr-connection-base-url"
                    autoComplete="off"
                    value={baseUrl}
                    onChange={(e) => setBaseUrl(e.target.value)}
                    className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm"
                  />
                </label>
              )}
              <p className="text-xs text-muted-foreground sm:col-span-2">{t("edrProviders.blankKeepsSecret")}</p>
              <div className="sm:col-span-2">
                <button
                  type="button"
                  data-testid="edr-connection-cancel-credentials"
                  onClick={() => {
                    setCreds({});
                    setBaseUrl("");
                    setEditingCredentials(false);
                  }}
                  className="rounded-md border px-3 py-1.5 text-xs font-medium"
                >
                  {t("common:actions.cancel")}
                </button>
              </div>
            </div>
          )}

          <div className="mt-4 flex flex-wrap gap-2">
            <button type="button" data-testid="edr-connection-test" disabled={busy !== null} onClick={() => void handleTest()} className="inline-flex items-center gap-2 rounded-md border bg-card px-3 py-1.5 text-sm font-medium disabled:opacity-50">
              {busy === "test" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Activity className="h-4 w-4" />}
              {t("edrProviders.test")}
            </button>
            <button type="button" data-testid="edr-connection-sync" disabled={busy !== null} onClick={() => void handleSync()} className="inline-flex items-center gap-2 rounded-md border bg-card px-3 py-1.5 text-sm font-medium disabled:opacity-50">
              <RefreshCw className="h-4 w-4" /> {t("edrProviders.syncNow")}
            </button>
            <button type="button" data-testid="edr-connection-save" disabled={saveDisabled} onClick={() => void handleSave()} className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50">
              <Save className="h-4 w-4" /> {t("common:actions.save")}
            </button>
            <button type="button" data-testid="edr-connection-delete" disabled={busy !== null} onClick={() => void handleDelete()} className="ml-auto inline-flex items-center gap-2 rounded-md border border-destructive/40 px-3 py-1.5 text-sm font-medium text-destructive disabled:opacity-50">
              <Trash2 className="h-4 w-4" /> {t("common:actions.delete")}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
