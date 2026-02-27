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
  managementUrl: string;
  isActive: boolean;
  lastSyncAt: string | null;
  lastSyncStatus: string | null;
  lastSyncError: string | null;
  createdAt: string;
  updatedAt: string;
};

type StatusSummary = {
  totalAgents: number;
  mappedDevices: number;
  infectedAgents: number;
  activeThreats: number;
  highOrCriticalThreats: number;
  pendingActions: number;
  reportedThreatCount: number;
};

type SiteRow = {
  siteName: string;
  agentCount: number;
  mappedOrgId: string | null;
  mappedOrgName: string | null;
};

type OrgOption = {
  id: string;
  name: string;
};

type SaveState = {
  status: 'idle' | 'saving' | 'saved' | 'error';
  message?: string;
};

type SyncState = {
  status: 'idle' | 'syncing' | 'done' | 'error';
  message?: string;
};

export default function SecurityIntegration() {
  const [name, setName] = useState('');
  const [managementUrl, setManagementUrl] = useState('');
  const [apiToken, setApiToken] = useState('');
  const [showToken, setShowToken] = useState(false);

  const [integration, setIntegration] = useState<Integration | null>(null);
  const [summary, setSummary] = useState<StatusSummary | null>(null);
  const [sites, setSites] = useState<SiteRow[]>([]);
  const [integrationId, setIntegrationId] = useState<string | null>(null);
  const [orgs, setOrgs] = useState<OrgOption[]>([]);

  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>({ status: 'idle' });
  const [syncState, setSyncState] = useState<SyncState>({ status: 'idle' });
  const [siteMapSaving, setSiteMapSaving] = useState<Record<string, boolean>>({});
  const [siteMapError, setSiteMapError] = useState<string | null>(null);

  const fetchIntegration = useCallback(async () => {
    try {
      const res = await fetchWithAuth('/s1/integration');
      if (!res.ok) return;
      const json = await res.json();
      const data = json.data as Integration | null;
      setIntegration(data);
      if (data) {
        setName(data.name);
        setManagementUrl(data.managementUrl);
        setApiToken('');
      }
    } catch (err) {
      setLoadError(`Failed to load integration: ${err instanceof Error ? err.message : 'Network error'}`);
    }
  }, []);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetchWithAuth('/s1/status');
      if (!res.ok) return;
      const json = await res.json();
      setSummary(json.summary as StatusSummary);
    } catch (err) {
      console.error('[SecurityIntegration] Failed to fetch status:', err);
    }
  }, []);

  const fetchSites = useCallback(async () => {
    try {
      const res = await fetchWithAuth('/s1/sites');
      if (!res.ok) return;
      const json = await res.json();
      setSites(json.data as SiteRow[]);
      if (json.integrationId) setIntegrationId(json.integrationId);
    } catch (err) {
      console.error('[SecurityIntegration] Failed to fetch sites:', err);
    }
  }, []);

  const fetchOrgs = useCallback(async () => {
    try {
      const res = await fetchWithAuth('/orgs/organizations');
      if (!res.ok) return;
      const json = await res.json();
      const list = (json.data ?? json) as Array<{ id: string; name: string }>;
      setOrgs(list.map((o) => ({ id: o.id, name: o.name })));
    } catch (err) {
      console.error('[SecurityIntegration] Failed to fetch organizations:', err);
    }
  }, []);

  useEffect(() => {
    const load = async () => {
      setIsLoading(true);
      await fetchIntegration();
      await Promise.all([fetchStatus(), fetchSites(), fetchOrgs()]);
      setIsLoading(false);
    };
    load();
  }, [fetchIntegration, fetchStatus, fetchSites, fetchOrgs]);

  const handleSave = async () => {
    setSaveState({ status: 'saving' });
    try {
      const payload: Record<string, unknown> = {
        name,
        managementUrl,
        isActive: true
      };
      if (apiToken.trim().length > 0) {
        payload.apiToken = apiToken;
      }
      const res = await fetchWithAuth('/s1/integration', {
        method: 'POST',
        body: JSON.stringify(payload)
      });
      const json = await res.json();
      if (!res.ok) {
        setSaveState({ status: 'error', message: json.error ?? 'Failed to save' });
        return;
      }
      setSaveState({ status: 'saved', message: json.warning ?? 'Integration saved' });
      setApiToken('');
      await fetchIntegration();
      await Promise.all([fetchStatus(), fetchSites()]);
    } catch (err) {
      setSaveState({ status: 'error', message: err instanceof Error ? err.message : 'Network error' });
    }
  };

  const handleSync = async () => {
    setSyncState({ status: 'syncing' });
    try {
      const res = await fetchWithAuth('/s1/sync', {
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
        await fetchIntegration();
        await Promise.all([fetchStatus(), fetchSites()]);
      }, 3000);
    } catch (err) {
      setSyncState({ status: 'error', message: err instanceof Error ? err.message : 'Network error' });
    }
  };

  const handleSiteMap = async (siteName: string, orgId: string | null) => {
    if (!integrationId) return;
    setSiteMapSaving((prev) => ({ ...prev, [siteName]: true }));
    setSiteMapError(null);
    try {
      const res = await fetchWithAuth('/s1/sites/map', {
        method: 'POST',
        body: JSON.stringify({ integrationId, siteName, orgId })
      });
      if (res.ok) {
        await fetchSites();
      } else {
        const json = await res.json().catch(() => ({}));
        setSiteMapError(`Failed to map "${siteName}": ${json.error ?? 'Unknown error'}`);
      }
    } catch (err) {
      setSiteMapError(`Failed to map "${siteName}": ${err instanceof Error ? err.message : 'Network error'}`);
    } finally {
      setSiteMapSaving((prev) => ({ ...prev, [siteName]: false }));
    }
  };

  if (isLoading) {
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
    if (integration.lastSyncStatus === 'success' || integration.lastSyncStatus === 'partial') {
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

  const canSave = name.trim().length > 0 && managementUrl.trim().length > 0 && (apiToken.trim().length > 0 || !!integration);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Shield className="h-5 w-5" />
        </div>
        <div>
          <h1 className="text-2xl font-semibold">SentinelOne Integration</h1>
          <p className="text-sm text-muted-foreground">Connect your SentinelOne tenant for endpoint detection and response.</p>
        </div>
      </div>

      {loadError && (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {loadError}
        </div>
      )}

      {/* Connection Setup */}
      <div className="rounded-xl border bg-card p-6 shadow-sm">
        <h2 className="text-lg font-semibold">Connection</h2>
        <p className="mb-4 text-sm text-muted-foreground">
          Enter your SentinelOne management console URL and API token.
          {!integration && ' Saving requires MFA verification.'}
        </p>

        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <label className="mb-1 block text-sm font-medium">Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My S1 Tenant"
              className="h-10 w-full rounded-md border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-primary/30"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium">Management URL</label>
            <input
              type="url"
              value={managementUrl}
              onChange={(e) => setManagementUrl(e.target.value)}
              placeholder="https://your-tenant.sentinelone.net"
              className="h-10 w-full rounded-md border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-primary/30"
            />
          </div>
          <div className="md:col-span-2">
            <label className="mb-1 block text-sm font-medium">
              API Token
              {integration && <span className="ml-1 text-xs text-muted-foreground">(leave blank to keep existing)</span>}
            </label>
            <div className="relative">
              <input
                type={showToken ? 'text' : 'password'}
                value={apiToken}
                onChange={(e) => setApiToken(e.target.value)}
                placeholder={integration ? '••••••••••••••••' : 'Paste your API token'}
                className="h-10 w-full rounded-md border bg-background px-3 pr-10 text-sm outline-none focus:ring-2 focus:ring-primary/30"
              />
              <button
                type="button"
                onClick={() => setShowToken(!showToken)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                {showToken ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
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

      {/* Status + Summary (only when integration exists) */}
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

          {/* Coverage Summary */}
          {summary && (
            <div className="rounded-xl border bg-card p-6 shadow-sm">
              <h2 className="text-lg font-semibold">Coverage</h2>
              <div className="mt-4 grid grid-cols-2 gap-4">
                <div>
                  <p className="text-2xl font-bold">{summary.totalAgents}</p>
                  <p className="text-xs text-muted-foreground">S1 Agents</p>
                </div>
                <div>
                  <p className="text-2xl font-bold">{summary.mappedDevices}</p>
                  <p className="text-xs text-muted-foreground">Mapped Devices</p>
                </div>
                <div>
                  <p className={`text-2xl font-bold ${summary.infectedAgents > 0 ? 'text-red-600' : ''}`}>
                    {summary.infectedAgents}
                  </p>
                  <p className="text-xs text-muted-foreground">Infected</p>
                </div>
                <div>
                  <p className={`text-2xl font-bold ${summary.activeThreats > 0 ? 'text-red-600' : ''}`}>
                    {summary.activeThreats}
                  </p>
                  <p className="text-xs text-muted-foreground">Active Threats</p>
                </div>
                <div>
                  <p className="text-2xl font-bold">{summary.pendingActions}</p>
                  <p className="text-xs text-muted-foreground">Pending Actions</p>
                </div>
                <div>
                  <p className={`text-2xl font-bold ${summary.highOrCriticalThreats > 0 ? 'text-amber-600' : ''}`}>
                    {summary.highOrCriticalThreats}
                  </p>
                  <p className="text-xs text-muted-foreground">High/Critical</p>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Site Mapping (only when sites exist) */}
      {integration && sites.length > 0 && (
        <div className="rounded-xl border bg-card p-6 shadow-sm">
          <h2 className="text-lg font-semibold">Site-to-Organization Mapping</h2>
          <p className="mb-4 text-sm text-muted-foreground">
            Map each SentinelOne site to a Breeze organization. Unmapped sites will inherit the integration's default org.
          </p>

          {siteMapError && (
            <div className="mb-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
              {siteMapError}
            </div>
          )}

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="pb-2 pr-4 font-medium">S1 Site</th>
                  <th className="pb-2 pr-4 font-medium">Agents</th>
                  <th className="pb-2 pr-4 font-medium">Breeze Organization</th>
                  <th className="pb-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {sites.map((site) => (
                  <tr key={site.siteName} className="border-b last:border-0">
                    <td className="py-3 pr-4 font-medium">{site.siteName}</td>
                    <td className="py-3 pr-4 text-muted-foreground">{site.agentCount}</td>
                    <td className="py-3 pr-4">
                      <select
                        value={site.mappedOrgId ?? ''}
                        onChange={(e) => handleSiteMap(site.siteName, e.target.value || null)}
                        disabled={siteMapSaving[site.siteName]}
                        className="h-9 w-full max-w-xs rounded-md border bg-background px-2 text-sm outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-50"
                      >
                        <option value="">— Select organization —</option>
                        {orgs.map((org) => (
                          <option key={org.id} value={org.id}>{org.name}</option>
                        ))}
                      </select>
                    </td>
                    <td className="py-3">
                      {siteMapSaving[site.siteName] ? (
                        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                      ) : site.mappedOrgId ? (
                        <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                      ) : (
                        <AlertTriangle className="h-4 w-4 text-amber-500" />
                      )}
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
