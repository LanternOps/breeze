import { useCallback, useEffect, useMemo, useState } from 'react';
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
import { type Organization, useOrgStore } from '../../stores/orgStore';

type Integration = {
  id: string;
  partnerId: string;
  name: string;
  accountId: string | null;
  apiBaseUrl: string;
  isActive: boolean;
  lastSyncAt: string | null;
  lastSyncStatus: string | null;
  lastSyncError: string | null;
  hasWebhookSecret: boolean;
};

type StatusSummary = {
  totalAgents: number;
  mappedAgents: number;
  unmappedAgents: number;
  offlineAgents: number;
};

type IncidentSummary = {
  open: number;
  bySeverity: { severity: string | null; count: number }[];
  byStatus: { status: string | null; count: number }[];
};

type Incident = {
  id: string;
  severity: string | null;
  title: string;
  status: string;
  reportedAt: string | null;
};

type HuntressOrgMapping = {
  huntressOrgId: string;
  huntressOrgName: string | null;
  huntressOrgKey: string | null;
  huntressAccountId: string | null;
  agentsCount: number;
  incidentsCount: number;
  mappedOrgId: string | null;
  mappedOrgName: string | null;
  lastSeenAt: string | null;
};

type SaveState = { status: 'idle' | 'saving' | 'saved' | 'error'; message?: string };
type SyncState = { status: 'idle' | 'syncing' | 'done' | 'error'; message?: string };

const LIVE_STATUS_ERROR =
  'Live Huntress status could not be fully loaded. Coverage and incident data below may be incomplete or out of date.';

const severityStyles: Record<string, string> = {
  critical: 'border-rose-200 bg-rose-50 text-rose-700',
  high: 'border-orange-200 bg-orange-50 text-orange-700',
  medium: 'border-amber-200 bg-amber-50 text-amber-700',
  low: 'border-slate-200 bg-slate-50 text-slate-600'
};

function SeverityBadge({ severity }: { severity: string | null }) {
  const label = severity || 'unknown';
  const style = severityStyles[label.toLowerCase()] ?? severityStyles.low;
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs capitalize ${style}`}>
      {label}
    </span>
  );
}

function readError(json: unknown, fallback: string): string {
  if (json && typeof json === 'object' && 'error' in json) {
    return String((json as { error?: unknown }).error ?? fallback);
  }
  return fallback;
}

function syncStatusBadge(integration: Integration | null) {
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
}

export default function HuntressIntegration() {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [integration, setIntegration] = useState<Integration | null>(null);
  const [mappedForOrg, setMappedForOrg] = useState(true);
  const [coverage, setCoverage] = useState<StatusSummary | null>(null);
  const [incidents, setIncidents] = useState<IncidentSummary | null>(null);
  const [recentIncidents, setRecentIncidents] = useState<Incident[]>([]);
  const [huntressOrgs, setHuntressOrgs] = useState<HuntressOrgMapping[]>([]);
  const [orgOptions, setOrgOptions] = useState<Organization[]>([]);

  const [name, setName] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [apiSecret, setApiSecret] = useState('');
  const [accountId, setAccountId] = useState('');
  const [webhookSecret, setWebhookSecret] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);
  const [showApiSecret, setShowApiSecret] = useState(false);
  const [showWebhookSecret, setShowWebhookSecret] = useState(false);

  const [saveState, setSaveState] = useState<SaveState>({ status: 'idle' });
  const [syncState, setSyncState] = useState<SyncState>({ status: 'idle' });
  const [mappingSaving, setMappingSaving] = useState<Record<string, boolean>>({});
  const [mappingError, setMappingError] = useState<string | null>(null);

  const currentOrgId = useOrgStore((s) => s.currentOrgId);
  const orgScope = useOrgStore((s) => s.orgScope);
  const isPartnerView = orgScope === 'all';

  const hasCredentialInput = apiKey.trim().length > 0 || apiSecret.trim().length > 0;
  const hasCompleteCredential = apiKey.trim().length > 0 && apiSecret.trim().length > 0;
  const credentialPairError = hasCredentialInput && !hasCompleteCredential
    ? 'Enter both the API Key and API Secret from Huntress, or leave both blank to keep the existing credential.'
    : null;
  const canSave = name.trim().length > 0 && (integration ? !hasCredentialInput || hasCompleteCredential : hasCompleteCredential);
  const unmappedCount = useMemo(() => huntressOrgs.filter((row) => !row.mappedOrgId).length, [huntressOrgs]);

  const fetchIntegration = useCallback(async () => {
    const res = await fetchWithAuth('/huntress/integration');
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(readError(json, `Failed to load integration (${res.status})`));
    const data = (json as { data?: Integration | null; mapped?: boolean }).data ?? null;
    setMappedForOrg((json as { mapped?: boolean }).mapped !== false);
    setIntegration(data);
    if (data) {
      setName(data.name);
      setAccountId(data.accountId ?? '');
      setApiKey('');
      setApiSecret('');
    }
  }, []);

  const fetchStatus = useCallback(async () => {
    const res = await fetchWithAuth('/huntress/status');
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(readError(json, LIVE_STATUS_ERROR));
    setMappedForOrg((json as { mapped?: boolean }).mapped !== false);
    setCoverage((json as { coverage?: StatusSummary }).coverage ?? null);
    setIncidents((json as { incidents?: IncidentSummary }).incidents ?? null);
  }, []);

  const fetchRecentIncidents = useCallback(async () => {
    const res = await fetchWithAuth('/huntress/incidents?limit=5');
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(readError(json, LIVE_STATUS_ERROR));
    setRecentIncidents((json as { data?: Incident[] }).data ?? []);
  }, []);

  const fetchMappings = useCallback(async () => {
    if (!isPartnerView) return;
    const [mappingRes, orgRes] = await Promise.all([
      fetchWithAuth('/huntress/organizations'),
      fetchWithAuth('/orgs/organizations')
    ]);
    const mappingJson = await mappingRes.json().catch(() => ({}));
    if (!mappingRes.ok) throw new Error(readError(mappingJson, `Failed to load Huntress organizations (${mappingRes.status})`));
    const orgJson = await orgRes.json().catch(() => ({}));
    if (!orgRes.ok) throw new Error(readError(orgJson, `Failed to load Breeze organizations (${orgRes.status})`));
    setHuntressOrgs((mappingJson as { data?: HuntressOrgMapping[] }).data ?? []);
    setOrgOptions(
      Array.isArray((orgJson as { data?: unknown }).data)
        ? (orgJson as { data: Organization[] }).data
        : []
    );
  }, [isPartnerView]);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    setStatusError(null);
    try {
      await fetchIntegration();
      await Promise.all([
        fetchStatus().catch((err) => {
          console.error('[HuntressIntegration] Failed to load status:', err);
          setStatusError(LIVE_STATUS_ERROR);
        }),
        fetchRecentIncidents().catch((err) => {
          console.error('[HuntressIntegration] Failed to load incidents:', err);
          setStatusError(LIVE_STATUS_ERROR);
        }),
        fetchMappings(),
      ]);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to load Huntress integration');
    } finally {
      setLoading(false);
    }
  }, [fetchIntegration, fetchMappings, fetchRecentIncidents, fetchStatus]);

  useEffect(() => {
    void load();
  }, [load, currentOrgId, isPartnerView]);

  const handleSave = async () => {
    if (!isPartnerView) return;
    setSaveState({ status: 'saving' });
    try {
      if (credentialPairError) {
        setSaveState({ status: 'error', message: credentialPairError });
        return;
      }
      const body: Record<string, unknown> = { name, isActive: true };
      if (hasCompleteCredential) body.apiKey = `${apiKey.trim()}:${apiSecret.trim()}`;
      if (accountId.trim()) body.accountId = accountId;
      if (webhookSecret.trim()) body.webhookSecret = webhookSecret;

      const res = await fetchWithAuth('/huntress/integration', { method: 'POST', body: JSON.stringify(body) });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setSaveState({ status: 'error', message: readError(json, `Failed to save (${res.status})`) });
        return;
      }
      setSaveState({ status: 'saved', message: (json as { syncWarning?: string }).syncWarning ?? 'Integration saved' });
      setApiKey('');
      setApiSecret('');
      setWebhookSecret('');
      await load();
    } catch (err) {
      setSaveState({ status: 'error', message: err instanceof Error ? err.message : 'Network error' });
    }
  };

  const handleSync = async () => {
    if (!isPartnerView) return;
    setSyncState({ status: 'syncing' });
    try {
      const res = await fetchWithAuth('/huntress/sync', { method: 'POST', body: JSON.stringify({}) });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setSyncState({ status: 'error', message: readError(json, `Sync failed (${res.status})`) });
        return;
      }
      setSyncState({ status: 'done', message: 'Sync triggered' });
      setTimeout(() => {
        void load();
      }, 3000);
    } catch (err) {
      setSyncState({ status: 'error', message: err instanceof Error ? err.message : 'Network error' });
    }
  };

  const handleMap = async (huntressOrgId: string, orgId: string | null) => {
    if (!integration) return;
    setMappingSaving((prev) => ({ ...prev, [huntressOrgId]: true }));
    setMappingError(null);
    try {
      const res = await fetchWithAuth('/huntress/organizations/map', {
        method: 'POST',
        body: JSON.stringify({ integrationId: integration.id, huntressOrgId, orgId })
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMappingError(readError(json, `Failed to map Huntress organization (${res.status})`));
        return;
      }
      await fetchMappings();
      await Promise.all([fetchStatus(), fetchRecentIncidents()]).catch(() => setStatusError(LIVE_STATUS_ERROR));
    } catch (err) {
      setMappingError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setMappingSaving((prev) => ({ ...prev, [huntressOrgId]: false }));
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
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Shield className="h-5 w-5" />
        </div>
        <div>
          <h1 className="text-2xl font-semibold">Huntress Integration</h1>
          <p className="text-sm text-muted-foreground">
            Connect one partner-level Huntress account and map Huntress organizations to Breeze organizations.
          </p>
        </div>
      </div>

      {loadError && (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">{loadError}</div>
      )}
      {statusError && (
        <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-700">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{statusError}</span>
        </div>
      )}
      {!isPartnerView && !mappedForOrg && (
        <div className="rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
          This Breeze organization is not mapped to a Huntress organization yet. Switch to All orgs as a partner admin to map it.
        </div>
      )}

      {isPartnerView && (
        <div className="rounded-xl border bg-card p-6 shadow-sm">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold">Partner connection</h2>
              <p className="text-sm text-muted-foreground">
                One API Key and Secret covers every Huntress organization under this partner account.
              </p>
            </div>
            {syncStatusBadge(integration)}
          </div>

          <div className="mt-5 grid gap-4 md:grid-cols-2">
            <div>
              <label className="mb-1 block text-sm font-medium">Name</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Partner Huntress"
                className="h-10 w-full rounded-md border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-primary/30"
              />
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
            <SecretInput
              label="API Key"
              value={apiKey}
              onChange={setApiKey}
              visible={showApiKey}
              onToggle={() => setShowApiKey((value) => !value)}
              placeholder={integration ? 'hk_************' : 'hk_...'}
            />
            <SecretInput
              label="API Secret"
              hint={integration ? 'leave key and secret blank to keep existing' : undefined}
              value={apiSecret}
              onChange={setApiSecret}
              visible={showApiSecret}
              onToggle={() => setShowApiSecret((value) => !value)}
              placeholder={integration ? 'hs_************' : 'hs_...'}
            />
            <div className="md:col-span-2">
              <p className="text-xs text-muted-foreground">
                Copy the API Key and API Secret from Huntress. Breeze formats the Basic auth credential automatically.
              </p>
              {credentialPairError && <p className="mt-1 text-xs text-red-600">{credentialPairError}</p>}
            </div>
            <SecretInput
              label="Webhook Secret"
              hint={integration?.hasWebhookSecret ? 'leave blank to keep existing' : 'optional'}
              value={webhookSecret}
              onChange={setWebhookSecret}
              visible={showWebhookSecret}
              onToggle={() => setShowWebhookSecret((value) => !value)}
              placeholder={integration?.hasWebhookSecret ? '************' : 'Enter webhook secret'}
            />
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={handleSave}
              disabled={!canSave || saveState.status === 'saving'}
              className="inline-flex h-10 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
            >
              {saveState.status === 'saving' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              {integration ? 'Update' : 'Save & Connect'}
            </button>
            {integration && (
              <button
                type="button"
                onClick={handleSync}
                disabled={syncState.status === 'syncing'}
                className="inline-flex h-10 items-center gap-2 rounded-md border px-3 text-sm font-medium hover:bg-muted disabled:opacity-50"
              >
                {syncState.status === 'syncing' ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                Sync Now
              </button>
            )}
            {saveState.message && (
              <span className={`text-sm ${saveState.status === 'error' ? 'text-red-600' : 'text-emerald-600'}`}>{saveState.message}</span>
            )}
            {syncState.message && (
              <span className={`text-sm ${syncState.status === 'error' ? 'text-red-600' : 'text-emerald-600'}`}>{syncState.message}</span>
            )}
          </div>
        </div>
      )}

      {integration && (
        <div className="grid gap-6 lg:grid-cols-[1fr_1fr]">
          <div className="rounded-xl border bg-card p-6 shadow-sm">
            <div className="flex items-center justify-between gap-4">
              <h2 className="text-lg font-semibold">Sync status</h2>
              {syncStatusBadge(integration)}
            </div>
            <div className="mt-4 space-y-2 text-sm">
              <div className="flex justify-between text-muted-foreground">
                <span>Last sync</span>
                <span className="text-foreground">{integration.lastSyncAt ? new Date(integration.lastSyncAt).toLocaleString() : 'Never'}</span>
              </div>
              {integration.lastSyncError && (
                <div className="rounded-md border border-red-200 bg-red-50 p-3 text-xs text-red-700">{integration.lastSyncError}</div>
              )}
            </div>
          </div>

          <div className="rounded-xl border bg-card p-6 shadow-sm">
            <h2 className="text-lg font-semibold">Coverage</h2>
            {coverage && (
              <div className="mt-4 grid grid-cols-2 gap-4">
                <Metric label="Total agents" value={coverage.totalAgents} />
                <Metric label="Mapped devices" value={coverage.mappedAgents} />
                <Metric label="Unmapped devices" value={coverage.unmappedAgents} warn={coverage.unmappedAgents > 0} />
                <Metric label="Offline agents" value={coverage.offlineAgents} />
              </div>
            )}
            {incidents && (
              <div className="mt-4 space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Open incidents</span>
                  <span className={`font-semibold ${incidents.open > 0 ? 'text-red-600' : ''}`}>{incidents.open}</span>
                </div>
                <div className="flex flex-wrap gap-2">
                  {incidents.bySeverity.map((row) => (
                    <span key={row.severity ?? 'unknown'} className="text-xs text-muted-foreground">
                      <SeverityBadge severity={row.severity} /> {row.count}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {isPartnerView && integration && (
        <div className="rounded-xl border bg-card p-6 shadow-sm">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold">Organization mapping</h2>
              <p className="text-sm text-muted-foreground">
                Unmapped Huntress organizations stay quarantined until assigned to a Breeze organization.
              </p>
            </div>
            {unmappedCount > 0 && (
              <span className="rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-xs text-amber-700">
                {unmappedCount} unmapped
              </span>
            )}
          </div>
          {mappingError && <div className="mt-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">{mappingError}</div>}
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm">
              <thead>
                <tr className="border-b text-left text-xs font-semibold uppercase text-muted-foreground">
                  <th className="pb-2 pr-4">Huntress org</th>
                  <th className="pb-2 pr-4">Agents</th>
                  <th className="pb-2 pr-4">Incidents</th>
                  <th className="pb-2 pr-4">Breeze organization</th>
                  <th className="pb-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {huntressOrgs.map((row) => (
                  <tr key={row.huntressOrgId} className="border-b last:border-0">
                    <td className="py-3 pr-4">
                      <div className="font-medium">{row.huntressOrgName || row.huntressOrgId}</div>
                      <div className="text-xs text-muted-foreground">
                        ID {row.huntressOrgId}{row.huntressOrgKey ? ` - ${row.huntressOrgKey}` : ''}
                      </div>
                    </td>
                    <td className="py-3 pr-4 text-muted-foreground">{row.agentsCount}</td>
                    <td className="py-3 pr-4 text-muted-foreground">{row.incidentsCount}</td>
                    <td className="py-3 pr-4">
                      <select
                        value={row.mappedOrgId ?? ''}
                        onChange={(event) => void handleMap(row.huntressOrgId, event.target.value || null)}
                        disabled={mappingSaving[row.huntressOrgId]}
                        className="h-9 w-full max-w-xs rounded-md border bg-background px-2 text-sm outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-50"
                      >
                        <option value="">Select organization</option>
                        {orgOptions.map((org) => (
                          <option key={org.id} value={org.id}>{org.name}</option>
                        ))}
                      </select>
                    </td>
                    <td className="py-3">
                      {mappingSaving[row.huntressOrgId] ? (
                        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                      ) : row.mappedOrgId ? (
                        <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                      ) : (
                        <AlertTriangle className="h-4 w-4 text-amber-500" />
                      )}
                    </td>
                  </tr>
                ))}
                {huntressOrgs.length === 0 && (
                  <tr>
                    <td colSpan={5} className="py-6 text-sm text-muted-foreground">
                      No Huntress organizations discovered yet. Save credentials and run Sync Now.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {integration && recentIncidents.length > 0 && (
        <div className="rounded-xl border bg-card p-6 shadow-sm">
          <h2 className="text-lg font-semibold">Recent incidents</h2>
          <div className="mt-4 space-y-3">
            {recentIncidents.map((incident) => (
              <div key={incident.id} className="flex items-center justify-between gap-4 border-b pb-3 last:border-0 last:pb-0">
                <div>
                  <div className="font-medium">{incident.title}</div>
                  <div className="text-xs text-muted-foreground">
                    {incident.reportedAt ? new Date(incident.reportedAt).toLocaleString() : 'Unknown time'} - {incident.status}
                  </div>
                </div>
                <SeverityBadge severity={incident.severity} />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function SecretInput(props: {
  label: string;
  hint?: string;
  value: string;
  onChange: (value: string) => void;
  visible: boolean;
  onToggle: () => void;
  placeholder: string;
}) {
  return (
    <div>
      <label className="mb-1 block text-sm font-medium">
        {props.label}
        {props.hint && <span className="ml-1 text-xs text-muted-foreground">({props.hint})</span>}
      </label>
      <div className="relative">
        <input
          type={props.visible ? 'text' : 'password'}
          value={props.value}
          onChange={(event) => props.onChange(event.target.value)}
          placeholder={props.placeholder}
          className="h-10 w-full rounded-md border bg-background px-3 pr-10 text-sm outline-none focus:ring-2 focus:ring-primary/30"
        />
        <button
          type="button"
          aria-label={props.visible ? `Hide ${props.label}` : `Show ${props.label}`}
          onClick={props.onToggle}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
        >
          {props.visible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </button>
      </div>
    </div>
  );
}

function Metric({ label, value, warn = false }: { label: string; value: number; warn?: boolean }) {
  return (
    <div>
      <p className={`text-2xl font-bold ${warn ? 'text-amber-600' : ''}`}>{value}</p>
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  );
}
