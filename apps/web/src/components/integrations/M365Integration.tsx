import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Eye,
  EyeOff,
  Loader2,
  Save,
  Unplug,
  Building2
} from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';

type Connection = {
  connected: boolean;
  tenantId?: string;
  clientId?: string;
  displayName?: string | null;
  status?: string;
  lastVerifiedAt?: string | null;
};

type SaveState = { status: 'idle' | 'saving' | 'saved' | 'error'; message?: string };

export default function M365Integration() {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [connection, setConnection] = useState<Connection | null>(null);

  const [tenantId, setTenantId] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [showSecret, setShowSecret] = useState(false);

  const [saveState, setSaveState] = useState<SaveState>({ status: 'idle' });

  const isConnected = !!connection?.connected;
  const canSave =
    tenantId.trim().length > 0 &&
    clientId.trim().length > 0 &&
    (clientSecret.trim().length > 0 || isConnected);

  const fetchConnection = useCallback(async () => {
    try {
      const res = await fetchWithAuth('/m365/connection');
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        setLoadError(
          `Failed to load connection (${res.status}): ${(json as Record<string, unknown>).error ?? res.statusText}`
        );
        return;
      }
      const data = (await res.json()) as Connection;
      setConnection(data);
      if (data.connected) {
        setTenantId(data.tenantId ?? '');
        setClientId(data.clientId ?? '');
        setClientSecret('');
      }
    } catch (err) {
      setLoadError(`Failed to load connection: ${err instanceof Error ? err.message : 'Network error'}`);
    }
  }, []);

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      await fetchConnection();
      setLoading(false);
    };
    load();
  }, [fetchConnection]);

  const handleSave = async () => {
    setSaveState({ status: 'saving' });
    try {
      const res = await fetchWithAuth('/m365/connection', {
        method: 'POST',
        body: JSON.stringify({
          tenantId: tenantId.trim(),
          clientId: clientId.trim(),
          clientSecret: clientSecret.trim()
        })
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        const hint = (json as Record<string, unknown>).hint;
        setSaveState({
          status: 'error',
          message: `${(json as Record<string, unknown>).error ?? 'Failed to save'}${hint ? ` — ${hint}` : ''}`
        });
        return;
      }
      setSaveState({ status: 'saved', message: 'Connection verified and saved.' });
      setClientSecret('');
      await fetchConnection();
    } catch (err) {
      setSaveState({ status: 'error', message: err instanceof Error ? err.message : 'Network error' });
    }
  };

  const handleDisconnect = async () => {
    setSaveState({ status: 'saving' });
    try {
      const res = await fetchWithAuth('/m365/connection', { method: 'DELETE' });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        const err = (json as Record<string, unknown>).error;
        setSaveState({ status: 'error', message: typeof err === 'string' ? err : 'Failed to disconnect' });
        return;
      }
      setSaveState({ status: 'idle' });
      setConnection({ connected: false });
      setTenantId('');
      setClientId('');
      setClientSecret('');
    } catch (err) {
      setSaveState({ status: 'error', message: err instanceof Error ? err.message : 'Network error' });
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Building2 className="h-5 w-5" />
        </div>
        <div>
          <h1 className="text-2xl font-semibold">Microsoft 365</h1>
          <p className="text-sm text-muted-foreground">
            Connect an Entra (Azure AD) app registration so the AI assistant can look up users, manage
            groups, disable accounts, and reset passwords for this organization's tenant.
          </p>
        </div>
        {isConnected ? (
          <span className="ml-auto inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs text-emerald-700">
            <CheckCircle2 className="h-3.5 w-3.5" /> Connected
          </span>
        ) : (
          <span className="ml-auto inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs text-slate-600">
            <Unplug className="h-3.5 w-3.5" /> Not connected
          </span>
        )}
      </div>

      {loadError && (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">{loadError}</div>
      )}

      {/* Connection card */}
      <div className="rounded-xl border bg-card p-6 shadow-sm">
        <h2 className="text-lg font-semibold">Connection</h2>
        <p className="mb-4 text-sm text-muted-foreground">
          Enter the tenant id, app (client) id, and a client secret from your Entra app registration.
          Breeze makes a live Graph call to verify the credentials before saving.
          {!isConnected && ' Saving requires MFA verification.'}
        </p>

        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <label className="mb-1 block text-sm font-medium">Tenant ID</label>
            <input
              type="text"
              value={tenantId}
              onChange={(e) => setTenantId(e.target.value)}
              placeholder="contoso.onmicrosoft.com or tenant GUID"
              className="h-10 w-full rounded-md border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-primary/30"
            />
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium">App (client) ID</label>
            <input
              type="text"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              placeholder="application (client) id"
              className="h-10 w-full rounded-md border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-primary/30"
            />
          </div>

          <div className="md:col-span-2">
            <label className="mb-1 block text-sm font-medium">
              Client secret
              {isConnected && (
                <span className="ml-1 text-xs text-muted-foreground">(leave blank to keep the stored secret)</span>
              )}
            </label>
            <div className="relative">
              <input
                type={showSecret ? 'text' : 'password'}
                value={clientSecret}
                onChange={(e) => setClientSecret(e.target.value)}
                placeholder={isConnected ? '•••••••••• (stored, encrypted)' : 'app client secret'}
                className="h-10 w-full rounded-md border bg-background px-3 pr-10 text-sm outline-none focus:ring-2 focus:ring-primary/30"
              />
              <button
                type="button"
                onClick={() => setShowSecret(!showSecret)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                aria-label={showSecret ? 'Hide secret' : 'Show secret'}
              >
                {showSecret ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>
        </div>

        <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
          Reads (lookup, groups, sign-ins) need <span className="font-medium">User.Read.All</span>,{' '}
          <span className="font-medium">Group.Read.All</span>, <span className="font-medium">AuditLog.Read.All</span>.
          To use the disable-user and reset-password commands, the app also needs{' '}
          <span className="font-medium">User.ReadWrite.All</span> +{' '}
          <span className="font-medium">User-PasswordProfile.ReadWrite.All</span> and the{' '}
          <span className="font-medium">User Administrator</span> Entra role.
        </div>

        <div className="mt-4 flex items-center gap-3">
          <button
            type="button"
            onClick={handleSave}
            disabled={!canSave || saveState.status === 'saving'}
            className="inline-flex h-10 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            {saveState.status === 'saving' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            {isConnected ? 'Update connection' : 'Save & verify'}
          </button>
          {isConnected && (
            <button
              type="button"
              onClick={handleDisconnect}
              disabled={saveState.status === 'saving'}
              className="inline-flex h-10 items-center gap-2 rounded-md border px-4 text-sm font-medium hover:bg-muted disabled:opacity-50"
            >
              <Unplug className="h-4 w-4" /> Disconnect
            </button>
          )}
          {saveState.status === 'saved' && <span className="text-sm text-emerald-600">{saveState.message}</span>}
          {saveState.status === 'error' && (
            <span className="inline-flex items-center gap-1 text-sm text-red-600">
              <AlertTriangle className="h-4 w-4" /> {saveState.message}
            </span>
          )}
        </div>
      </div>

      {/* Status card */}
      {isConnected && (
        <div className="rounded-xl border bg-card p-6 shadow-sm">
          <h2 className="text-lg font-semibold">Connection details</h2>
          <div className="mt-4 space-y-2 text-sm">
            <div className="flex justify-between text-muted-foreground">
              <span>Tenant</span>
              <span className="text-foreground">{connection?.displayName ?? connection?.tenantId}</span>
            </div>
            <div className="flex justify-between text-muted-foreground">
              <span>Tenant ID</span>
              <span className="text-foreground">{connection?.tenantId}</span>
            </div>
            <div className="flex justify-between text-muted-foreground">
              <span>App (client) ID</span>
              <span className="text-foreground">{connection?.clientId}</span>
            </div>
            <div className="flex justify-between text-muted-foreground">
              <span>Last verified</span>
              <span className="text-foreground">
                {connection?.lastVerifiedAt ? new Date(connection.lastVerifiedAt).toLocaleString() : 'Never'}
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
