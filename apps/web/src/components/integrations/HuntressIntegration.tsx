import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Eye,
  EyeOff,
  Loader2,
  RefreshCw,
  Save,
  Shield,
  XCircle
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

const syncStatusStyles: Record<string, { label: string; className: string; icon: typeof CheckCircle2 }> = {
  connected: {
    label: 'Connected',
    className: 'border-emerald-200 bg-emerald-50 text-emerald-700',
    icon: CheckCircle2
  },
  syncing: {
    label: 'Syncing',
    className: 'border-blue-200 bg-blue-50 text-blue-700',
    icon: Loader2
  },
  error: {
    label: 'Error',
    className: 'border-rose-200 bg-rose-50 text-rose-700',
    icon: XCircle
  },
  pending: {
    label: 'Pending',
    className: 'border-amber-200 bg-amber-50 text-amber-700',
    icon: Clock
  },
  not_configured: {
    label: 'Not configured',
    className: 'border-slate-200 bg-slate-50 text-slate-600',
    icon: Clock
  }
};

const severityStyles: Record<string, string> = {
  critical: 'border-rose-200 bg-rose-50 text-rose-700',
  high: 'border-orange-200 bg-orange-50 text-orange-700',
  medium: 'border-amber-200 bg-amber-50 text-amber-700',
  low: 'border-slate-200 bg-slate-50 text-slate-600'
};

function SyncStatusBadge({ status }: { status: string }) {
  const config = syncStatusStyles[status] ?? syncStatusStyles.not_configured;
  const Icon = config.icon;
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs ${config.className}`}>
      <Icon className={`h-3.5 w-3.5 ${status === 'syncing' ? 'animate-spin' : ''}`} />
      {config.label}
    </span>
  );
}

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
  const [integration, setIntegration] = useState<Integration | null>(null);
  const [coverage, setCoverage] = useState<StatusSummary | null>(null);
  const [incidents, setIncidents] = useState<IncidentSummary | null>(null);
  const [recentIncidents, setRecentIncidents] = useState<Incident[]>([]);

  const [name, setName] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [accountId, setAccountId] = useState('');
  const [webhookSecret, setWebhookSecret] = useState('');
  const [isActive, setIsActive] = useState(true);

  const [showApiKey, setShowApiKey] = useState(false);
  const [showWebhookSecret, setShowWebhookSecret] = useState(false);

  const [saveState, setSaveState] = useState<SaveState>({ status: 'idle' });
  const [syncState, setSyncState] = useState<SyncState>({ status: 'idle' });

  const canSave = name.trim().length > 0 && (apiKey.trim().length > 0 || !!integration);

  const fetchIntegration = useCallback(async () => {
    try {
      const response = await fetchWithAuth('/huntress/integration');
      if (!response.ok) return;
      const data = await response.json();
      if (data.data) {
        setIntegration(data.data);
        setName(data.data.name);
        setAccountId(data.data.accountId ?? '');
        setIsActive(data.data.isActive);
      }
    } catch {
      // Integration not configured yet
    }
  }, []);

  const fetchStatus = useCallback(async () => {
    try {
      const response = await fetchWithAuth('/huntress/status');
      if (!response.ok) return;
      const data = await response.json();
      setCoverage(data.coverage);
      setIncidents(data.incidents);
    } catch {
      // Status unavailable
    }
  }, []);

  const fetchRecentIncidents = useCallback(async () => {
    try {
      const response = await fetchWithAuth('/huntress/incidents?limit=5');
      if (!response.ok) return;
      const data = await response.json();
      setRecentIncidents(data.data ?? []);
    } catch {
      // Incidents unavailable
    }
  }, []);

  useEffect(() => {
    async function load() {
      setLoading(true);
      await fetchIntegration();
      await Promise.all([fetchStatus(), fetchRecentIncidents()]);
      setLoading(false);
    }
    load();
  }, [fetchIntegration, fetchStatus, fetchRecentIncidents]);

  const handleSave = async () => {
    setSaveState({ status: 'saving' });
    try {
      const body: Record<string, unknown> = { name, isActive };
      if (apiKey.trim()) body.apiKey = apiKey;
      if (accountId.trim()) body.accountId = accountId;
      if (webhookSecret.trim()) body.webhookSecret = webhookSecret;

      const response = await fetchWithAuth('/huntress/integration', {
        method: 'POST',
        body: JSON.stringify(body)
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || 'Failed to save integration');
      }

      const result = await response.json();
      setIntegration(result);
      setApiKey('');
      setWebhookSecret('');
      setSaveState({ status: 'saved', message: 'Integration saved successfully.' });

      // Refresh status after save
      await Promise.all([fetchStatus(), fetchRecentIncidents()]);
    } catch (err) {
      setSaveState({
        status: 'error',
        message: err instanceof Error ? err.message : 'Failed to save integration'
      });
    }
  };

  const handleSync = async () => {
    setSyncState({ status: 'syncing' });
    try {
      const response = await fetchWithAuth('/huntress/sync', { method: 'POST' });
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || 'Failed to trigger sync');
      }
      setSyncState({ status: 'done', message: 'Sync queued successfully.' });

      // Refresh after a short delay to let the job start
      setTimeout(async () => {
        await Promise.all([fetchIntegration(), fetchStatus(), fetchRecentIncidents()]);
      }, 2000);
    } catch (err) {
      setSyncState({
        status: 'error',
        message: err instanceof Error ? err.message : 'Failed to trigger sync'
      });
    }
  };

  const getSyncStatusKey = (): string => {
    if (!integration) return 'not_configured';
    if (syncState.status === 'syncing') return 'syncing';
    if (integration.lastSyncStatus === 'error') return 'error';
    if (integration.lastSyncStatus === 'success') return 'connected';
    return 'pending';
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start gap-4">
        <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <Shield className="h-6 w-6" />
        </div>
        <div>
          <h1 className="text-2xl font-semibold">Huntress Integration</h1>
          <p className="text-sm text-muted-foreground">
            Connect Huntress managed EDR for agent sync, incident detection, and threat response.
          </p>
        </div>
      </div>

      {/* Save / Sync feedback banners */}
      {saveState.status === 'saved' && saveState.message && (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          {saveState.message}
        </div>
      )}
      {saveState.status === 'error' && saveState.message && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {saveState.message}
        </div>
      )}
      {syncState.status === 'done' && syncState.message && (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          {syncState.message}
        </div>
      )}
      {syncState.status === 'error' && syncState.message && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {syncState.message}
        </div>
      )}

      {/* Connection card */}
      <div className="rounded-xl border bg-card p-6 shadow-sm">
        <h2 className="text-lg font-semibold">Connection</h2>
        <p className="mb-4 text-sm text-muted-foreground">
          Configure your Huntress API credentials and webhook secret.
        </p>

        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <label className="text-sm font-medium">Name</label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="My Huntress Integration"
              className="h-10 w-full rounded-md border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-primary/30"
            />
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">API Key</label>
            <div className="relative">
              <input
                type={showApiKey ? 'text' : 'password'}
                value={apiKey}
                onChange={e => setApiKey(e.target.value)}
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

          <div className="space-y-2">
            <label className="text-sm font-medium">
              Account ID <span className="text-xs text-muted-foreground">(optional)</span>
            </label>
            <input
              type="text"
              value={accountId}
              onChange={e => setAccountId(e.target.value)}
              placeholder="Huntress account ID"
              className="h-10 w-full rounded-md border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-primary/30"
            />
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">
              Webhook Secret <span className="text-xs text-muted-foreground">(optional)</span>
            </label>
            <div className="relative">
              <input
                type={showWebhookSecret ? 'text' : 'password'}
                value={webhookSecret}
                onChange={e => setWebhookSecret(e.target.value)}
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

        <div className="mt-4 flex items-center gap-4">
          <label className="inline-flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={isActive}
              onChange={e => setIsActive(e.target.checked)}
              className="h-4 w-4 rounded border-muted text-primary focus:ring-primary"
            />
            Active
          </label>

          <button
            type="button"
            onClick={handleSave}
            disabled={!canSave || saveState.status === 'saving'}
            className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {saveState.status === 'saving' ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Save className="h-4 w-4" />
            )}
            {saveState.status === 'saving' ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>

      {/* Sync Status + Coverage — only shown when integration exists */}
      {integration && (
        <div className="grid gap-6 lg:grid-cols-[1fr_1fr]">
          {/* Sync Status */}
          <div className="rounded-xl border bg-card p-6 shadow-sm">
            <h2 className="text-lg font-semibold">Sync Status</h2>
            <div className="mt-3 space-y-3">
              <div className="flex items-center gap-3">
                <SyncStatusBadge status={getSyncStatusKey()} />
              </div>

              {integration.lastSyncAt && (
                <p className="text-sm text-muted-foreground">
                  Last sync: {new Date(integration.lastSyncAt).toLocaleString()}
                </p>
              )}

              {integration.lastSyncError && (
                <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  {integration.lastSyncError}
                </div>
              )}

              <button
                type="button"
                onClick={handleSync}
                disabled={syncState.status === 'syncing'}
                className="inline-flex items-center gap-2 rounded-md border px-4 py-2 text-sm font-medium text-foreground transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
              >
                {syncState.status === 'syncing' ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="h-4 w-4" />
                )}
                {syncState.status === 'syncing' ? 'Syncing...' : 'Sync Now'}
              </button>
            </div>
          </div>

          {/* Coverage + Incidents summary */}
          <div className="rounded-xl border bg-card p-6 shadow-sm">
            <h2 className="text-lg font-semibold">Coverage</h2>
            {coverage && (
              <div className="mt-3 grid grid-cols-2 gap-3">
                <div className="rounded-lg border bg-background p-3">
                  <p className="text-2xl font-bold">{coverage.totalAgents}</p>
                  <p className="text-xs text-muted-foreground">Total Agents</p>
                </div>
                <div className="rounded-lg border bg-background p-3">
                  <p className="text-2xl font-bold text-emerald-600">{coverage.mappedAgents}</p>
                  <p className="text-xs text-muted-foreground">Mapped Devices</p>
                </div>
                <div className="rounded-lg border bg-background p-3">
                  <p className="text-2xl font-bold text-amber-600">{coverage.unmappedAgents}</p>
                  <p className="text-xs text-muted-foreground">Unmapped</p>
                </div>
                <div className="rounded-lg border bg-background p-3">
                  <p className="text-2xl font-bold text-slate-500">{coverage.offlineAgents}</p>
                  <p className="text-xs text-muted-foreground">Offline</p>
                </div>
              </div>
            )}

            {incidents && (
              <div className="mt-4 space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Open incidents</span>
                  <span className="font-semibold">{incidents.open}</span>
                </div>
                {incidents.bySeverity.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {incidents.bySeverity.map(s => (
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
                {recentIncidents.map(incident => (
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
