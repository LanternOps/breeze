import { useCallback, useEffect, useState } from "react";
import { fetchWithAuth } from "../../stores/auth";
import { navigateTo } from "@/lib/navigation";
import { runAction, handleActionError } from "../../lib/runAction";
import { formatDateTime } from "@/lib/dateTimeFormat";
import { useTranslation } from "react-i18next";
import "@/lib/i18n";

const UNAUTHORIZED = () => void navigateTo("/login", { replace: true });

/** `reconnect_required`: a key is stored but Stripe no longer accepts it (revoked /
 *  scoped down / undecryptable). Treated like disconnected for the form, with an
 *  explanatory banner — never rendered as "connected" (#3777 review F4). */
type ConnectStatus = "connected" | "disconnected" | "reconnect_required";

interface ConnectState {
  status: ConnectStatus;
  stripeAccountId?: string;
  livemode?: boolean;
  last4?: string | null;
  /** Cached Stripe account settlement currency / country (#3777). Owned by the
   *  API cache — the web never calls Stripe; null = not cached yet. */
  defaultCurrency?: string | null;
  accountCountry?: string | null;
  accountRefreshedAt?: string | null;
  /** `stale`: Stripe could not be reached on the last TTL refresh; the cached
   *  value above is shown with its age. `unknown`: Stripe answered but would not
   *  describe the account (e.g. a restricted key without accounts.retrieve) —
   *  the connection is fine, so this is deliberately NOT surfaced as a warning
   *  (#3777 review F2). */
  cacheState?: "fresh" | "stale" | "unknown" | "reconnect_required";
  error?: { code: string; message: string } | null;
}

/** Mask an `acct_…` id so only the last 4 chars are shown (e.g. `acct_••••1A2b`). */
function maskAccountId(id: string): string {
  if (id.length <= 4) return id;
  return `acct_••••${id.slice(-4)}`;
}

export default function StripePaymentsIntegration() {
  const { t } = useTranslation("integrations");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<ConnectState>({ status: "disconnected" });
  const [apiKey, setApiKey] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const res = await fetchWithAuth("/partner/stripe-connect");
      if (res.status === 401) return UNAUTHORIZED();
      if (!res.ok) throw new Error(t("stripePaymentsIntegration.loadFailed"));
      const body = (await res.json()) as ConnectState;
      setState(
        body.status === "connected" || body.status === "reconnect_required"
          ? body
          : { status: "disconnected" },
      );
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const saveKey = useCallback(async () => {
    if (busy) return;
    const key = apiKey.trim();
    if (!key) return;
    setBusy(true);
    try {
      await runAction({
        request: () =>
          fetchWithAuth("/partner/stripe-connect/key", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ apiKey: key }),
          }),
        errorFallback: t("stripePaymentsIntegration.couldNotSaveStripeKey"),
        successMessage: t("stripePaymentsIntegration.stripeKeySaved"),
        onUnauthorized: UNAUTHORIZED,
      });
      setApiKey("");
      await load();
    } catch (err) {
      handleActionError(
        err,
        t("stripePaymentsIntegration.couldNotSaveStripeKey"),
      );
    } finally {
      setBusy(false);
    }
  }, [busy, apiKey, load]);

  const refreshAccount = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      await runAction({
        request: () =>
          fetchWithAuth("/partner/stripe-connect/refresh", { method: "POST" }),
        errorFallback: t("stripePaymentsIntegration.couldNotRefresh"),
        successMessage: t("stripePaymentsIntegration.refreshed"),
        onUnauthorized: UNAUTHORIZED,
      });
      await load();
    } catch (err) {
      handleActionError(err, t("stripePaymentsIntegration.couldNotRefresh"));
    } finally {
      setBusy(false);
    }
  }, [busy, load]);

  const disconnect = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      await runAction({
        request: () =>
          fetchWithAuth("/partner/stripe-connect", { method: "DELETE" }),
        errorFallback: t("stripePaymentsIntegration.couldNotDisconnectStripe"),
        successMessage: t("stripePaymentsIntegration.stripeDisconnected"),
        onUnauthorized: UNAUTHORIZED,
      });
      await load();
    } catch (err) {
      handleActionError(
        err,
        t("stripePaymentsIntegration.couldNotDisconnectStripe"),
      );
    } finally {
      setBusy(false);
    }
  }, [busy, load]);

  // Refresh + Disconnect. Rendered for `connected` AND for `reconnect_required`:
  // that state can be a false positive (a restricted key, a blip Stripe reported
  // as an auth failure), and hiding both actions leaves the partner with no
  // in-page way to re-check or to clear the connection (#3777 review F3).
  const connectionActions = (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={() => void refreshAccount()}
        disabled={busy}
        data-testid="stripe-connect-refresh-button"
        className="inline-flex items-center justify-center rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50"
      >
        {busy
          ? t("stripePaymentsIntegration.refreshing")
          : t("stripePaymentsIntegration.refresh")}
      </button>
      <button
        type="button"
        onClick={() => void disconnect()}
        disabled={busy}
        data-testid="stripe-disconnect-button"
        className="inline-flex items-center justify-center rounded-md border border-destructive/40 px-4 py-2 text-sm font-medium text-destructive hover:bg-destructive/10 disabled:opacity-50"
      >
        {busy
          ? t("stripePaymentsIntegration.working")
          : t("stripePaymentsIntegration.disconnect")}
      </button>
    </div>
  );

  return (
    <section
      className="rounded-lg border bg-card p-6 shadow-xs"
      data-testid="stripe-connect-card"
    >
      <h2 className="text-lg font-semibold">
        {t("stripePaymentsIntegration.onlinePayments")}
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        {t("stripePaymentsIntegration.pasteYourStripeSecretKeyToLetCustomers")}{" "}
        <a
          href="https://dashboard.stripe.com/apikeys"
          target="_blank"
          rel="noreferrer noopener"
          className="underline hover:text-foreground"
        >
          {t("stripePaymentsIntegration.stripeDashboard")}
        </a>
        .
      </p>

      {!loading && !loadError && state.status === "reconnect_required" ? (
        <p
          id="stripe-connect-reconnect-required"
          role="alert"
          className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          data-testid="stripe-connect-reconnect-required"
        >
          {t("stripePaymentsIntegration.reconnectRequired", {
            last4: state.last4 ?? "????",
            reason: state.error?.message ?? "",
          })}
        </p>
      ) : null}

      <div className="mt-4">
        {loading ? (
          <p className="text-sm text-muted-foreground">
            {t("stripePaymentsIntegration.loadingStripeConnection")}
          </p>
        ) : loadError ? (
          <p
            className="text-sm text-destructive"
            data-testid="stripe-connect-load-error"
          >
            {t("stripePaymentsIntegration.couldNotLoadStripeConnection")}{" "}
            <button
              type="button"
              onClick={() => void load()}
              className="underline hover:text-foreground"
            >
              {t("common:actions.retry")}
            </button>
          </p>
        ) : state.status === "connected" ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span
                className="font-medium"
                data-testid="stripe-connect-account"
              >
                {state.stripeAccountId
                  ? maskAccountId(state.stripeAccountId)
                  : t("stripePaymentsIntegration.connected")}
              </span>
              {state.last4 ? (
                <span
                  className="text-muted-foreground"
                  data-testid="stripe-connect-key-last4"
                >
                  {t("stripePaymentsIntegration.key", {
                    last4: state.last4,
                  })}
                </span>
              ) : null}
              <span
                data-testid="stripe-connect-mode"
                className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium ${
                  state.livemode
                    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                    : "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400"
                }`}
              >
                {state.livemode
                  ? t("stripePaymentsIntegration.live")
                  : t("stripePaymentsIntegration.testMode")}
              </span>
              {/* Cached settlement currency (#3777) — what Stripe settles in.
                  Documents in another currency still work; they just warn. */}
              <span
                className="text-muted-foreground"
                data-testid="stripe-connect-currency"
              >
                {state.defaultCurrency
                  ? [
                      t("stripePaymentsIntegration.defaultCurrency", {
                        currency: state.defaultCurrency,
                      }),
                      state.accountCountry
                        ? t("stripePaymentsIntegration.accountCountry", {
                            country: state.accountCountry,
                          })
                        : null,
                      state.accountRefreshedAt
                        ? t("stripePaymentsIntegration.refreshedAt", {
                            when: formatDateTime(state.accountRefreshedAt, {
                              dateStyle: "medium",
                              timeStyle: "short",
                            }),
                          })
                        : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")
                  : t("stripePaymentsIntegration.notCached")}
              </span>
              {state.cacheState === "stale" ? (
                <span
                  className="text-amber-700 dark:text-amber-400"
                  data-testid="stripe-connect-stale"
                >
                  {t("stripePaymentsIntegration.staleCache")}
                </span>
              ) : null}
            </div>
            {connectionActions}
          </div>
        ) : (
          <div className="flex flex-wrap items-start justify-between gap-3">
            <form
              className="flex flex-wrap items-center gap-3"
              aria-describedby={state.status === "reconnect_required" ? "stripe-connect-reconnect-required" : undefined}
              onSubmit={(e) => {
                e.preventDefault();
                void saveKey();
              }}
            >
              <input
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={t("stripePaymentsIntegration.skLiveOrRkLive")}
                data-testid="stripe-key-input"
                className="min-w-[16rem] flex-1 rounded-md border bg-background px-3 py-2 font-mono text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
              />
              <button
                type="submit"
                disabled={busy || !apiKey.trim()}
                data-testid="stripe-key-save-button"
                className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
              >
                {busy
                  ? t("stripePaymentsIntegration.saving")
                  : t("stripePaymentsIntegration.saveKey")}
              </button>
            </form>
            {/* A stored-but-rejected key still has something to re-check or clear. */}
            {state.status === "reconnect_required" ? connectionActions : null}
          </div>
        )}
      </div>
    </section>
  );
}
