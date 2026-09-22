import { useCallback, useEffect, useState } from "react";
import { Eye, EyeOff, HardDrive, Loader2, Plus } from "lucide-react";
import { useTranslation } from "react-i18next";

import { getJwtClaims } from "../../lib/authScope";
import { fetchWithAuth } from "../../stores/auth";
import { handleActionError, runAction } from "@/lib/runAction";
import BackupProviderConnectionCard, {
  type BackupProviderConnection,
  type BackupProviderTestResult,
} from "./BackupProviderConnectionCard";
import BackupProviderCustomerMapping, { type BackupProviderCustomer } from "./BackupProviderCustomerMapping";
import "@/lib/i18n";

export default function BackupProvidersIntegration() {
  const { t } = useTranslation("integrations");
  // The connection/customer routes are requireScope('partner','system'). Gate on
  // the JWT scope — never on useOrgStore().partners.length, which is empty for
  // real partner users (the known anti-pattern called out in IntegrationsPage).
  const isOrgScoped = getJwtClaims().scope === "organization";

  const [connections, setConnections] = useState<BackupProviderConnection[]>([]);
  const [customers, setCustomers] = useState<Record<string, BackupProviderCustomer[]>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<BackupProviderTestResult | null>(null);

  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: "", partnerName: "", username: "", password: "", showInPortal: false });
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    if (isOrgScoped) return;
    setLoading(true);
    setLoadError(null);
    try {
      const response = await fetchWithAuth("/backup/providers/connections");
      if (!response.ok) throw new Error(`${response.status}`);
      const payload = await response.json();
      const rows: BackupProviderConnection[] = Array.isArray(payload?.data) ? payload.data : [];
      setConnections(rows);

      const grids = await Promise.all(
        rows.map(async (row) => {
          const res = await fetchWithAuth(`/backup/providers/connections/${row.id}/customers`);
          if (!res.ok) return [row.id, [] as BackupProviderCustomer[]] as const;
          const body = await res.json();
          return [row.id, Array.isArray(body?.data) ? body.data : []] as const;
        }),
      );
      setCustomers(Object.fromEntries(grids));
    } catch (err) {
      console.error("[BackupProvidersIntegration] load:", err);
      // Never fall through to the empty state: "no provider connected" and
      // "we could not ask" are different facts, and only one of them is an
      // all-clear.
      setLoadError(t("backupProviders.errorLoad"));
    } finally {
      setLoading(false);
    }
  }, [isOrgScoped, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleCreate = async () => {
    setSubmitting(true);
    try {
      await runAction({
        request: () =>
          fetchWithAuth("/backup/providers/connections", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              provider: "cove",
              name: form.name.trim(),
              showProviderNameInPortal: form.showInPortal,
              credentials: {
                partnerName: form.partnerName.trim(),
                username: form.username.trim(),
                password: form.password,
              },
            }),
          }),
        errorFallback: t("backupProviders.errorSave"),
        successMessage: t("backupProviders.savedToast"),
      });
      setAdding(false);
      setForm({ name: "", partnerName: "", username: "", password: "", showInPortal: false });
      await load();
    } catch (err) {
      handleActionError(err, t("backupProviders.errorSave"));
    } finally {
      setSubmitting(false);
    }
  };

  if (isOrgScoped) {
    return (
      <p data-testid="backup-providers-org-scope" className="py-12 text-center text-sm text-muted-foreground">
        {t("backupProviders.partnerOnly")}
      </p>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold text-foreground">
            <HardDrive className="h-5 w-5" />
            {t("backupProviders.title")}
          </h2>
          <p className="text-sm text-muted-foreground">{t("backupProviders.subtitle")}</p>
        </div>
        <button
          type="button"
          data-testid="backup-providers-add"
          onClick={() => setAdding((v) => !v)}
          className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground"
        >
          <Plus className="h-4 w-4" /> {t("backupProviders.addConnection")}
        </button>
      </div>

      {adding && (
        <div className="rounded-lg border bg-card p-5 shadow-xs">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-sm">
              <span className="text-xs text-muted-foreground">{t("backupProviders.providerLabel")}</span>
              <select data-testid="backup-add-provider" disabled className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm">
                <option value="cove">{t("backupProviders.cove")}</option>
              </select>
            </label>
            <label className="text-sm">
              <span className="text-xs text-muted-foreground">{t("backupProviders.nameLabel")}</span>
              <input
                data-testid="backup-add-name"
                value={form.name}
                placeholder={t("backupProviders.namePlaceholder")}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm"
              />
            </label>
            <label className="text-sm">
              <span className="text-xs text-muted-foreground">{t("backupProviders.partnerNameLabel")}</span>
              <input
                data-testid="backup-add-partner-name"
                value={form.partnerName}
                onChange={(e) => setForm((f) => ({ ...f, partnerName: e.target.value }))}
                className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm"
              />
            </label>
            <label className="text-sm">
              <span className="text-xs text-muted-foreground">{t("backupProviders.usernameLabel")}</span>
              <input
                data-testid="backup-add-username"
                value={form.username}
                onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))}
                className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm"
              />
            </label>
            <label className="text-sm">
              <span className="text-xs text-muted-foreground">{t("backupProviders.passwordLabel")}</span>
              <div className="mt-1 flex items-center gap-1">
                <input
                  data-testid="backup-add-password"
                  type={showPassword ? "text" : "password"}
                  value={form.password}
                  onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
                  className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                />
                <button
                  type="button"
                  data-testid="backup-add-password-toggle"
                  aria-label={showPassword ? t("backupProviders.hidePassword") : t("backupProviders.showPassword")}
                  onClick={() => setShowPassword((v) => !v)}
                  className="rounded-md border px-2 py-1.5"
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </label>
            <label className="flex items-end gap-2 text-sm">
              <input
                data-testid="backup-add-portal-toggle"
                type="checkbox"
                checked={form.showInPortal}
                onChange={(e) => setForm((f) => ({ ...f, showInPortal: e.target.checked }))}
              />
              <span>{t("backupProviders.portalLabelToggle")}</span>
            </label>
          </div>
          <p data-testid="backup-add-help" className="mt-3 rounded-md border border-dashed p-3 text-xs text-muted-foreground">
            {t("backupProviders.credentialsHelp")}
          </p>
          <div className="mt-4 flex gap-2">
            <button
              type="button"
              data-testid="backup-add-submit"
              disabled={submitting || !form.name.trim() || !form.password}
              onClick={() => void handleCreate()}
              className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
            >
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {t("common:actions.save")}
            </button>
            <button type="button" onClick={() => setAdding(false)} className="rounded-md border px-3 py-1.5 text-sm font-medium">
              {t("common:actions.cancel")}
            </button>
          </div>
        </div>
      )}

      {loadError && (
        <div data-testid="backup-providers-error" className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {loadError}
        </div>
      )}

      {loading ? (
        <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> {t("common:states.loading")}
        </div>
      ) : !loadError && connections.length === 0 ? (
        <p data-testid="backup-providers-empty" className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
          {t("backupProviders.empty")}
        </p>
      ) : (
        connections.map((connection) => (
          <div key={connection.id}>
            <BackupProviderConnectionCard connection={connection} onChanged={() => void load()} onTestResult={setTestResult} />
            <BackupProviderCustomerMapping
              connectionId={connection.id}
              customers={customers[connection.id] ?? []}
              onChanged={() => void load()}
            />
          </div>
        ))
      )}

      {testResult && (
        <div data-testid="backup-test-modal" className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-8">
          <div className="w-full max-w-lg rounded-lg border bg-card p-6 shadow-xs">
            <h3 className="text-lg font-semibold">
              {testResult.success ? t("backupProviders.testSuccess") : t("backupProviders.testFailed")}
            </h3>
            {testResult.success ? (
              <div className="mt-4 rounded-md border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">
                <p>{t("backupProviders.testSignedIn", { name: testResult.rootName ?? "" })}</p>
                <p className="mt-1">{t("backupProviders.testVisible", { value: testResult.customerCount ?? 0 })}</p>
              </div>
            ) : (
              <div className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
                <p>{testResult.error ?? testResult.message}</p>
                <p className="mt-2 text-muted-foreground">{t("backupProviders.credentialsHelp")}</p>
              </div>
            )}
            <div className="mt-6 flex justify-end">
              <button type="button" onClick={() => setTestResult(null)} className="rounded-md border px-3 py-1.5 text-sm font-medium">
                {t("common:actions.close")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
