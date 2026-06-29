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

type ConnectionStatus = 'connected' | 'error' | 'reauth_required';

// Mirrors the GET /unifi contract: `{ connected: false }` when not connected, otherwise
// `{ connected: true, status, accountLabel, lastSyncAt, lastSyncStatus, lastSyncError }`.
interface UnifiStatus {
  connected: boolean;
  status?: ConnectionStatus;
  accountLabel?: string | null;
  lastSyncAt?: string | null;
  lastSyncStatus?: string | null;
  lastSyncError?: string | null;
}

export default function UnifiIntegration() {
  const claims = getJwtClaims();
  const isOrgScoped = claims.scope === 'organization';

  const [status, setStatus] = useState<UnifiStatus | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  const onUnauthorized = useCallback(() => {
    navigateTo(loginPathWithNext());
  }, []);

  const fetchStatus = useCallback(async () => {
    const res = await fetchWithAuth('/unifi');
    if (res.status === 401) {
      onUnauthorized();
      return null;
    }
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(`Failed to load UniFi status (${res.status})`);
    }
    return json as UnifiStatus;
  }, [onUnauthorized]);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const data = await fetchStatus();
      if (data) setStatus(data);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to load UniFi status.');
    } finally {
      setLoading(false);
    }
  }, [fetchStatus]);

  useEffect(() => {
    if (isOrgScoped) {
      setLoading(false);
      return;
    }
    void load();
  }, [isOrgScoped, load]);

  const handleConnect = useCallback(async () => {
    const key = apiKey.trim();
    if (!key) {
      setLoadError('Enter a UniFi Site Manager API key to connect.');
      return;
    }
    setConnecting(true);
    setLoadError(null);
    try {
      await runAction({
        request: () => fetchWithAuth('/unifi/connect', {
          method: 'POST',
          body: JSON.stringify({ apiKey: key }),
        }),
        errorFallback: 'Failed to connect to UniFi.',
        successMessage: 'UniFi connected',
        onUnauthorized,
      });
      setApiKey('');
      await load();
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) handleActionError(err, 'Failed to connect to UniFi.');
    } finally {
      setConnecting(false);
    }
  }, [apiKey, load, onUnauthorized]);

  const handleSync = useCallback(async () => {
    setSyncing(true);
    try {
      await runAction({
        request: () => fetchWithAuth('/unifi/sync', { method: 'POST' }),
        errorFallback: 'Failed to sync UniFi sites.',
        successMessage: 'UniFi sync started',
        onUnauthorized,
      });
      await load();
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) handleActionError(err, 'Failed to sync UniFi sites.');
    } finally {
      setSyncing(false);
    }
  }, [load, onUnauthorized]);

  const handleDisconnect = useCallback(async () => {
    setDisconnecting(true);
    try {
      await runAction({
        request: () => fetchWithAuth('/unifi/disconnect', { method: 'POST' }),
        errorFallback: 'Failed to disconnect UniFi.',
        successMessage: 'UniFi disconnected',
        onUnauthorized,
      });
      await load();
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) handleActionError(err, 'Failed to disconnect UniFi.');
    } finally {
      setDisconnecting(false);
    }
  }, [load, onUnauthorized]);

  if (isOrgScoped) {
    return (
      <div className="space-y-6" data-testid="unifi-panel">
        <Header />
        <p className="text-center text-sm text-muted-foreground" data-testid="unifi-org-scope">
          The UniFi network integration is available to partner accounts only.
        </p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-12 text-sm text-muted-foreground" data-testid="unifi-loading">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading UniFi status…
      </div>
    );
  }

  // Connected vs. not is the API's `connected` boolean. The `status` string then
  // distinguishes healthy ('connected') from degraded ('error' / 'reauth_required').
  const isConnected = status?.connected === true;
  const needsReauth = isConnected && status?.status === 'reauth_required';
  const hasError = isConnected && status?.status === 'error';

  return (
    <div className="space-y-6" data-testid="unifi-panel">
      <div className="flex items-center gap-3">
        <Header />
        {needsReauth ? (
          <span
            className="ml-auto inline-flex items-center gap-1.5 rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-xs text-amber-700"
            data-testid="unifi-status-reauth"
          >
            <AlertTriangle className="h-3.5 w-3.5" /> Reconnect required
          </span>
        ) : hasError ? (
          <span
            className="ml-auto inline-flex items-center gap-1.5 rounded-full border border-red-200 bg-red-50 px-3 py-1 text-xs text-red-700"
            data-testid="unifi-status-error"
          >
            <AlertTriangle className="h-3.5 w-3.5" /> Sync error
          </span>
        ) : isConnected ? (
          <span
            className="ml-auto inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs text-emerald-700"
            data-testid="unifi-status-connected"
          >
            <CheckCircle2 className="h-3.5 w-3.5" /> Connected
          </span>
        ) : (
          <span
            className="ml-auto inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs text-slate-600"
            data-testid="unifi-status-disconnected"
          >
            <Unplug className="h-3.5 w-3.5" /> Not connected
          </span>
        )}
      </div>

      {loadError && (
        <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800" data-testid="unifi-load-error">
          {loadError}
        </p>
      )}

      {!isConnected && (
        <div className="rounded-lg border bg-card p-5" data-testid="unifi-disconnected">
          <p className="text-sm text-muted-foreground">
            Connect your UniFi Site Manager account with a cloud API key to discover sites,
            gateways, switches, and access points across your hosts. Breeze maps UniFi sites to
            your Breeze sites and reconciles discovered network assets.
          </p>
          <label className="mt-4 block text-sm font-medium" htmlFor="unifi-api-key">
            UniFi Site Manager API key
          </label>
          <input
            id="unifi-api-key"
            type="password"
            autoComplete="off"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="Paste your API key"
            className="mt-2 h-10 w-full max-w-md rounded-md border bg-background px-3 text-sm"
            data-testid="unifi-api-key"
          />
          <button
            type="button"
            onClick={() => void handleConnect()}
            disabled={connecting || !apiKey.trim()}
            className="mt-4 inline-flex h-10 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
            data-testid="unifi-connect"
          >
            {connecting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plug className="h-4 w-4" />}
            Connect to UniFi
          </button>
        </div>
      )}

      {isConnected && status && (
        <div className="space-y-5 rounded-lg border bg-card p-5" data-testid="unifi-connected">
          {/* Degraded states must be loud — a connection in 'error' or 'reauth_required'
              still renders the connected view, but with a prominent banner so the
              operator sees the backend's message instead of silently failing syncs. */}
          {needsReauth && (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-3 text-sm text-amber-800" data-testid="unifi-reauth-banner">
              <p className="font-medium">UniFi needs to be reconnected — the stored API key was rejected.</p>
              {status.lastSyncError && (
                <p className="mt-1 text-xs text-amber-700" data-testid="unifi-last-error">{status.lastSyncError}</p>
              )}
              <button
                type="button"
                onClick={() => void handleDisconnect()}
                disabled={disconnecting}
                className="mt-3 inline-flex h-9 items-center gap-2 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
                data-testid="unifi-reconnect"
              >
                {disconnecting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plug className="h-4 w-4" />}
                Reconnect UniFi
              </button>
            </div>
          )}
          {hasError && status.lastSyncError && (
            <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800" data-testid="unifi-last-error">
              {status.lastSyncError}
            </p>
          )}

          <dl className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <dt className="text-muted-foreground">Account</dt>
              <dd className="font-medium" data-testid="unifi-account-label">{status.accountLabel ?? '—'}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Last sync</dt>
              <dd className="font-medium" data-testid="unifi-last-sync">
                {status.lastSyncAt ? formatDateTime(status.lastSyncAt) : 'Never'}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Last sync status</dt>
              <dd className="font-medium" data-testid="unifi-last-sync-status">{status.lastSyncStatus ?? '—'}</dd>
            </div>
          </dl>

          {/* Site mapping + discovery history tables are scaffolded as a follow-up
              (the /unifi/hosts endpoint and reconciliation UI land in a later task). */}

          <div className="flex items-center gap-3 border-t pt-4">
            <button
              type="button"
              onClick={() => void handleSync()}
              disabled={syncing}
              className="inline-flex h-9 items-center gap-2 rounded-md border px-3 text-sm font-medium hover:bg-muted disabled:opacity-50"
              data-testid="unifi-sync"
            >
              {syncing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              Sync now
            </button>
            <button
              type="button"
              onClick={() => void handleDisconnect()}
              disabled={disconnecting}
              className="inline-flex h-9 items-center gap-2 rounded-md border border-red-200 px-3 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
              data-testid="unifi-disconnect"
            >
              {disconnecting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Unplug className="h-4 w-4" />}
              Disconnect
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Header() {
  return (
    <div className="flex items-center gap-3">
      <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
        <span className="text-sm font-bold">UI</span>
      </div>
      <div>
        <h1 className="text-2xl font-semibold">UniFi Network</h1>
        <p className="text-sm text-muted-foreground">Discover and reconcile UniFi network assets across your sites.</p>
      </div>
    </div>
  );
}
