import { useCallback, useEffect, useState } from 'react';
import { fetchWithAuth } from '../../stores/auth';
import { navigateTo } from '@/lib/navigation';
import { runAction, handleActionError } from '../../lib/runAction';

const UNAUTHORIZED = () => void navigateTo('/login', { replace: true });

type ConnectStatus = 'connected' | 'disconnected';

interface ConnectState {
  status: ConnectStatus;
  stripeAccountId?: string;
  livemode?: boolean;
}

/** Mask an `acct_…` id so only the last 4 chars are shown (e.g. `acct_••••1A2b`). */
function maskAccountId(id: string): string {
  if (id.length <= 4) return id;
  return `acct_••••${id.slice(-4)}`;
}

export default function StripeConnectCard() {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<ConnectState>({ status: 'disconnected' });

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const res = await fetchWithAuth('/partner/stripe-connect');
      if (res.status === 401) return UNAUTHORIZED();
      if (!res.ok) throw new Error('load failed');
      const body = (await res.json()) as ConnectState;
      setState(body.status === 'connected' ? body : { status: 'disconnected' });
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const connect = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const { url } = await runAction<{ url: string }>({
        request: () => fetchWithAuth('/partner/stripe-connect/oauth/start', { method: 'POST' }),
        errorFallback: 'Could not start Stripe connection.',
        onUnauthorized: UNAUTHORIZED,
      });
      if (url) window.location.href = url;
    } catch (err) {
      handleActionError(err, 'Could not start Stripe connection.');
    } finally {
      setBusy(false);
    }
  }, [busy]);

  const disconnect = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      await runAction({
        request: () => fetchWithAuth('/partner/stripe-connect', { method: 'DELETE' }),
        errorFallback: 'Could not disconnect Stripe.',
        successMessage: 'Stripe disconnected',
        onUnauthorized: UNAUTHORIZED,
      });
      await load();
    } catch (err) {
      handleActionError(err, 'Could not disconnect Stripe.');
    } finally {
      setBusy(false);
    }
  }, [busy, load]);

  return (
    <section className="rounded-lg border bg-card p-6 shadow-sm" data-testid="stripe-connect-card">
      <h2 className="text-lg font-semibold">Online payments</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Connect Stripe to let customers pay invoices online. Funds settle directly to your Stripe account.
      </p>

      <div className="mt-4">
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading Stripe connection…</p>
        ) : loadError ? (
          <p className="text-sm text-destructive" data-testid="stripe-connect-load-error">
            Could not load Stripe connection.{' '}
            <button type="button" onClick={() => void load()} className="underline hover:text-foreground">Retry</button>
          </p>
        ) : state.status === 'connected' ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-sm">
              <span className="font-medium" data-testid="stripe-connect-account">
                {state.stripeAccountId ? maskAccountId(state.stripeAccountId) : 'Connected'}
              </span>
              <span
                data-testid="stripe-connect-mode"
                className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium ${
                  state.livemode
                    ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
                    : 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400'
                }`}
              >
                {state.livemode ? 'Live' : 'Test mode'}
              </span>
            </div>
            <button
              type="button" onClick={() => void disconnect()} disabled={busy}
              data-testid="stripe-disconnect-button"
              className="inline-flex items-center justify-center rounded-md border border-destructive/40 px-4 py-2 text-sm font-medium text-destructive hover:bg-destructive/10 disabled:opacity-50"
            >
              {busy ? 'Working…' : 'Disconnect'}
            </button>
          </div>
        ) : (
          <button
            type="button" onClick={() => void connect()} disabled={busy}
            data-testid="stripe-connect-button"
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            {busy ? 'Redirecting…' : 'Connect Stripe'}
          </button>
        )}
      </div>
    </section>
  );
}
