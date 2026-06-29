import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Plug,
  RefreshCw,
  Unplug,
} from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';
import { runAction, handleActionError, ActionError } from '../../lib/runAction';
import { navigateTo } from '@/lib/navigation';
import { loginPathWithNext, getJwtClaims } from '../../lib/authScope';
import { formatDateTime } from '@/lib/dateTimeFormat';
import { showToast } from '../shared/Toast';
import QuickbooksCustomerImport from './QuickbooksCustomerImport';

type ConnectionStatus = 'connected' | 'disconnected' | 'reauth_required' | 'error';
type PushMode = 'auto' | 'manual';

interface QuickbooksStatus {
  status: ConnectionStatus;
  environment: 'sandbox' | 'production' | null;
  pushMode: PushMode;
  connectedAt: string | null;
  lastError: string | null;
  defaultIncomeAccountRef?: string | null;
  defaultTaxCodeRef?: string | null;
}

const MFA_HINT = 'This action requires multi-factor authentication. Enable MFA on your account, then try again.';

function isMfaError(err: unknown): boolean {
  return err instanceof ActionError && err.status === 403 && /mfa required/i.test(err.message);
}

export default function QuickbooksIntegration() {
  const claims = getJwtClaims();
  const isOrgScoped = claims.scope === 'organization';

  const [status, setStatus] = useState<QuickbooksStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [savingMode, setSavingMode] = useState(false);

  const onUnauthorized = useCallback(() => {
    navigateTo(loginPathWithNext());
  }, []);

  const fetchStatus = useCallback(async () => {
    const res = await fetchWithAuth('/accounting/quickbooks');
    if (res.status === 401) {
      onUnauthorized();
      return null;
    }
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(`Failed to load QuickBooks status (${res.status})`);
    }
    return json as QuickbooksStatus;
  }, [onUnauthorized]);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const data = await fetchStatus();
      if (data) setStatus(data);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to load QuickBooks status.');
    } finally {
      setLoading(false);
    }
  }, [fetchStatus]);

  // Surface the OAuth round-trip result. The API callback redirects back to
  // /integrations?accounting=quickbooks&connected=1 (or &error=...). Show a
  // toast, strip the params so a refresh doesn't re-toast, then load status.
  useEffect(() => {
    if (isOrgScoped || typeof window === 'undefined') {
      setLoading(false);
      return;
    }
    const params = new URLSearchParams(window.location.search);
    if (params.get('accounting') === 'quickbooks') {
      if (params.get('connected') === '1') {
        showToast({ type: 'success', message: 'QuickBooks connected.' });
      } else if (params.get('error')) {
        showToast({ type: 'error', message: 'QuickBooks connection failed. Please try again.' });
      }
      params.delete('accounting');
      params.delete('connected');
      params.delete('error');
      const next = `${window.location.pathname}${params.toString() ? `?${params}` : ''}${window.location.hash}`;
      window.history.replaceState({}, '', next);
    }
    void load();
  }, [isOrgScoped, load]);

  const handleConnect = useCallback(async () => {
    setConnecting(true);
    setLoadError(null);
    try {
      const result = await runAction<{ authUrl: string }>({
        request: () => fetchWithAuth('/accounting/quickbooks/connect'),
        errorFallback: 'Failed to start the QuickBooks connection.',
        onUnauthorized,
      });
      // Full-page navigation to Intuit's consent screen.
      window.location.assign(result.authUrl);
    } catch (err) {
      if (isMfaError(err)) setLoadError(MFA_HINT);
      else if (!(err instanceof ActionError)) handleActionError(err, 'Failed to start the QuickBooks connection.');
      setConnecting(false);
    }
  }, [onUnauthorized]);

  const handleDisconnect = useCallback(async () => {
    setDisconnecting(true);
    try {
      await runAction({
        request: () => fetchWithAuth('/accounting/quickbooks/disconnect', { method: 'POST' }),
        errorFallback: 'Failed to disconnect QuickBooks.',
        successMessage: 'QuickBooks disconnected',
        onUnauthorized,
      });
      await load();
    } catch (err) {
      if (isMfaError(err)) setLoadError(MFA_HINT);
      else if (!(err instanceof ActionError)) handleActionError(err, 'Failed to disconnect QuickBooks.');
    } finally {
      setDisconnecting(false);
    }
  }, [load, onUnauthorized]);

  const handleSetPushMode = useCallback(async (pushMode: PushMode) => {
    if (savingMode || status?.pushMode === pushMode) return;
    setSavingMode(true);
    try {
      const updated = await runAction<QuickbooksStatus>({
        request: () => fetchWithAuth('/accounting/quickbooks/settings', {
          method: 'PATCH',
          body: JSON.stringify({ pushMode }),
        }),
        errorFallback: 'Failed to update the push setting.',
        successMessage: pushMode === 'auto' ? 'Invoices will push automatically on issue' : 'Invoices will push manually',
        onUnauthorized,
      });
      setStatus((prev) => (prev ? { ...prev, pushMode: updated.pushMode } : prev));
    } catch (err) {
      if (isMfaError(err)) setLoadError(MFA_HINT);
      else if (!(err instanceof ActionError)) handleActionError(err, 'Failed to update the push setting.');
    } finally {
      setSavingMode(false);
    }
  }, [savingMode, status?.pushMode, onUnauthorized]);

  if (isOrgScoped) {
    return (
      <div className="space-y-6" data-testid="quickbooks-panel">
        <Header />
        <p className="text-center text-sm text-muted-foreground" data-testid="quickbooks-org-scope">
          The QuickBooks accounting integration is available to partner accounts only.
        </p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-12 text-sm text-muted-foreground" data-testid="quickbooks-loading">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading QuickBooks status…
      </div>
    );
  }

  const isConnected = status?.status === 'connected';
  const needsReauth = status?.status === 'reauth_required';

  return (
    <div className="space-y-6" data-testid="quickbooks-panel">
      <div className="flex items-center gap-3">
        <Header />
        {isConnected ? (
          <span
            className="ml-auto inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs text-emerald-700"
            data-testid="quickbooks-status-connected"
          >
            <CheckCircle2 className="h-3.5 w-3.5" /> Connected
          </span>
        ) : needsReauth ? (
          <span
            className="ml-auto inline-flex items-center gap-1.5 rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-xs text-amber-700"
            data-testid="quickbooks-status-reauth"
          >
            <AlertTriangle className="h-3.5 w-3.5" /> Reconnect required
          </span>
        ) : (
          <span
            className="ml-auto inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs text-slate-600"
            data-testid="quickbooks-status-disconnected"
          >
            <Unplug className="h-3.5 w-3.5" /> Not connected
          </span>
        )}
      </div>

      {loadError && (
        <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800" data-testid="quickbooks-load-error">
          {loadError}
        </p>
      )}

      {!isConnected && (
        <div className="rounded-lg border bg-card p-5">
          <p className="text-sm text-muted-foreground">
            {needsReauth
              ? 'Your QuickBooks authorization has expired. Reconnect to resume syncing invoices and payments.'
              : 'Connect your QuickBooks Online company to sync customers, invoices, and payments. Breeze stays your system of record.'}
          </p>
          {needsReauth && status?.lastError && (
            <p className="mt-2 text-xs text-amber-700" data-testid="quickbooks-last-error">{status.lastError}</p>
          )}
          <button
            type="button"
            onClick={() => void handleConnect()}
            disabled={connecting}
            className="mt-4 inline-flex h-10 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
            data-testid="quickbooks-connect"
          >
            {connecting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plug className="h-4 w-4" />}
            {needsReauth ? 'Reconnect QuickBooks' : 'Connect to QuickBooks'}
          </button>
        </div>
      )}

      {isConnected && status && (
        <div className="space-y-5 rounded-lg border bg-card p-5">
          <dl className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <dt className="text-muted-foreground">Environment</dt>
              <dd className="font-medium" data-testid="quickbooks-environment">{status.environment ?? '—'}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Connected</dt>
              <dd className="font-medium">{status.connectedAt ? formatDateTime(status.connectedAt) : '—'}</dd>
            </div>
          </dl>

          <div>
            <p className="text-sm font-medium">Invoice push</p>
            <p className="text-xs text-muted-foreground">
              Control when issued invoices are sent to QuickBooks.
            </p>
            <div className="mt-2 inline-flex overflow-hidden rounded-md border" data-testid="quickbooks-pushmode">
              {(['auto', 'manual'] as PushMode[]).map((mode) => {
                const active = status.pushMode === mode;
                return (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => void handleSetPushMode(mode)}
                    disabled={savingMode}
                    className={`px-3 py-1.5 text-sm transition disabled:opacity-50 ${
                      active ? 'bg-primary text-primary-foreground' : 'bg-background text-muted-foreground hover:text-foreground'
                    }`}
                    data-testid={`quickbooks-pushmode-${mode}`}
                  >
                    {mode === 'auto' ? 'Automatic on issue' : 'Manual'}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex items-center gap-3 border-t pt-4">
            <button
              type="button"
              onClick={() => void load()}
              className="inline-flex h-9 items-center gap-2 rounded-md border px-3 text-sm font-medium hover:bg-muted"
              data-testid="quickbooks-refresh"
            >
              <RefreshCw className="h-4 w-4" /> Refresh
            </button>
            <button
              type="button"
              onClick={() => void handleDisconnect()}
              disabled={disconnecting}
              className="inline-flex h-9 items-center gap-2 rounded-md border border-red-200 px-3 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
              data-testid="quickbooks-disconnect"
            >
              {disconnecting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Unplug className="h-4 w-4" />}
              Disconnect
            </button>
          </div>
        </div>
      )}

      {isConnected && <QuickbooksCustomerImport onUnauthorized={onUnauthorized} />}
    </div>
  );
}

function Header() {
  return (
    <div className="flex items-center gap-3">
      <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
        <span className="text-sm font-bold">QB</span>
      </div>
      <div>
        <h1 className="text-2xl font-semibold">QuickBooks Online</h1>
        <p className="text-sm text-muted-foreground">Sync customers, invoices, and payments to your books.</p>
      </div>
    </div>
  );
}
