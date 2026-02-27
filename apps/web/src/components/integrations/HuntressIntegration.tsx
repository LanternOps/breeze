import { useCallback, useEffect, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Eye,
  EyeOff,
  Loader2,
  RefreshCw,
  Save,
  Shield,
  Unplug
} from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';

type Integration = {
  id: string;
  orgId: string;
  name: string;
  accountId: string | null;
  apiBaseUrl: string;
  isActive: boolean;
  lastSyncAt: string | null;
  lastSyncStatus: string | null;
  lastSyncError: string | null;
  hasWebhookSecret: boolean;
  createdAt: string;
  updatedAt: string;
};

type StatusSummary = {
  totalAgents: number;
  mappedAgents: number;
  unmappedAgents: number;
  offlineAgents: number;
};

type IncidentSummary = {
  open: number;
  bySeverity: { severity: string; count: number }[];
  byStatus: { status: string; count: number }[];
};

type Incident = {
  id: string;
  severity: string;
  title: string;
  status: string;
  reportedAt: string;
};

type SaveState = { status: 'idle' | 'saving' | 'saved' | 'error'; message?: string };
type SyncState = { status: 'idle' | 'syncing' | 'done' | 'error'; message?: string };

const severityStyles: Record<string, string> = {
  critical: 'border-rose-200 bg-rose-50 text-rose-700',
  high: 'border-orange-200 bg-orange-50 text-orange-700',
  medium: 'border-amber-200 bg-amber-50 text-amber-700',
  low: 'border-slate-200 bg-slate-50 text-slate-600'
};

function SeverityBadge({ severity }: { severity: string }) {
  const style = severityStyles[severity.toLowerCase()] ?? severityStyles.low;
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs capitalize ${style}`}>
      {severity}
    </span>
  );
}

export default function HuntressIntegration() {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [integration, setIntegration] = useState<Integration | null>(null);
  const [coverage, setCoverage] = useState<StatusSummary | null>(null);
  const [incidents, setIncidents] = useState<IncidentSummary | null>(null);
  const [recentIncidents, setRecentIncidents] = useState<Incident[]>([]);

  const [name, setName] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [accountId, setAccountId] = useState('');
  const [webhookSecret, setWebhookSecret] = useState('');

  const [showApiKey, setShowApiKey] = useState(false);
  const [showWebhookSecret, setShowWebhookSecret] = useState(false);

  const [saveState, setSaveState] = useState<SaveState>({ status: 'idle' });
  const [syncState, setSyncState] = useState<SyncState>({ status: 'idle' });

  const canSave = name.trim().length > 0 && (apiKey.trim().length > 0 || !!integration);

  const fetchIntegration = useCallback(async () => {
    try {
      const res = await fetchWithAuth('/huntress/integration');
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        setLoadError(`Failed to load integration (${res.status}): ${(json as Record<string, unknown>).error ?? res.statusText}`);
        return;
      }
      const json = await res.json();
      const data = json.data as Integration | null;
      setIntegration(data);
      if (data) {
        setName(data.name);
        setAccountId(data.accountId ?? '');
        setApiKey('');
      }
    } catch (err) {
      setLoadError(`Failed to load integration: ${err instanceof Error ? err.message : 'Network error'}`);
    }
  }, []);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetchWithAuth('/huntress/status');
      if (!res.ok) {
        console.error(`[HuntressIntegration] Status fetch failed: ${res.status} ${res.statusText}`);
        return;
      }
      const json = await res.json();
      setCoverage(json.coverage);
      setIncidents(json.incidents);
    } catch (err) {
      console.error('[HuntressIntegration] Failed to fetch status:', err);
    }
  }, []);

  const fetchRecentIncidents = useCallback(async () => {
    try {
      const res = await fetchWithAuth('/huntress/incidents?limit=5');
      if (!res.ok) {
        console.error(`[HuntressIntegration] Incidents fetch failed: ${res.status} ${res.statusText}`);
        return;
      }
      const json = await res.json();
      setRecentIncidents(json.data ?? []);
    } catch (err) {
      console.error('[HuntressIntegration] Failed to fetch incidents:', err);
    }
  }, []);

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      await fetchIntegration();
      await Promise.all([fetchStatus(), fetchRecentIncidents()]);
      setLoading(false);
    };
    load();
  }, [fetchIntegration, fetchStatus, fetchRecentIncidents]);

  const handleSave = async () => {
    setSaveState({ status: 'saving' });
    try {
      const body: Record<string, unknown> = { name, isActive: true };
      if (apiKey.trim()) body.apiKey = apiKey;
      if (accountId.trim()) body.accountId = accountId;
      if (webhookSecret.trim()) body.webhookSecret = webhookSecret;

      const res = await fetchWithAuth('/huntress/integration', {
        method: 'POST',
        body: JSON.stringify(body)
      });
      const json = await res.json();
      if (!res.ok) {
        setSaveState({ status: 'error', message: json.error ?? 'Failed to save' });
        return;
      }
      setSaveState({ status: 'saved', message: json.syncWarning ?? 'Integration saved' });
      setApiKey('');
      setWebhookSecret('');
      await fetchIntegration();
      await Promise.all([fetchStatus(), fetchRecentIncidents()]);
    } catch (err) {
      setSaveState({ status: 'error', message: err instanceof Error ? err.message : 'Network error' });
    }
  };

  const handleSync = async () => {
    setSyncState({ status: 'syncing' });
    try {
      const res = await fetchWithAuth('/huntress/sync', {
        method: 'POST',
        body: JSON.stringify({})
      });
      if (!res.ok) {
        const json = await res.json();
        setSyncState({ status: 'error', message: json.error ?? 'Sync failed' });
        return;
      }
      setSyncState({ status: 'done', message: 'Sync triggered' });
      setTimeout(async () => {
        try {
          await fetchIntegration();
          await Promise.all([fetchStatus(), fetchRecentIncidents()]);
        } catch (refreshErr) {
          console.error('[HuntressIntegration] Failed to refresh after sync:', refreshErr);
        }
      }, 3000);
    } catch (err) {
      setSyncState({ status: 'error', message: err instanceof Error ? err.message : 'Network error' });
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const syncStatusBadge = () => {
    if (!integration) {
      return (
        <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs text-slate-600">
          <Unplug className="h-3.5 w-3.5" /> Not configured
        </span>
      );
    }
    if (integration.lastSyncStatus === 'success') {
      return (
        <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs text-emerald-700">
          <CheckCircle2 className="h-3.5 w-3.5" /> Connected
        </span>
      );
    }
    if (integration.lastSyncStatus === 'running') {
      return (
        <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-xs text-amber-700">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Syncing
        </span>
      );
    }
    if (integration.lastSyncStatus === 'error') {
      return (
        <span className="inline-flex items-center gap-1.5 rounded-full border border-red-200 bg-red-50 px-3 py-1 text-xs text-red-700">
          <AlertTriangle className="h-3.5 w-3.5" /> Error
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs text-slate-600">
        <Activity className="h-3.5 w-3.5" /> Pending
      </span>
    );
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Shield className="h-5 w-5" />
        </div>
        <div>
          <h1 className="text-2xl font-semibold">Huntress Integration</h1>
          <p className="text-sm text-muted-foreground">
            Connect Huntress managed EDR for agent sync, incident detection, and threat response.
          </p>
        </div>
      </div>

      {loadError && (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {loadError}
        </div>
      )}

      {/* Connection card */}
      <div className="rounded-xl border bg-card p-6 shadow-sm">
        <h2 className="text-lg font-semibold">Connection</h2>
        <p className="mb-4 text-sm text-muted-foreground">
          Configure your Huntress API credentials and webhook secret.
          {!integration && ' Saving requires MFA verification.'}
        </p>

        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <label className="mb-1 block text-sm font-medium">Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My Huntress Integration"
              className="h-10 w-full rounded-md border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-primary/30"
            />
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium">
              API Key
              {integration && <span className="ml-1 text-xs text-muted-foreground">(leave blank to keep existing)</span>}
            </label>
            <div className="relative">
              <input
                type={showApiKey ? 'text' : 'password'}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={integration ? '••••••••••••' : 'Enter API key'}
                className="h-10 w-full rounded-md border bg-background px-3 pr-10 text-sm outline-none focus:ring-2 focus:ring-primary/30"
              />
              <button
                type="button"
                onClick={() => setShowApiKey(!showApiKey)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                {showApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium">
              Account ID <span className="text-xs text-muted-foreground">(optional)</span>
            </label>
            <input
              type="text"
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
              placeholder="Huntress account ID"
              className="h-10 w-full rounded-md border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-primary/30"
            />
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium">
              Webhook Secret <span className="text-xs text-muted-foreground">(optional)</span>
              {integration?.hasWebhookSecret && <span className="ml-1 text-xs text-muted-foreground">(leave blank to keep existing)</span>}
            </label>
            <div className="relative">
              <input
                type={showWebhookSecret ? 'text' : 'password'}
                value={webhookSecret}
                onChange={(e) => setWebhookSecret(e.target.value)}
                placeholder={integration?.hasWebhookSecret ? '••••••••••••' : 'Enter webhook secret'}
                className="h-10 w-full rounded-md border bg-background px-3 pr-10 text-sm outline-none focus:ring-2 focus:ring-primary/30"
              />
              <button
                type="button"
                onClick={() => setShowWebhookSecret(!showWebhookSecret)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                {showWebhookSecret ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
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
            {integration ? 'Update' : 'Save & Connect'}
          </button>
          {saveState.status === 'saved' && (
            <span className="text-sm text-emerald-600">{saveState.message}</span>
          )}
          {saveState.status === 'error' && (
            <span className="text-sm text-red-600">{saveState.message}</span>
          )}
        </div>
      </div>

      {/* Sync Status + Coverage — only shown when integration exists */}
      {integration && (
        <div className="grid gap-6 lg:grid-cols-[1fr_1fr]">
          {/* Sync Status */}
          <div className="rounded-xl border bg-card p-6 shadow-sm">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">Sync Status</h2>
              {syncStatusBadge()}
            </div>
            <div className="mt-4 space-y-2 text-sm">
              <div className="flex justify-between text-muted-foreground">
                <span>Last sync</span>
                <span className="text-foreground">
                  {integration.lastSyncAt
                    ? new Date(integration.lastSyncAt).toLocaleString()
                    : 'Never'}
                </span>
              </div>
              {integration.lastSyncError && (
                <div className="mt-2 rounded-md border border-red-200 bg-red-50 p-3 text-xs text-red-700">
                  {integration.lastSyncError}
                </div>
              )}
            </div>
            <div className="mt-4">
              <button
                type="button"
                onClick={handleSync}
                disabled={syncState.status === 'syncing'}
                className="inline-flex h-9 items-center gap-2 rounded-md border px-3 text-sm font-medium hover:bg-muted disabled:opacity-50"
              >
                {syncState.status === 'syncing'
                  ? <Loader2 className="h-4 w-4 animate-spin" />
                  : <RefreshCw className="h-4 w-4" />}
                Sync Now
              </button>
              {syncState.message && (
                <span className={`ml-3 text-xs ${syncState.status === 'error' ? 'text-red-600' : 'text-emerald-600'}`}>
                  {syncState.message}
                </span>
              )}
            </div>
          </div>

          {/* Coverage + Incidents summary */}
          <div className="rounded-xl border bg-card p-6 shadow-sm">
            <h2 className="text-lg font-semibold">Coverage</h2>
            {coverage && (
              <div className="mt-4 grid grid-cols-2 gap-4">
                <div>
                  <p className="text-2xl font-bold">{coverage.totalAgents}</p>
                  <p className="text-xs text-muted-foreground">Total Agents</p>
                </div>
                <div>
                  <p className="text-2xl font-bold">{coverage.mappedAgents}</p>
                  <p className="text-xs text-muted-foreground">Mapped Devices</p>
                </div>
                <div>
                  <p className={`text-2xl font-bold ${coverage.unmappedAgents > 0 ? 'text-amber-600' : ''}`}>
                    {coverage.unmappedAgents}
                  </p>
                  <p className="text-xs text-muted-foreground">Unmapped</p>
                </div>
                <div>
                  <p className="text-2xl font-bold">{coverage.offlineAgents}</p>
                  <p className="text-xs text-muted-foreground">Offline</p>
                </div>
              </div>
            )}

            {incidents && (
              <div className="mt-4 space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Open incidents</span>
                  <span className={`font-semibold ${incidents.open > 0 ? 'text-red-600' : ''}`}>{incidents.open}</span>
                </div>
                {incidents.bySeverity.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {incidents.bySeverity.map((s) => (
                      <span key={s.severity} className="text-xs text-muted-foreground">
                        <SeverityBadge severity={s.severity} /> {s.count}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Recent Incidents */}
      {integration && recentIncidents.length > 0 && (
        <div className="rounded-xl border bg-card p-6 shadow-sm">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">Recent Incidents</h2>
            <a
              href="/security/"
              className="text-sm text-primary hover:underline"
            >
              View all
            </a>
          </div>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className="pb-2 font-medium">Severity</th>
                  <th className="pb-2 font-medium">Title</th>
                  <th className="pb-2 font-medium">Status</th>
                  <th className="pb-2 font-medium">Reported</th>
                </tr>
              </thead>
              <tbody>
                {recentIncidents.map((incident) => (
                  <tr key={incident.id} className="border-b last:border-0">
                    <td className="py-2">
                      <SeverityBadge severity={incident.severity} />
                    </td>
                    <td className="py-2 font-medium">{incident.title}</td>
                    <td className="py-2 capitalize text-muted-foreground">{incident.status}</td>
                    <td className="py-2 text-muted-foreground">
                      {new Date(incident.reportedAt).toLocaleDateString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
