import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Eye,
  EyeOff,
  Loader2,
  Save,
  Unplug,
  Users
} from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';

type Connection = {
  connected: boolean;
  customerDomain?: string;
  adminEmail?: string;
  serviceAccountEmail?: string;
  status?: string;
  lastVerifiedAt?: string | null;
};

type SaveState = { status: 'idle' | 'saving' | 'saved' | 'error'; message?: string };

// The exact domain-wide-delegation OAuth scopes the Google identity tools use.
// Keep in sync with ALL_DWD_SCOPES_CSV in apps/api/src/services/googleClient.ts.
const GOOGLE_DWD_SCOPES_CSV = [
  'https://www.googleapis.com/auth/admin.directory.user',
  'https://www.googleapis.com/auth/admin.directory.user.security',
  'https://www.googleapis.com/auth/admin.directory.user.alias',
  'https://www.googleapis.com/auth/admin.directory.group',
  'https://www.googleapis.com/auth/admin.directory.group.member',
  'https://www.googleapis.com/auth/admin.directory.device.mobile.action',
  'https://www.googleapis.com/auth/gmail.settings.basic',
  'https://www.googleapis.com/auth/gmail.settings.sharing',
  'https://www.googleapis.com/auth/calendar.acls',
  'https://www.googleapis.com/auth/apps.licensing'
].join(',');

export default function GoogleWorkspaceIntegration() {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [connection, setConnection] = useState<Connection | null>(null);

  const [customerDomain, setCustomerDomain] = useState('');
  const [adminEmail, setAdminEmail] = useState('');
  const [serviceAccountKey, setServiceAccountKey] = useState('');
  const [showKey, setShowKey] = useState(false);

  const [saveState, setSaveState] = useState<SaveState>({ status: 'idle' });

  const isConnected = !!connection?.connected;
  // When already connected the key may be left blank to keep the stored one;
  // a fresh connection requires all three fields.
  const canSave =
    customerDomain.trim().length > 0 &&
    adminEmail.trim().length > 0 &&
    (serviceAccountKey.trim().length > 0 || isConnected);

  const fetchConnection = useCallback(async () => {
    try {
      const res = await fetchWithAuth('/google/connection');
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
        setCustomerDomain(data.customerDomain ?? '');
        setAdminEmail(data.adminEmail ?? '');
        setServiceAccountKey('');
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
      const res = await fetchWithAuth('/google/connection', {
        method: 'POST',
        body: JSON.stringify({
          customerDomain: customerDomain.trim(),
          adminEmail: adminEmail.trim(),
          serviceAccountKey: serviceAccountKey.trim()
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
      setServiceAccountKey('');
      await fetchConnection();
    } catch (err) {
      setSaveState({ status: 'error', message: err instanceof Error ? err.message : 'Network error' });
    }
  };

  const handleDisconnect = async () => {
    setSaveState({ status: 'saving' });
    try {
      const res = await fetchWithAuth('/google/connection', { method: 'DELETE' });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        const err = (json as Record<string, unknown>).error;
        setSaveState({ status: 'error', message: typeof err === 'string' ? err : 'Failed to disconnect' });
        return;
      }
      setSaveState({ status: 'idle' });
      setConnection({ connected: false });
      setCustomerDomain('');
      setAdminEmail('');
      setServiceAccountKey('');
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
          <Users className="h-5 w-5" />
        </div>
        <div>
          <h1 className="text-2xl font-semibold">Google Workspace</h1>
          <p className="text-sm text-muted-foreground">
            Connect a Workspace domain so the AI assistant can look up users, manage groups, reset
            passwords, run guided offboarding, and more for this organization.
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
          Paste the service-account JSON key and the super-admin it impersonates. Breeze makes a live
          Directory API call to verify domain-wide delegation before saving.
          {!isConnected && ' Saving requires MFA verification.'}
        </p>

        <details className="mb-4 rounded-md border bg-muted/40 p-3 text-sm">
          <summary className="cursor-pointer font-medium">How to get the service-account JSON and authorize delegation</summary>
          <ol className="mt-3 list-decimal space-y-1.5 pl-5 text-muted-foreground">
            <li>
              In the <span className="font-medium text-foreground">Google Cloud Console</span>, open{' '}
              <span className="font-medium text-foreground">IAM &amp; Admin → Service Accounts</span> and create one (or pick an
              existing service account) in the project you want to use.
            </li>
            <li>
              Open the service account, go to the <span className="font-medium text-foreground">Keys</span> tab →{' '}
              <span className="font-medium text-foreground">Add key → Create new key → JSON → Create</span>. The JSON downloads
              once. That file is what you paste below. Also note the service account's{' '}
              <span className="font-medium text-foreground">Client ID</span> (its numeric Unique ID).
            </li>
            <li>
              Enable the APIs the tools use in that project (APIs &amp; Services → Enable APIs):{' '}
              <span className="font-medium text-foreground">Admin SDK, Gmail, Calendar, Enterprise License Manager</span>.
            </li>
            <li>
              In the <span className="font-medium text-foreground">Google Admin console</span>, go to{' '}
              <span className="font-medium text-foreground">Security → Access and data control → API controls → Manage Domain Wide
              Delegation → Add new</span>. Paste the service account's Client ID, and in OAuth Scopes paste the comma-separated list
              below, then Authorize.
            </li>
          </ol>
          <p className="mt-3 font-medium text-foreground">OAuth scopes to authorize:</p>
          <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded bg-background p-2 text-[11px] leading-relaxed text-muted-foreground">{GOOGLE_DWD_SCOPES_CSV}</pre>
        </details>

        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <label className="mb-1 block text-sm font-medium">Primary domain</label>
            <input
              type="text"
              value={customerDomain}
              onChange={(e) => setCustomerDomain(e.target.value)}
              placeholder="example.com"
              className="h-10 w-full rounded-md border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-primary/30"
            />
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium">Super-admin email (impersonated)</label>
            <input
              type="email"
              value={adminEmail}
              onChange={(e) => setAdminEmail(e.target.value)}
              placeholder="admin@example.com"
              className="h-10 w-full rounded-md border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-primary/30"
            />
          </div>

          <div className="md:col-span-2">
            <label className="mb-1 block text-sm font-medium">
              Service-account JSON key
              {isConnected && (
                <span className="ml-1 text-xs text-muted-foreground">(leave blank to keep the stored key)</span>
              )}
            </label>
            <div className="relative">
              <textarea
                value={serviceAccountKey}
                onChange={(e) => setServiceAccountKey(e.target.value)}
                rows={showKey ? 10 : 3}
                placeholder={isConnected ? '•••••••••• (stored, encrypted)' : 'Paste the full service-account JSON key file here'}
                className={`w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/30 ${showKey ? '' : 'blur-[3px] focus:blur-0'}`}
              />
              <button
                type="button"
                onClick={() => setShowKey(!showKey)}
                className="absolute right-2 top-2 text-muted-foreground hover:text-foreground"
                aria-label={showKey ? 'Hide key' : 'Show key'}
              >
                {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>
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
              <span>Domain</span>
              <span className="text-foreground">{connection?.customerDomain}</span>
            </div>
            <div className="flex justify-between text-muted-foreground">
              <span>Admin (impersonated)</span>
              <span className="text-foreground">{connection?.adminEmail}</span>
            </div>
            <div className="flex justify-between text-muted-foreground">
              <span>Service account</span>
              <span className="text-foreground">{connection?.serviceAccountEmail}</span>
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
