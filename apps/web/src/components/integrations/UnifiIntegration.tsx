import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  History,
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

// Live host+site list discovered from GET /unifi/hosts (calls UniFi directly).
interface UnifiHostOption {
  id: string;
  name: string;
  sites: Array<{ id: string; name: string }>;
}
// Breeze sites/orgs that a UniFi site can be mapped onto (from GET /orgs/*).
interface BreezeSiteOption { id: string; name: string; orgId: string }
interface OrgOption { id: string; name: string }
// Currently-saved mappings (from GET /unifi/mappings).
interface SavedMapping {
  id: string;
  orgId: string;
  siteId: string;
  unifiHostId: string;
  unifiSiteId: string;
  unifiHostName: string | null;
  unifiSiteName: string | null;
}
// Sync-run ledger rows (from GET /unifi/sync-runs).
interface SyncRun {
  id: string;
  trigger: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  hostsSeen: number;
  devicesCreated: number;
  devicesUpdated: number;
  devicesUnchanged: number;
  devicesRemoved: number;
  error: string | null;
}

// Per-console deep-telemetry collector config (from GET /unifi/collectors).
interface UnifiCollector {
  id: string;
  unifiHostId: string;
  siteId: string;
  collectorDeviceId: string;
  controllerUrl: string;
  isEnabled: boolean;
  status: string;
  firmwareOk: boolean | null;
  lastPollAt: string | null;
  lastPollStatus: string | null;
  lastPollError: string | null;
}
// Agent devices eligible to be a collector (from GET /devices).
interface AgentDevice { id: string; name: string | null; siteId: string | null; status?: string | null }
// Deep telemetry rows (from GET /unifi/telemetry?siteId=).
interface TelemetryDevice {
  id: string; unifiDeviceId: string; name: string | null; mac: string | null;
  uptimeSeconds: number | null; numClients: number | null; isStale: boolean;
  poePorts: Array<{ port_idx?: number; name?: string; poe_mode?: string; poe_power_w?: number; link_speed_mbps?: number; up?: boolean }> | null;
}
interface TelemetryClient {
  id: string; mac: string; hostname: string | null; ipAddress: string | null;
  connectedDeviceId: string | null; isWired: boolean | null; ssid: string | null; signalDbm: number | null; isStale: boolean;
}
// Per-host draft for the collector config form.
interface CollectorDraft { siteId: string; collectorDeviceId: string; controllerUrl: string; apiKey: string }

// Stable key for a discovered UniFi site within a host (host ids repeat across hosts otherwise).
const mapKey = (hostId: string, unifiSiteId: string) => `${hostId}::${unifiSiteId}`;

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

  // Site-mapping + sync-history state (only loaded once connected).
  const [hosts, setHosts] = useState<UnifiHostOption[] | null>(null);
  const [hostsLoading, setHostsLoading] = useState(false);
  const [hostsError, setHostsError] = useState<string | null>(null);
  const [breezeSites, setBreezeSites] = useState<BreezeSiteOption[]>([]);
  const [orgs, setOrgs] = useState<OrgOption[]>([]);
  const [selection, setSelection] = useState<Record<string, string>>({});
  const [savingMappings, setSavingMappings] = useState(false);
  const [syncRuns, setSyncRuns] = useState<SyncRun[]>([]);

  // Deep-telemetry collector state.
  const [collectors, setCollectors] = useState<Record<string, UnifiCollector>>({});
  const [agents, setAgents] = useState<AgentDevice[]>([]);
  const [collectorDrafts, setCollectorDrafts] = useState<Record<string, CollectorDraft>>({});
  const [savingCollector, setSavingCollector] = useState<string | null>(null);
  // Telemetry viewer state.
  const [telemetrySite, setTelemetrySite] = useState<string>('');
  const [telemetry, setTelemetry] = useState<{ devices: TelemetryDevice[]; clients: TelemetryClient[] } | null>(null);
  const [telemetryLoading, setTelemetryLoading] = useState(false);
  const [telemetryError, setTelemetryError] = useState<string | null>(null);
  // Monotonic id so a slow telemetry request can't overwrite a newer one's result.
  const telemetryReqId = useRef(0);
  // Surfaced when the connected-panel detail fetches (sites/orgs/mappings/etc.) fail.
  const [detailsError, setDetailsError] = useState<string | null>(null);

  const onUnauthorized = useCallback(() => {
    navigateTo(loginPathWithNext());
  }, []);

  // Breeze sites grouped by organization, for the <optgroup> picker.
  const sitesByOrg = useMemo(() => {
    const orgName = new Map(orgs.map((o) => [o.id, o.name]));
    // Key the group by orgId, not name — two orgs can share a display name in an
    // MSP fleet, which would collide as duplicate React <optgroup> keys.
    const groups = new Map<string, { id: string; name: string; sites: BreezeSiteOption[] }>();
    for (const s of breezeSites) {
      const group = groups.get(s.orgId) ?? { id: s.orgId, name: orgName.get(s.orgId) ?? 'Organization', sites: [] };
      group.sites.push(s);
      groups.set(s.orgId, group);
    }
    return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [breezeSites, orgs]);

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

  // GET /unifi/hosts is a LIVE call to UniFi — slow and able to fail (bad key → 502),
  // so it carries its own loading/error state and never blocks the rest of the panel.
  const loadHosts = useCallback(async () => {
    setHostsLoading(true);
    setHostsError(null);
    try {
      const res = await fetchWithAuth('/unifi/hosts');
      if (res.status === 401) {
        onUnauthorized();
        return;
      }
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setHosts(null);
        setHostsError((json as { message?: string }).message ?? `Could not load UniFi sites (${res.status}).`);
        return;
      }
      setHosts((json as { hosts?: UnifiHostOption[] }).hosts ?? []);
    } catch {
      setHosts(null);
      setHostsError('Could not reach UniFi to list sites.');
    } finally {
      setHostsLoading(false);
    }
  }, [onUnauthorized]);

  const loadDetails = useCallback(async () => {
    setDetailsError(null);
    try {
      const [sitesRes, orgsRes, mappingsRes, runsRes, collectorsRes, devicesRes] = await Promise.all([
        fetchWithAuth('/orgs/sites?limit=500'),
        fetchWithAuth('/orgs/organizations?limit=500'),
        fetchWithAuth('/unifi/mappings'),
        fetchWithAuth('/unifi/sync-runs'),
        fetchWithAuth('/unifi/collectors'),
        fetchWithAuth('/devices?limit=500'),
      ]);
      if ([sitesRes, orgsRes, mappingsRes, runsRes, collectorsRes, devicesRes].some((r) => r.status === 401)) {
        onUnauthorized();
        return;
      }
      // Track per-section failures so a non-401 error doesn't leave a picker
      // mysteriously empty with no explanation.
      const failed: string[] = [];
      const sitesJson = await sitesRes.json().catch(() => ({}));
      if (sitesRes.ok) setBreezeSites((sitesJson as { data?: BreezeSiteOption[] }).data ?? []); else failed.push('sites');
      const orgsJson = await orgsRes.json().catch(() => ({}));
      if (orgsRes.ok) setOrgs((orgsJson as { data?: OrgOption[] }).data ?? []); else failed.push('organizations');
      const mappingsJson = await mappingsRes.json().catch(() => ({}));
      if (mappingsRes.ok) {
        const saved = (mappingsJson as { mappings?: SavedMapping[] }).mappings ?? [];
        // Seed the picker selections from what's already persisted.
        setSelection(Object.fromEntries(saved.map((m) => [mapKey(m.unifiHostId, m.unifiSiteId), m.siteId])));
      } else failed.push('mappings');
      const runsJson = await runsRes.json().catch(() => ({}));
      if (runsRes.ok) setSyncRuns((runsJson as { runs?: SyncRun[] }).runs ?? []); else failed.push('sync history');
      const collectorsJson = await collectorsRes.json().catch(() => ({}));
      if (collectorsRes.ok) {
        const list = (collectorsJson as { collectors?: UnifiCollector[] }).collectors ?? [];
        setCollectors(Object.fromEntries(list.map((col) => [col.unifiHostId, col])));
        // Pre-fill each host's draft from its saved collector (key stays blank — never echoed back).
        setCollectorDrafts((prev) => {
          const next = { ...prev };
          for (const col of list) {
            next[col.unifiHostId] = {
              siteId: col.siteId,
              collectorDeviceId: col.collectorDeviceId,
              controllerUrl: col.controllerUrl,
              apiKey: next[col.unifiHostId]?.apiKey ?? '',
            };
          }
          return next;
        });
      } else failed.push('collectors');
      const devicesJson = await devicesRes.json().catch(() => ({}));
      if (devicesRes.ok) {
        const list = (devicesJson as { data?: AgentDevice[]; devices?: AgentDevice[] }).data
          ?? (devicesJson as { devices?: AgentDevice[] }).devices
          ?? (Array.isArray(devicesJson) ? (devicesJson as AgentDevice[]) : []);
        setAgents(list);
      } else failed.push('agent devices');
      if (failed.length > 0) {
        setDetailsError(`Some UniFi configuration data failed to load (${failed.join(', ')}). Refresh to retry.`);
      }
      await loadHosts();
    } catch {
      // A rejected fetch (network drop, CORS) would otherwise be an unhandled
      // promise that silently leaves every picker empty.
      setDetailsError('Could not load UniFi configuration data. Check your connection and refresh.');
    }
  }, [onUnauthorized, loadHosts]);

  // Load mapping/history detail once the connection status resolves to connected.
  useEffect(() => {
    if (status?.connected === true) void loadDetails();
  }, [status?.connected, loadDetails]);

  const handleSaveMappings = useCallback(async () => {
    if (!hosts) return;
    const mappings = hosts.flatMap((h) =>
      h.sites.flatMap((s) => {
        const siteId = selection[mapKey(h.id, s.id)];
        if (!siteId) return [];
        return [{ unifiHostId: h.id, unifiSiteId: s.id, unifiHostName: h.name, unifiSiteName: s.name, siteId }];
      }),
    );
    setSavingMappings(true);
    try {
      await runAction({
        request: () => fetchWithAuth('/unifi/mappings', { method: 'PUT', body: JSON.stringify({ mappings }) }),
        errorFallback: 'Failed to save site mappings.',
        successMessage: 'Site mappings saved',
        onUnauthorized,
      });
      await loadDetails();
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) handleActionError(err, 'Failed to save site mappings.');
    } finally {
      setSavingMappings(false);
    }
  }, [hosts, selection, onUnauthorized, loadDetails]);

  const updateDraft = useCallback((hostId: string, patch: Partial<CollectorDraft>) => {
    setCollectorDrafts((prev) => {
      const base = prev[hostId] ?? { siteId: '', collectorDeviceId: '', controllerUrl: '', apiKey: '' };
      return { ...prev, [hostId]: { ...base, ...patch } };
    });
  }, []);

  const handleSaveCollector = useCallback(async (hostId: string) => {
    const draft = collectorDrafts[hostId];
    if (!draft?.siteId || !draft.collectorDeviceId || !draft.controllerUrl.trim() || !draft.apiKey.trim()) {
      setLoadError('Pick a Breeze site, a collector agent, and enter the controller URL and local API key.');
      return;
    }
    setSavingCollector(hostId);
    setLoadError(null);
    try {
      await runAction({
        request: () => fetchWithAuth('/unifi/collectors', {
          method: 'PUT',
          body: JSON.stringify({
            unifiHostId: hostId,
            siteId: draft.siteId,
            collectorDeviceId: draft.collectorDeviceId,
            controllerUrl: draft.controllerUrl.trim(),
            apiKey: draft.apiKey.trim(),
          }),
        }),
        errorFallback: 'Failed to save the UniFi collector.',
        successMessage: 'UniFi collector saved',
        onUnauthorized,
      });
      // Clear the entered key from memory; reload status.
      updateDraft(hostId, { apiKey: '' });
      await loadDetails();
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) handleActionError(err, 'Failed to save the UniFi collector.');
    } finally {
      setSavingCollector(null);
    }
  }, [collectorDrafts, onUnauthorized, loadDetails, updateDraft]);

  const handleLoadTelemetry = useCallback(async (siteId: string) => {
    setTelemetrySite(siteId);
    setTelemetry(null);
    setTelemetryError(null);
    if (!siteId) return;
    const reqId = ++telemetryReqId.current;
    setTelemetryLoading(true);
    try {
      const res = await fetchWithAuth(`/unifi/telemetry?siteId=${encodeURIComponent(siteId)}`);
      if (reqId !== telemetryReqId.current) return; // superseded by a newer site selection
      if (res.status === 401) return onUnauthorized();
      const json = await res.json().catch(() => ({}));
      if (res.ok) {
        setTelemetry({
          devices: (json as { devices?: TelemetryDevice[] }).devices ?? [],
          clients: (json as { clients?: TelemetryClient[] }).clients ?? [],
        });
      } else {
        // Surface 403/404/500 instead of rendering an empty panel that reads as
        // "no data" — the backend computes a precise message we'd otherwise drop.
        setTelemetryError((json as { error?: string }).error ?? `Failed to load telemetry (${res.status}).`);
      }
    } catch {
      if (reqId === telemetryReqId.current) setTelemetryError('Could not reach the server to load telemetry.');
    } finally {
      if (reqId === telemetryReqId.current) setTelemetryLoading(false);
    }
  }, [onUnauthorized]);

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
      await loadDetails();
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) handleActionError(err, 'Failed to sync UniFi sites.');
    } finally {
      setSyncing(false);
    }
  }, [load, loadDetails, onUnauthorized]);

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

      {detailsError && (
        <p className="flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800" data-testid="unifi-details-error">
          <AlertTriangle className="h-4 w-4 shrink-0" /> {detailsError}
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

      {isConnected && (
        <div className="rounded-xl border bg-card p-5 shadow-xs" data-testid="unifi-mapping-card">
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold">Site mapping</h2>
            <button
              type="button"
              onClick={() => void loadHosts()}
              disabled={hostsLoading}
              className="ml-auto inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium hover:bg-muted disabled:opacity-50"
              data-testid="unifi-mapping-refresh"
            >
              <RefreshCw className={hostsLoading ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} />
              Refresh
            </button>
          </div>
          <p className="mb-4 text-sm text-muted-foreground">
            Map each discovered UniFi site to a Breeze site. Devices synced from that UniFi site are
            reconciled into the chosen site&apos;s discovered assets.
          </p>

          {hostsLoading ? (
            <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground" data-testid="unifi-mapping-loading">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading UniFi sites…
            </div>
          ) : hostsError ? (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800" data-testid="unifi-mapping-error">
              {hostsError}
            </div>
          ) : !hosts || hosts.length === 0 ? (
            <p className="py-6 text-sm text-muted-foreground" data-testid="unifi-mapping-empty">
              No UniFi hosts or sites were discovered for this account yet.
            </p>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y text-sm" data-testid="unifi-mapping-table">
                  <thead>
                    <tr className="text-left text-muted-foreground">
                      <th className="px-3 py-2 font-medium">UniFi host</th>
                      <th className="px-3 py-2 font-medium">UniFi site</th>
                      <th className="px-3 py-2 font-medium">Breeze site</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {hosts.flatMap((h) =>
                      h.sites.map((s) => {
                        const key = mapKey(h.id, s.id);
                        return (
                          <tr key={key} data-testid="unifi-mapping-row">
                            <td className="px-3 py-2 font-medium">{h.name}</td>
                            <td className="px-3 py-2 text-muted-foreground">{s.name}</td>
                            <td className="px-3 py-2">
                              <select
                                value={selection[key] ?? ''}
                                onChange={(e) => setSelection((prev) => ({ ...prev, [key]: e.target.value }))}
                                className="h-9 w-full max-w-xs rounded-md border bg-background px-2 text-sm"
                                data-testid="unifi-mapping-select"
                              >
                                <option value="">— Not mapped —</option>
                                {sitesByOrg.map((group) => (
                                  <optgroup key={group.id} label={group.name}>
                                    {group.sites.map((site) => (
                                      <option key={site.id} value={site.id}>{site.name}</option>
                                    ))}
                                  </optgroup>
                                ))}
                              </select>
                            </td>
                          </tr>
                        );
                      }),
                    )}
                  </tbody>
                </table>
              </div>
              <div className="mt-4 flex items-center gap-3 border-t pt-4">
                <button
                  type="button"
                  onClick={() => void handleSaveMappings()}
                  disabled={savingMappings}
                  className="inline-flex h-9 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
                  data-testid="unifi-mapping-save"
                >
                  {savingMappings ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plug className="h-4 w-4" />}
                  Save mappings
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {isConnected && hosts && hosts.length > 0 && (
        <div className="rounded-xl border bg-card p-5 shadow-xs" data-testid="unifi-collectors-card">
          <h2 className="text-lg font-semibold">Deep telemetry collectors</h2>
          <p className="mb-4 text-sm text-muted-foreground">
            Assign a Breeze agent at the site to poll each UniFi console&apos;s local Network Integration API
            (firmware&nbsp;≥&nbsp;9.3) for per-port PoE, device health, and connected clients. The local API key is
            stored encrypted and pushed to the chosen agent.
          </p>
          <div className="space-y-4">
            {hosts.map((h) => {
              const collector = collectors[h.id];
              const draft = collectorDrafts[h.id] ?? { siteId: '', collectorDeviceId: '', controllerUrl: '', apiKey: '' };
              const eligibleAgents = agents.filter((a) => !draft.siteId || a.siteId === draft.siteId);
              return (
                <div key={h.id} className="rounded-lg border p-4" data-testid="unifi-collector-row">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{h.name}</span>
                    {collector && (
                      <span
                        className={`ml-auto inline-flex items-center rounded-full border px-2 py-0.5 text-xs ${collectorStatusClasses(collector.status)}`}
                        title={collector.lastPollError ?? undefined}
                        data-testid="unifi-collector-status"
                      >
                        {collector.status}
                        {collector.lastPollAt ? ` · ${formatDateTime(collector.lastPollAt)}` : ''}
                      </span>
                    )}
                  </div>
                  {collector?.lastPollError && (
                    <p className="mt-1 text-xs text-red-600" data-testid="unifi-collector-error">{collector.lastPollError}</p>
                  )}
                  <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    <label className="text-sm">
                      <span className="text-muted-foreground">Breeze site (this console serves)</span>
                      <select
                        value={draft.siteId}
                        onChange={(e) => updateDraft(h.id, { siteId: e.target.value, collectorDeviceId: '' })}
                        className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm"
                        data-testid="unifi-collector-site"
                      >
                        <option value="">— Select site —</option>
                        {sitesByOrg.map((group) => (
                          <optgroup key={group.id} label={group.name}>
                            {group.sites.map((site) => (
                              <option key={site.id} value={site.id}>{site.name}</option>
                            ))}
                          </optgroup>
                        ))}
                      </select>
                    </label>
                    <label className="text-sm">
                      <span className="text-muted-foreground">Collector agent</span>
                      <select
                        value={draft.collectorDeviceId}
                        onChange={(e) => updateDraft(h.id, { collectorDeviceId: e.target.value })}
                        disabled={!draft.siteId}
                        className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm disabled:opacity-50"
                        data-testid="unifi-collector-agent"
                      >
                        <option value="">{draft.siteId ? '— Select agent —' : 'Pick a site first'}</option>
                        {eligibleAgents.map((a) => (
                          <option key={a.id} value={a.id}>{a.name ?? a.id}</option>
                        ))}
                      </select>
                    </label>
                    <label className="text-sm">
                      <span className="text-muted-foreground">Controller URL</span>
                      <input
                        type="text"
                        value={draft.controllerUrl}
                        onChange={(e) => updateDraft(h.id, { controllerUrl: e.target.value })}
                        placeholder="https://192.168.1.1"
                        className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm"
                        data-testid="unifi-collector-url"
                      />
                    </label>
                    <label className="text-sm">
                      <span className="text-muted-foreground">Local API key{collector ? ' (leave blank to keep)' : ''}</span>
                      <input
                        type="password"
                        autoComplete="off"
                        value={draft.apiKey}
                        onChange={(e) => updateDraft(h.id, { apiKey: e.target.value })}
                        placeholder="Network Integration API key"
                        className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm"
                        data-testid="unifi-collector-key"
                      />
                    </label>
                  </div>
                  <button
                    type="button"
                    onClick={() => void handleSaveCollector(h.id)}
                    disabled={savingCollector === h.id}
                    className="mt-3 inline-flex h-9 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
                    data-testid="unifi-collector-save"
                  >
                    {savingCollector === h.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plug className="h-4 w-4" />}
                    {collector ? 'Update collector' : 'Enable deep telemetry'}
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {isConnected && (
        <div className="rounded-xl border bg-card p-5 shadow-xs" data-testid="unifi-telemetry-card">
          <h2 className="text-lg font-semibold">Deep telemetry</h2>
          <p className="mb-4 text-sm text-muted-foreground">Live per-device PoE/health and connected clients for a mapped site.</p>
          <label className="block max-w-xs text-sm">
            <span className="text-muted-foreground">Site</span>
            <select
              value={telemetrySite}
              onChange={(e) => void handleLoadTelemetry(e.target.value)}
              className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm"
              data-testid="unifi-telemetry-site"
            >
              <option value="">— Select site —</option>
              {sitesByOrg.map((group) => (
                <optgroup key={group.id} label={group.name}>
                  {group.sites.map((site) => (
                    <option key={site.id} value={site.id}>{site.name}</option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>

          {telemetryLoading ? (
            <div className="mt-4 flex items-center gap-2 text-sm text-muted-foreground" data-testid="unifi-telemetry-loading">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading telemetry…
            </div>
          ) : telemetryError ? (
            <div className="mt-4 flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive" data-testid="unifi-telemetry-error">
              <AlertTriangle className="h-4 w-4 shrink-0" /> {telemetryError}
            </div>
          ) : telemetry ? (
            <div className="mt-4 space-y-6">
              <div>
                <h3 className="mb-2 text-sm font-semibold">Devices ({telemetry.devices.length})</h3>
                {telemetry.devices.length === 0 ? (
                  <p className="text-sm text-muted-foreground" data-testid="unifi-telemetry-devices-empty">No device telemetry yet.</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="min-w-full divide-y text-sm" data-testid="unifi-telemetry-devices">
                      <thead>
                        <tr className="text-left text-muted-foreground">
                          <th className="px-3 py-2 font-medium">Device</th>
                          <th className="px-3 py-2 font-medium">MAC</th>
                          <th className="px-3 py-2 font-medium">Clients</th>
                          <th className="px-3 py-2 font-medium">PoE ports</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {telemetry.devices.map((d) => (
                          <tr key={d.id} className={d.isStale ? 'text-muted-foreground' : ''} data-testid="unifi-telemetry-device-row">
                            <td className="px-3 py-2 font-medium">{d.name ?? d.unifiDeviceId}</td>
                            <td className="px-3 py-2 text-muted-foreground">{d.mac ?? '—'}</td>
                            <td className="px-3 py-2 tabular-nums">{d.numClients ?? '—'}</td>
                            <td className="px-3 py-2">
                              {Array.isArray(d.poePorts) && d.poePorts.length > 0
                                ? `${d.poePorts.filter((p) => p.up).length}/${d.poePorts.length} up · ${d.poePorts.reduce((sum, p) => sum + (p.poe_power_w ?? 0), 0).toFixed(1)}W`
                                : '—'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
              <div>
                <h3 className="mb-2 text-sm font-semibold">Clients ({telemetry.clients.length})</h3>
                {telemetry.clients.length === 0 ? (
                  <p className="text-sm text-muted-foreground" data-testid="unifi-telemetry-clients-empty">No clients reported.</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="min-w-full divide-y text-sm" data-testid="unifi-telemetry-clients">
                      <thead>
                        <tr className="text-left text-muted-foreground">
                          <th className="px-3 py-2 font-medium">Host</th>
                          <th className="px-3 py-2 font-medium">IP</th>
                          <th className="px-3 py-2 font-medium">MAC</th>
                          <th className="px-3 py-2 font-medium">Link</th>
                          <th className="px-3 py-2 font-medium">Signal</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {telemetry.clients.map((cl) => (
                          <tr key={cl.id} className={cl.isStale ? 'text-muted-foreground' : ''} data-testid="unifi-telemetry-client-row">
                            <td className="px-3 py-2 font-medium">{cl.hostname ?? '—'}</td>
                            <td className="px-3 py-2 text-muted-foreground">{cl.ipAddress ?? '—'}</td>
                            <td className="px-3 py-2 text-muted-foreground">{cl.mac}</td>
                            <td className="px-3 py-2">{cl.isWired ? 'Wired' : cl.ssid ? `Wi-Fi · ${cl.ssid}` : 'Wi-Fi'}</td>
                            <td className="px-3 py-2 tabular-nums">{cl.signalDbm != null ? `${cl.signalDbm} dBm` : '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          ) : null}
        </div>
      )}

      {isConnected && (
        <div className="rounded-xl border bg-card p-5 shadow-xs" data-testid="unifi-history-card">
          <div className="flex items-center gap-2">
            <History className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-lg font-semibold">Sync history</h2>
          </div>
          <p className="mb-4 text-sm text-muted-foreground">The most recent sync runs (newest first).</p>

          {syncRuns.length === 0 ? (
            <p className="py-6 text-sm text-muted-foreground" data-testid="unifi-history-empty">
              No sync runs yet. Trigger a sync to populate device inventory.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y text-sm" data-testid="unifi-history-table">
                <thead>
                  <tr className="text-left text-muted-foreground">
                    <th className="px-3 py-2 font-medium">Started</th>
                    <th className="px-3 py-2 font-medium">Trigger</th>
                    <th className="px-3 py-2 font-medium">Status</th>
                    <th className="px-3 py-2 font-medium" title="Hosts seen">Hosts</th>
                    <th className="px-3 py-2 font-medium" title="Devices created">New</th>
                    <th className="px-3 py-2 font-medium" title="Devices updated">Upd</th>
                    <th className="px-3 py-2 font-medium" title="Devices unchanged">Same</th>
                    <th className="px-3 py-2 font-medium" title="Devices removed/stale">Gone</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {syncRuns.map((run) => (
                    <tr key={run.id} data-testid="unifi-history-row">
                      <td className="px-3 py-2 whitespace-nowrap">{formatDateTime(run.startedAt)}</td>
                      <td className="px-3 py-2 text-muted-foreground">{run.trigger}</td>
                      <td className="px-3 py-2">
                        <span
                          className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs ${runStatusClasses(run.status)}`}
                          title={run.error ?? undefined}
                          data-testid="unifi-history-status"
                        >
                          {run.status}
                        </span>
                      </td>
                      <td className="px-3 py-2 tabular-nums">{run.hostsSeen}</td>
                      <td className="px-3 py-2 tabular-nums">{run.devicesCreated}</td>
                      <td className="px-3 py-2 tabular-nums">{run.devicesUpdated}</td>
                      <td className="px-3 py-2 tabular-nums">{run.devicesUnchanged}</td>
                      <td className="px-3 py-2 tabular-nums">{run.devicesRemoved}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Sync-run status → badge colors (mirrors SyncRunResult.status: success | partial | failed,
// plus the transient 'running' the worker writes at start).
function runStatusClasses(status: string): string {
  switch (status) {
    case 'success':
      return 'border-emerald-200 bg-emerald-50 text-emerald-700';
    case 'partial':
      return 'border-amber-200 bg-amber-50 text-amber-700';
    case 'failed':
      return 'border-red-200 bg-red-50 text-red-700';
    default:
      return 'border-slate-200 bg-slate-50 text-slate-600';
  }
}

// Collector status → badge colors (unifi_collectors.status:
// pending | connected | unreachable | error | firmware_too_old).
function collectorStatusClasses(status: string): string {
  switch (status) {
    case 'connected':
      return 'border-emerald-200 bg-emerald-50 text-emerald-700';
    case 'unreachable':
    case 'firmware_too_old':
      return 'border-amber-200 bg-amber-50 text-amber-700';
    case 'error':
      return 'border-red-200 bg-red-50 text-red-700';
    default:
      return 'border-slate-200 bg-slate-50 text-slate-600';
  }
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
