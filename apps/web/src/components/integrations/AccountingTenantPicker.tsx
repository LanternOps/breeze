import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import "@/lib/i18n";
import { fetchWithAuth } from "../../stores/auth";
import { runAction, ActionError, handleActionError } from "../../lib/runAction";
import { ACCOUNTING_PROVIDER_NAMES, accountingPath, type AccountingProviderId } from "../../lib/accountingProviders";

interface Props { provider: AccountingProviderId; onUnauthorized: () => void; onDone: () => void }
interface Choice { tenantId: string; name: string }
type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; choices: Choice[]; expiresAt: string | null }
  | { kind: "expired" }
  | { kind: "error" };

/**
 * The Xero organisation (tenant) picker, shown while a connection is
 * `pending_tenant` (the authorising user ticked more than one Xero
 * organisation on the consent screen; Breeze connects to exactly one).
 * Server contract: `server-contract.md` (Xero W02) — GET/POST
 * `/accounting/:provider/tenants{,/select,/cancel}`.
 */
export default function AccountingTenantPicker({ provider, onUnauthorized, onDone }: Props) {
  const { t, i18n } = useTranslation("integrations");
  const providerName = ACCOUNTING_PROVIDER_NAMES[provider];
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [chosen, setChosen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let live = true;
    setState({ kind: "loading" });
    void (async () => {
      try {
        const res = await fetchWithAuth(accountingPath(provider, "/tenants"));
        if (res.status === 401) { onUnauthorized(); return; }
        const body = (await res.json().catch(() => ({}))) as { data?: Choice[]; expiresAt?: string | null; code?: string };
        if (!live) return;
        if (res.ok) {
          setState({ kind: "ready", choices: body.data ?? [], expiresAt: body.expiresAt ?? null });
        } else if (res.status === 404 && body.code === "no_pending_selection") {
          onDone();
        } else if (res.status === 409 && (body.code === "tenant_selection_expired" || body.code === "auth_event_missing")) {
          setState({ kind: "expired" });
        } else {
          setState({ kind: "error" });
        }
      } catch {
        if (live) setState({ kind: "error" });
      }
    })();
    return () => { live = false; };
  }, [provider, onUnauthorized, onDone, reloadKey]);

  // Auto-expire when the pick deadline passes while the picker stays open.
  useEffect(() => {
    if (state.kind !== "ready" || !state.expiresAt) return;
    const ms = new Date(state.expiresAt).getTime() - Date.now();
    if (ms <= 0) { setState({ kind: "expired" }); return; }
    const timer = setTimeout(() => setState({ kind: "expired" }), ms);
    return () => clearTimeout(timer);
  }, [state]);

  const friendly = useCallback((code: string) => {
    if (code === "accounting_tenant_held") return t("accountingConnection.tenantPicker.tenantHeld", { provider: providerName });
    if (code === "grant_superseded") return t("accountingConnection.tenantPicker.grantSuperseded", { provider: providerName });
    return undefined;
  }, [t, providerName]);

  const handleSelect = useCallback(async () => {
    if (!chosen) return;
    setBusy(true);
    try {
      await runAction({
        request: () => fetchWithAuth(accountingPath(provider, "/tenants/select"), {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tenantId: chosen }),
        }),
        errorFallback: t("accountingConnection.tenantPicker.selectFailed"),
        successMessage: t("accountingConnection.tenantPicker.connected", { provider: providerName }),
        friendly,
        onUnauthorized,
      });
      onDone();
    } catch (err) {
      if (!(err instanceof ActionError)) {
        handleActionError(err, t("accountingConnection.tenantPicker.selectFailed"));
      } else {
        switch (err.code) {
          case "no_pending_selection":
            onDone();
            return;
          case "tenant_selection_expired":
            setState({ kind: "expired" });
            return;
          case "grant_superseded":
            setChosen(null);
            setReloadKey((k) => k + 1);
            return;
          default:
            // accounting_tenant_held and any other error: the picker stays
            // open so the operator can choose a different organisation.
            setChosen(null);
            break;
        }
      }
    } finally {
      setBusy(false);
    }
  }, [chosen, provider, providerName, friendly, onUnauthorized, onDone, t]);

  const handleCancel = useCallback(async () => {
    setBusy(true);
    try {
      await runAction({
        request: () => fetchWithAuth(accountingPath(provider, "/tenants/cancel"), { method: "POST" }),
        errorFallback: t("accountingConnection.tenantPicker.cancelFailed"),
        successMessage: t("accountingConnection.tenantPicker.cancelled", { provider: providerName }),
        onUnauthorized,
      });
      onDone();
    } catch (err) {
      if (!(err instanceof ActionError)) handleActionError(err, t("accountingConnection.tenantPicker.cancelFailed"));
    } finally {
      setBusy(false);
    }
  }, [provider, providerName, onUnauthorized, onDone, t]);

  const handleRetry = useCallback(() => {
    setReloadKey((k) => k + 1);
  }, []);

  return (
    <section className="space-y-4 rounded-lg border bg-card p-5" data-testid={`${provider}-tenant-picker`} aria-labelledby={`${provider}-tenant-picker-title`}>
      <h2 id={`${provider}-tenant-picker-title`} className="font-semibold">{t("accountingConnection.tenantPicker.title", { provider: providerName })}</h2>
      {state.kind === "loading" && <Loader2 className="h-5 w-5 animate-spin" />}
      {state.kind === "error" && (
        <div className="space-y-2">
          <p role="alert" className="text-sm text-destructive">{t("accountingConnection.tenantPicker.loadFailed", { provider: providerName })}</p>
          <button
            type="button"
            onClick={handleRetry}
            className="inline-flex h-9 items-center gap-2 rounded-md border px-3 text-sm font-medium hover:bg-muted"
            data-testid={`${provider}-tenant-retry`}
          >
            {t("accountingConnection.tenantPicker.retry")}
          </button>
        </div>
      )}
      {state.kind === "expired" && (
        <p role="alert" className="text-sm text-amber-700" data-testid={`${provider}-tenant-expired`}>
          {t("accountingConnection.tenantPicker.expired", { provider: providerName })}
        </p>
      )}
      {state.kind === "ready" && (
        <>
          <p className="text-sm text-muted-foreground">{t("accountingConnection.tenantPicker.description")}</p>
          {state.expiresAt && (
            <p className="text-xs text-amber-700" data-testid={`${provider}-tenant-deadline`}>
              {t("accountingConnection.tenantPicker.deadline", {
                time: new Intl.DateTimeFormat(i18n.language, { timeStyle: "short" }).format(new Date(state.expiresAt)),
              })}
            </p>
          )}
          <fieldset className="space-y-2">
            <legend className="sr-only">{t("accountingConnection.tenantPicker.title", { provider: providerName })}</legend>
            {state.choices.map((choice) => (
              <label key={choice.tenantId} className="flex items-center gap-2 rounded-md border p-3 text-sm">
                <input
                  type="radio"
                  name={`${provider}-tenant`}
                  value={choice.tenantId}
                  checked={chosen === choice.tenantId}
                  onChange={() => setChosen(choice.tenantId)}
                  data-testid={`${provider}-tenant-option-${choice.tenantId}`}
                />
                {choice.name}
              </label>
            ))}
          </fieldset>
        </>
      )}
      <div className="flex flex-wrap gap-2">
        {state.kind === "ready" && (
          <button
            type="button"
            onClick={() => void handleSelect()}
            disabled={busy || !chosen}
            title={!chosen ? t("accountingConnection.tenantPicker.chooseFirst") : undefined}
            className="inline-flex h-9 items-center gap-2 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground disabled:opacity-50"
            data-testid={`${provider}-tenant-select`}
          >
            {t("accountingConnection.tenantPicker.connect")}
          </button>
        )}
        <button
          type="button"
          onClick={() => void handleCancel()}
          disabled={busy}
          className="inline-flex h-9 items-center gap-2 rounded-md border px-3 text-sm font-medium disabled:opacity-50"
          data-testid={`${provider}-tenant-cancel`}
        >
          {t("accountingConnection.tenantPicker.cancel")}
        </button>
      </div>
    </section>
  );
}
