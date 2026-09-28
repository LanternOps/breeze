import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import "@/lib/i18n";
import { fetchWithAuth } from "../../stores/auth";
import { runAction, ActionError, handleActionError } from "../../lib/runAction";
import { ACCOUNTING_PROVIDER_NAMES, accountingPath, isMfaError, type AccountingProviderId } from "../../lib/accountingProviders";

export type SettingsValues = {
  defaultIncomeAccountRef: string | null;
  defaultTaxCodeRef: string | null;
  defaultExemptTaxCodeRef: string | null;
  defaultPaymentAccountRef: string | null;
};
interface Option { ref: string; label: string; detail: string | null }
interface Options {
  organisation: { name: string | null; isDemoCompany: boolean | null };
  incomeAccounts: Option[]; taxRates: Option[]; bankAccounts: Option[];
}
interface Props { provider: AccountingProviderId; values: SettingsValues; paymentPushOn?: boolean; onSaved: (v: SettingsValues) => void; onUnauthorized: () => void }

const FIELDS: Array<{ field: keyof SettingsValues; labelKey: string; source: keyof Omit<Options, "organisation"> }> = [
  { field: "defaultIncomeAccountRef", labelKey: "incomeAccount", source: "incomeAccounts" },
  { field: "defaultTaxCodeRef", labelKey: "taxRate", source: "taxRates" },
  { field: "defaultExemptTaxCodeRef", labelKey: "exemptTaxRate", source: "taxRates" },
  { field: "defaultPaymentAccountRef", labelKey: "paymentAccount", source: "bankAccounts" },
];

/** Connection defaults for providers that declare settings pickers (Xero W02).
 *  Form screen → one page Save (settings rule 7). Whether the "pick defaults"
 *  notice shows is driven by the SAVED `values` prop, never the in-progress
 *  draft — the draft is what the operator is about to save, not what's live. */
export default function AccountingSettingsStep({ provider, values, paymentPushOn, onSaved, onUnauthorized }: Props) {
  const { t } = useTranslation("integrations");
  const providerName = ACCOUNTING_PROVIDER_NAMES[provider];
  const [options, setOptions] = useState<Options | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [draft, setDraft] = useState<SettingsValues>(values);
  const [saving, setSaving] = useState(false);
  const [loadNonce, setLoadNonce] = useState(0);
  const [mfaRequired, setMfaRequired] = useState(false);

  // Depend on the four primitive refs, not the `values` object itself — the
  // panel passes an inline object literal on every render, and an object-keyed
  // effect would wipe an unsaved pick on every unrelated panel re-render.
  useEffect(() => {
    setDraft(values);
  }, [values.defaultIncomeAccountRef, values.defaultTaxCodeRef, values.defaultExemptTaxCodeRef, values.defaultPaymentAccountRef]);

  useEffect(() => {
    let live = true;
    setLoadFailed(false);
    void (async () => {
      try {
        const res = await fetchWithAuth(accountingPath(provider, "/settings/options"));
        if (res.status === 401) { onUnauthorized(); return; }
        if (!res.ok) { if (live) setLoadFailed(true); return; }
        const body = (await res.json()) as { data: Options };
        if (live) setOptions(body.data);
      } catch {
        if (live) setLoadFailed(true);
      }
    })();
    return () => { live = false; };
  }, [provider, onUnauthorized, loadNonce]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setMfaRequired(false);
    try {
      const updated = await runAction<SettingsValues>({
        request: () => fetchWithAuth(accountingPath(provider, "/settings"), {
          method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(draft),
        }),
        errorFallback: t("accountingConnection.settingsStep.saveFailed", { provider: providerName }),
        successMessage: t("accountingConnection.settingsStep.saved", { provider: providerName }),
        onUnauthorized,
      });
      onSaved({
        defaultIncomeAccountRef: updated.defaultIncomeAccountRef ?? null,
        defaultTaxCodeRef: updated.defaultTaxCodeRef ?? null,
        defaultExemptTaxCodeRef: updated.defaultExemptTaxCodeRef ?? null,
        defaultPaymentAccountRef: updated.defaultPaymentAccountRef ?? null,
      });
    } catch (err) {
      // PATCH /:provider/settings is MFA-gated: mirror the panel's own PATCH
      // handlers (push mode, payment sync toggles) and show the persistent
      // localized hint instead of runAction's generic toast.
      if (isMfaError(err)) setMfaRequired(true);
      else if (!(err instanceof ActionError)) handleActionError(err, t("accountingConnection.settingsStep.saveFailed", { provider: providerName }));
    } finally {
      setSaving(false);
    }
  }, [draft, provider, providerName, onSaved, onUnauthorized, t]);

  const allUnset =
    values.defaultIncomeAccountRef === null &&
    values.defaultTaxCodeRef === null &&
    values.defaultExemptTaxCodeRef === null &&
    values.defaultPaymentAccountRef === null;

  return (
    <section className="space-y-4 rounded-lg border bg-card p-5" data-testid={`${provider}-settings-step`} aria-labelledby={`${provider}-settings-title`}>
      <h2 id={`${provider}-settings-title`} className="font-semibold">{t("accountingConnection.settingsStep.title", { provider: providerName })}</h2>
      {loadFailed && (
        <div className="flex items-center justify-between gap-3">
          <p role="alert" className="text-sm text-destructive">{t("accountingConnection.settingsStep.loadFailed", { provider: providerName })}</p>
          <button
            type="button"
            onClick={() => setLoadNonce((n) => n + 1)}
            className="inline-flex h-9 items-center gap-2 rounded-md border px-3 text-sm font-medium hover:bg-muted"
            data-testid={`${provider}-settings-retry`}
          >
            <RefreshCw className="h-4 w-4" /> {t("accountingConnection.settingsStep.retry")}
          </button>
        </div>
      )}
      {!options && !loadFailed && <Loader2 className="h-5 w-5 animate-spin" />}
      {options && (
        <>
          {allUnset && (
            <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800" data-testid={`${provider}-settings-unset`}>
              {t("accountingConnection.settingsStep.pickDefaults", { provider: providerName })}
            </p>
          )}
          <p className="text-sm">
            <span className="text-muted-foreground">{t("accountingConnection.settingsStep.organisation")}: </span>
            <span className="font-medium" data-testid={`${provider}-organisation-name`}>{options.organisation.name ?? "—"}</span>
            {options.organisation.isDemoCompany === true && (
              <span className="ml-2 inline-flex rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-xs text-amber-800" data-testid={`${provider}-demo-badge`}>
                {t("accountingConnection.settingsStep.demoBadge")}
              </span>
            )}
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            {FIELDS.map(({ field, labelKey, source }) => {
              const current = draft[field];
              // A previously-saved ref can be absent from the freshly-fetched
              // options (renamed/archived in the provider, or a stale draft) —
              // without this, <select> falls back to no matching <option> and
              // silently renders blank, which reads as "not set" when it isn't.
              const currentMissing = current !== null && !options[source].some((o) => o.ref === current);
              return (
                <label key={field} className="space-y-1 text-sm">
                  <span className="text-muted-foreground">{t(/* i18n-dynamic */ `accountingConnection.settingsStep.${labelKey}`)}</span>
                  <select
                    className="h-9 w-full rounded-md border bg-background px-2"
                    value={current ?? ""}
                    onChange={(e) => setDraft((prev) => ({ ...prev, [field]: e.target.value || null }))}
                    data-testid={`${provider}-setting-${field}`}
                  >
                    <option value="">{t("accountingConnection.settingsStep.notSet")}</option>
                    {currentMissing && <option value={current as string}>{current}</option>}
                    {options[source].map((o) => (
                      <option key={o.ref} value={o.ref}>{o.detail ? `${o.label} (${o.detail})` : o.label}</option>
                    ))}
                  </select>
                </label>
              );
            })}
          </div>
          {paymentPushOn && !draft.defaultPaymentAccountRef && (
            <p role="status" className="text-sm text-amber-700" data-testid={`${provider}-payment-account-warning`}>
              {t("accountingConnection.settingsStep.paymentAccountMissing", { provider: providerName })}
            </p>
          )}
          {mfaRequired && (
            <p role="alert" className="text-sm text-amber-700" data-testid={`${provider}-settings-mfa`}>
              {t("accountingConnection.mfaRequiredHint", { provider: providerName })}
            </p>
          )}
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={saving}
            className="inline-flex h-9 items-center gap-2 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground disabled:opacity-50"
            data-testid={`${provider}-settings-save`}
          >
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            {t("accountingConnection.settingsStep.save")}
          </button>
        </>
      )}
    </section>
  );
}
