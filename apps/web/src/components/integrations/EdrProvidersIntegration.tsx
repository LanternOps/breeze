import { useCallback, useEffect, useState } from "react";
import { Loader2, Plus, ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";

import { getJwtClaims } from "../../lib/authScope";
import { useAuthStore } from "../../stores/auth";
import { useOrgStore } from "../../stores/orgStore";
import { showToast } from "../shared/Toast";
import {
  createEdrConnection,
  fetchEdrConnections,
  fetchEdrProviders,
  type EdrConnection,
  type EdrConnectionCreateBody,
  type EdrConnectionTestResult,
  type EdrProviderDescriptor,
} from "@/lib/edrProviders";
import { handleActionError } from "@/lib/runAction";
import EdrProviderConnectionCard from "./EdrProviderConnectionCard";
import EdrTenantMapping from "./EdrTenantMapping";
import EdrUnlinkedEndpoints from "./EdrUnlinkedEndpoints";
import "@/lib/i18n";

/** Blank = provider default (null); otherwise an integer 1-1440, else undefined (invalid). */
function parseInterval(raw: string): number | null | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  if (!/^\d+$/.test(trimmed)) return undefined;
  const n = Number(trimmed);
  return n >= 1 && n <= 1440 ? n : undefined;
}

type AddForm = {
  provider: string;
  name: string;
  baseUrl: string;
  creds: Record<string, string>;
  detectionInterval: string;
  inventoryInterval: string;
};

const EMPTY_FORM: AddForm = { provider: "", name: "", baseUrl: "", creds: {}, detectionInterval: "", inventoryInterval: "" };

export default function EdrProvidersIntegration() {
  const { t } = useTranslation("integrations");
  // The EDR routes are partner-scoped. Gate on the JWT scope — never on
  // useOrgStore().partners.length, which is empty for real partner users.
  const isOrgScoped = getJwtClaims().scope === "organization";
  // The API 403s connection writes for selected-org-access partner users.
  const canManage = useAuthStore((s) => s.user?.canManagePartnerWide) !== false;
  const organizations = useOrgStore((s) => s.organizations);

  const [connections, setConnections] = useState<EdrConnection[]>([]);
  const [providers, setProviders] = useState<EdrProviderDescriptor[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [testResult, setTestResult] = useState<EdrConnectionTestResult | null>(null);

  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState<AddForm>(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    if (isOrgScoped) return;
    setLoadError(false);
    try {
      const [conns, provs] = await Promise.all([fetchEdrConnections(), fetchEdrProviders()]);
      setConnections(conns);
      setProviders(provs);
    } catch (err) {
      console.error("[EdrProvidersIntegration] load:", err);
      // Never fall through to the empty state: "no provider connected" and
      // "we could not ask" are different facts, and only one is an all-clear.
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [isOrgScoped]);

  useEffect(() => {
    void load();
  }, [load]);

  const selected = providers.find((p) => p.key === form.provider) ?? providers[0];
  const fields = selected?.credentialFields ?? [];
  const policy = selected?.baseUrlPolicy ?? null;
  const detection = parseInterval(form.detectionInterval);
  const inventory = parseInterval(form.inventoryInterval);
  const canSubmit =
    !submitting &&
    !!selected &&
    form.name.trim() !== "" &&
    fields.every((f) => !f.required || (form.creds[f.name] ?? "").trim() !== "") &&
    (!policy?.required || form.baseUrl.trim() !== "") &&
    detection !== undefined &&
    inventory !== undefined;

  const openAdd = () => {
    setAdding((v) => !v);
    setForm(EMPTY_FORM);
  };

  const handleCreate = async () => {
    if (!selected || detection === undefined || inventory === undefined) return;
    setSubmitting(true);
    const body: EdrConnectionCreateBody = {
      provider: selected.key,
      name: form.name.trim(),
      credentials: Object.fromEntries(
        fields.filter((f) => (form.creds[f.name] ?? "").trim() !== "").map((f) => [f.name, form.creds[f.name]!.trim()]),
      ),
      ...(policy && form.baseUrl.trim() ? { baseUrl: form.baseUrl.trim() } : {}),
      ...(detection !== null ? { detectionIntervalMinutes: detection } : {}),
      ...(inventory !== null ? { inventoryIntervalMinutes: inventory } : {}),
    };
    try {
      // A vendor test failure answers 422 {success:false,error}; runAction
      // toasts it and the form stays open for another attempt.
      const result = await createEdrConnection(body, {
        errorFallback: t("edrProviders.errorCreate"),
        successMessage: t("edrProviders.createdToast"),
      });
      if (result?.syncWarning) showToast({ type: "warning", message: t("edrProviders.syncWarning") });
      setAdding(false);
      setForm(EMPTY_FORM);
      await load();
    } catch (err) {
      handleActionError(err, t("edrProviders.errorCreate"));
    } finally {
      setSubmitting(false);
    }
  };

  if (isOrgScoped) {
    return (
      <p data-testid="edr-providers-org-scope" className="py-12 text-center text-sm text-muted-foreground">
        {t("edrProviders.partnerOnly")}
      </p>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold text-foreground">
            <ShieldCheck className="h-5 w-5" />
            {t("edrProviders.title")}
          </h2>
          <p className="text-sm text-muted-foreground">{t("edrProviders.subtitle")}</p>
        </div>
        {canManage && (
          <button
            type="button"
            data-testid="edr-providers-add"
            onClick={openAdd}
            className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground"
          >
            <Plus className="h-4 w-4" /> {t("edrProviders.addConnection")}
          </button>
        )}
      </div>

      {!canManage && (
        <div data-testid="edr-providers-readonly" className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">
          {t("edrProviders.readOnly")}
        </div>
      )}

      {canManage && adding && (
        <div data-testid="edr-add-form" className="rounded-lg border bg-card p-5 shadow-xs">
          {!selected ? (
            <p data-testid="edr-add-no-providers" className="text-sm text-muted-foreground">
              {t("edrProviders.noProviders")}
            </p>
          ) : (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="text-sm">
                  <span className="text-xs text-muted-foreground">{t("edrProviders.providerLabel")}</span>
                  <select
                    data-testid="edr-add-provider"
                    value={selected.key}
                    onChange={(e) => setForm({ ...EMPTY_FORM, provider: e.target.value, name: form.name })}
                    className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm"
                  >
                    {providers.map((p) => (
                      <option key={p.key} value={p.key}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="text-sm">
                  <span className="text-xs text-muted-foreground">{t("edrProviders.nameLabel")}</span>
                  <input
                    data-testid="edr-add-name"
                    value={form.name}
                    placeholder={t("edrProviders.namePlaceholder")}
                    onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                    className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm"
                  />
                </label>
                {fields.map((field) => (
                  <label key={field.name} className="text-sm">
                    <span className="text-xs text-muted-foreground">{field.label}</span>
                    <input
                      data-testid={`edr-add-cred-${field.name}`}
                      type={field.secret ? "password" : "text"}
                      autoComplete={field.secret ? "new-password" : "off"}
                      required={field.required}
                      value={form.creds[field.name] ?? ""}
                      onChange={(e) => setForm((f) => ({ ...f, creds: { ...f.creds, [field.name]: e.target.value } }))}
                      className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm"
                    />
                  </label>
                ))}
                {policy && (
                  <label className="text-sm sm:col-span-2">
                    <span className="text-xs text-muted-foreground">{t("edrProviders.accessUrlLabel")}</span>
                    <input
                      data-testid="edr-add-base-url"
                      autoComplete="off"
                      required={policy.required}
                      value={form.baseUrl}
                      onChange={(e) => setForm((f) => ({ ...f, baseUrl: e.target.value }))}
                      className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm"
                    />
                    <span data-testid="edr-add-base-url-hint" className="mt-1 block text-xs text-muted-foreground">
                      {policy.pathPrefix
                        ? t("edrProviders.accessUrlHintPath", { path: policy.pathPrefix })
                        : t("edrProviders.accessUrlHint")}
                    </span>
                  </label>
                )}
                <label className="text-sm">
                  <span className="text-xs text-muted-foreground">{t("edrProviders.detectionIntervalLabel")}</span>
                  <input
                    data-testid="edr-add-detection-interval"
                    inputMode="numeric"
                    value={form.detectionInterval}
                    placeholder={selected.capabilities.defaultIntervals ? String(selected.capabilities.defaultIntervals.detectionsMinutes) : ""}
                    aria-invalid={detection === undefined}
                    onChange={(e) => setForm((f) => ({ ...f, detectionInterval: e.target.value }))}
                    className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm"
                  />
                </label>
                <label className="text-sm">
                  <span className="text-xs text-muted-foreground">{t("edrProviders.inventoryIntervalLabel")}</span>
                  <input
                    data-testid="edr-add-inventory-interval"
                    inputMode="numeric"
                    value={form.inventoryInterval}
                    placeholder={selected.capabilities.defaultIntervals ? String(selected.capabilities.defaultIntervals.inventoryMinutes) : ""}
                    aria-invalid={inventory === undefined}
                    onChange={(e) => setForm((f) => ({ ...f, inventoryInterval: e.target.value }))}
                    className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm"
                  />
                </label>
              </div>
              <p className="mt-3 text-xs text-muted-foreground">{t("edrProviders.intervalHelp")}</p>
            </>
          )}
          <div className="mt-4 flex gap-2">
            <button
              type="button"
              data-testid="edr-add-submit"
              disabled={!canSubmit}
              onClick={() => void handleCreate()}
              className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
            >
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {t("common:actions.save")}
            </button>
            <button type="button" data-testid="edr-add-cancel" onClick={() => { setAdding(false); setForm(EMPTY_FORM); }} className="rounded-md border px-3 py-1.5 text-sm font-medium">
              {t("common:actions.cancel")}
            </button>
          </div>
        </div>
      )}

      {loadError && (
        <div data-testid="edr-providers-error" className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {t("edrProviders.errorLoad")}
        </div>
      )}

      {loading ? (
        <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> {t("common:states.loading")}
        </div>
      ) : !loadError && connections.length === 0 ? (
        <p data-testid="edr-providers-empty" className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
          {t("edrProviders.empty")}
        </p>
      ) : (
        connections.map((connection) => (
          <div key={connection.id}>
            <EdrProviderConnectionCard
              connection={connection}
              provider={providers.find((p) => p.key === connection.provider)}
              canManage={canManage}
              onChanged={() => void load()}
              onTestResult={setTestResult}
            />
            <EdrTenantMapping
              connectionId={connection.id}
              orgs={organizations}
              canManage={canManage}
              onChanged={() => void load()}
            />
            <EdrUnlinkedEndpoints connectionId={connection.id} canManage={canManage} />
          </div>
        ))
      )}

      {testResult && (
        <div data-testid="edr-test-modal" className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-8">
          <div className="w-full max-w-lg rounded-lg border bg-card p-6 shadow-xs">
            <h3 className="text-lg font-semibold">
              {testResult.success ? t("edrProviders.testSuccess") : t("edrProviders.testFailed")}
            </h3>
            {testResult.success ? (
              <div className="mt-4 rounded-md border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">
                <p>{t("edrProviders.testSignedIn", { name: testResult.rootName ?? "" })}</p>
                <p className="mt-1">{t("edrProviders.testVisible", { value: testResult.tenantCount ?? 0 })}</p>
              </div>
            ) : (
              <div className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
                <p>{testResult.error ?? testResult.message}</p>
                {testResult.reauth && <p data-testid="edr-test-reauth-hint" className="mt-2 text-muted-foreground">{t("edrProviders.reauthRequired")}</p>}
              </div>
            )}
            <div className="mt-6 flex justify-end">
              <button type="button" data-testid="edr-test-modal-close" onClick={() => setTestResult(null)} className="rounded-md border px-3 py-1.5 text-sm font-medium">
                {t("common:actions.close")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
