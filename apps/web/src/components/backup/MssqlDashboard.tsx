import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  Database,
  Loader2,
  Play,
  RefreshCw,
  Search,
  Server,
  ShieldCheck,
  XCircle,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { fetchWithAuth } from '../../stores/auth';
import { formatBytes, formatTime } from './backupDashboardHelpers';
import AlphaBadge from '../shared/AlphaBadge';

// ── Types ──────────────────────────────────────────────────────────

type MssqlDatabase = {
  name: string;
  recoveryModel: string;
  sizeMb?: number | null;
  tdeEnabled?: boolean;
};

type DeviceSummary = {
  id: string;
  hostname?: string | null;
  displayName?: string | null;
  osType?: string | null;
  status?: string | null;
  eligible?: boolean;
};

type MssqlInstance = {
  id: string;
  deviceId: string;
  instanceName: string;
  version?: string | null;
  edition?: string | null;
  port?: number | null;
  status: string;
  databases: MssqlDatabase[];
};

type BackupChainSnapshot = {
  id: string;
  type: 'full' | 'differential' | 'log';
  timestamp: string;
  sizeBytes?: number | null;
};

type BackupChain = {
  id: string;
  instanceId: string;
  databaseName: string;
  snapshots: BackupChainSnapshot[];
};

type InstanceStatus = 'online' | 'offline' | 'unknown';

const instanceStatusConfig: Record<InstanceStatus, { label: string; className: string }> = {
  online: { label: 'Online', className: 'text-success bg-success/10' },
  offline: { label: 'Offline', className: 'text-destructive bg-destructive/10' },
  unknown: { label: 'Unknown', className: 'text-muted-foreground bg-muted' },
};

function normalizeInstanceStatus(status?: string): InstanceStatus {
  if (!status) return 'unknown';
  const s = status.toLowerCase();
  if (s === 'online' || s === 'running') return 'online';
  if (s === 'offline' || s === 'stopped') return 'offline';
  return 'unknown';
}

// ── Component ─────────────────────────────────────────────────────

export default function MssqlDashboard() {
  const [instances, setInstances] = useState<MssqlInstance[]>([]);
  const [chains, setChains] = useState<BackupChain[]>([]);
  const [discoveryTargets, setDiscoveryTargets] = useState<DeviceSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState<string>();
  const [expandedInstanceId, setExpandedInstanceId] = useState<string | null>(null);
  const [discoveringDeviceId, setDiscoveringDeviceId] = useState<string | null>(null);
  const [backingUpDb, setBackingUpDb] = useState<string | null>(null);
  const [emptyDiscoveryDeviceId, setEmptyDiscoveryDeviceId] = useState('');
  const [query, setQuery] = useState('');

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      setError(undefined);
      const [instRes, chainRes, deviceRes] = await Promise.all([
        fetchWithAuth('/backup/mssql/instances'),
        fetchWithAuth('/backup/mssql/chains'),
        fetchWithAuth('/backup/mssql/discovery-targets'),
      ]);

      if (instRes.ok) {
        const payload = await instRes.json();
        setInstances(Array.isArray(payload?.data) ? payload.data : []);
      }

      if (chainRes.ok) {
        const payload = await chainRes.json();
        setChains(Array.isArray(payload?.data) ? payload.data : []);
      }

      if (deviceRes.ok) {
        const payload = await deviceRes.json();
        const data = payload?.data ?? payload ?? [];
        const targets = Array.isArray(data) ? data as DeviceSummary[] : [];
        setDiscoveryTargets(targets);
        setEmptyDiscoveryDeviceId((current) => {
          if (current && targets.some((device) => device.id === current)) {
            return current;
          }
          return targets.find((device) => device.eligible)?.id ?? targets[0]?.id ?? '';
        });
      }

      const failures: string[] = [];
      if (!instRes.ok) failures.push(`SQL instances (${instRes.status})`);
      if (!chainRes.ok) failures.push(`backup chains (${chainRes.status})`);
      if (!deviceRes.ok) failures.push(`discovery targets (${deviceRes.status})`);
      if (failures.length > 0) {
        setError(`Failed to load: ${failures.join(', ')}`);
      }
    } catch (err) {
      console.error('[MssqlDashboard] fetchData:', err);
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleDiscover = useCallback(async (deviceId: string) => {
    try {
      setDiscoveringDeviceId(deviceId);
      setError(undefined);
      setMessage(undefined);
      const response = await fetchWithAuth(`/backup/mssql/discover/${deviceId}`, {
        method: 'POST',
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.error ?? 'Discovery failed');
      }
      await fetchData();
      setMessage('SQL Server discovery completed.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Discovery failed');
    } finally {
      setDiscoveringDeviceId(null);
    }
  }, [fetchData]);

  const handleBackupDb = useCallback(async (instance: MssqlInstance, databaseName: string) => {
    const key = `${instance.id}:${databaseName}`;
    try {
      setBackingUpDb(key);
      setError(undefined);
      setMessage(undefined);
      const response = await fetchWithAuth('/backup/mssql/backup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          deviceId: instance.deviceId,
          instance: instance.instanceName,
          database: databaseName,
          backupType: 'full',
        }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.error ?? 'Backup failed');
      }
      await fetchData();
      setMessage(`Backup started for ${databaseName}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Backup failed');
    } finally {
      setBackingUpDb(null);
    }
  }, [fetchData]);

  const filteredInstances = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return instances;
    return instances.filter(
      (inst) =>
        inst.instanceName.toLowerCase().includes(normalizedQuery) ||
        inst.version?.toLowerCase().includes(normalizedQuery) ||
        inst.edition?.toLowerCase().includes(normalizedQuery)
    );
  }, [instances, query]);

  const selectedDiscoveryTarget = useMemo(
    () => discoveryTargets.find((device) => device.id === emptyDiscoveryDeviceId) ?? null,
    [discoveryTargets, emptyDiscoveryDeviceId]
  );

  const eligibleDiscoveryTargets = useMemo(
    () => discoveryTargets.filter((device) => device.eligible),
    [discoveryTargets]
  );

  const singleEligibleDiscoveryTarget =
    eligibleDiscoveryTargets.length === 1 ? eligibleDiscoveryTargets[0] ?? null : null;

  const emptyStateTitle = discoveryTargets.length === 0
    ? 'No SQL discovery targets available'
    : 'No SQL Server instances found';

  const emptyStateDescription = discoveryTargets.length === 0
    ? 'Assign an SQL Server backup policy to a Windows device before running discovery.'
    : singleEligibleDiscoveryTarget
      ? `Run discovery on ${singleEligibleDiscoveryTarget.displayName ?? singleEligibleDiscoveryTarget.hostname ?? 'the protected device'} to detect SQL Server instances.`
      : 'Choose a protected Windows device and run discovery to detect SQL Server instances.';

  const toggleExpand = (id: string) => {
    setExpandedInstanceId((prev) => (prev === id ? null : id));
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="text-center">
          <div className="mx-auto h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          <p className="mt-4 text-sm text-muted-foreground">Loading SQL Server instances...</p>
        </div>
      </div>
    );
  }

  if (error && instances.length === 0) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
        <p className="text-sm text-destructive">{error}</p>
        <button
          type="button"
          onClick={fetchData}
          className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          Try again
        </button>
      </div>
    );
  }

  // Empty state
  if (!error && instances.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <Database className="h-12 w-12 text-muted-foreground/40" />
        <h3 className="mt-4 text-base font-semibold text-foreground">{emptyStateTitle}</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          {emptyStateDescription}
        </p>
        {discoveryTargets.length > 0 && (
          <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
            {singleEligibleDiscoveryTarget ? (
              <div className="min-w-64 rounded-md border bg-background px-3 py-2 text-left text-sm">
                <div className="font-medium text-foreground">
                  {singleEligibleDiscoveryTarget.displayName ?? singleEligibleDiscoveryTarget.hostname ?? singleEligibleDiscoveryTarget.id}
                </div>
                <div className="text-xs text-muted-foreground">Protected Windows device</div>
              </div>
            ) : (
              <select
                className="min-w-64 rounded-md border bg-background px-3 py-2 text-sm"
                value={emptyDiscoveryDeviceId}
                onChange={(event) => setEmptyDiscoveryDeviceId(event.target.value)}
              >
                <option value="">Select a protected Windows device</option>
                {discoveryTargets.map((device) => (
                  <option key={device.id} value={device.id}>
                    {`${device.displayName ?? device.hostname ?? device.id}${device.eligible ? '' : ' — offline'}`}
                  </option>
                ))}
              </select>
            )}
            <button
              type="button"
              onClick={() => void handleDiscover(emptyDiscoveryDeviceId)}
              disabled={!emptyDiscoveryDeviceId || discoveringDeviceId === emptyDiscoveryDeviceId || !selectedDiscoveryTarget?.eligible}
              className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {discoveringDeviceId === emptyDiscoveryDeviceId ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              Run discovery
            </button>
          </div>
        )}
        {discoveryTargets.length > 0 && !eligibleDiscoveryTargets.length && (
          <p className="mt-3 text-xs text-muted-foreground">
            A protected target exists, but discovery requires the device to be online.
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <AlphaBadge variant="banner" disclaimer="SQL Server backup is in early access. Discovery and backup chains are functional, but recovery workflows still require direct API or operator handling." />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-foreground">SQL Server Backup</h2>
          <p className="text-sm text-muted-foreground">
            Manage MSSQL instances, databases, and backup chains.
          </p>
        </div>
        <button
          type="button"
          onClick={fetchData}
          className="inline-flex items-center gap-2 rounded-md border bg-background px-3 py-1.5 text-xs font-medium hover:bg-muted"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          Refresh
        </button>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}
      {message && (
        <div className="rounded-md border border-success/40 bg-success/10 px-3 py-2 text-sm text-success">
          {message}
        </div>
      )}

      {/* Search */}
      <div className="flex items-center gap-2 rounded-md border bg-background px-3 py-2 text-sm">
        <Search className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        <label htmlFor="mssql-search" className="sr-only">Search instances</label>
        <input
          id="mssql-search"
          className="w-full bg-transparent text-sm outline-none"
          placeholder="Search by instance name, version, or edition..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {/* Instance Table */}
      <div className="overflow-x-auto rounded-lg border bg-card shadow-sm">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-4 py-3 w-8" />
              <th className="px-4 py-3">Instance</th>
              <th className="px-4 py-3">Version</th>
              <th className="px-4 py-3">Edition</th>
              <th className="px-4 py-3">Port</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Databases</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {filteredInstances.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-4 py-8 text-center text-sm text-muted-foreground">
                  No instances match your search.
                </td>
              </tr>
            ) : (
              filteredInstances.map((inst) => {
                const statusNorm = normalizeInstanceStatus(inst.status);
                const cfg = instanceStatusConfig[statusNorm];
                const isExpanded = expandedInstanceId === inst.id;
                return (
                  <InstanceRow
                    key={inst.id}
                    instance={inst}
                    statusConfig={cfg}
                    isExpanded={isExpanded}
                    onToggle={() => toggleExpand(inst.id)}
                    onDiscover={() => handleDiscover(inst.deviceId)}
                    discovering={discoveringDeviceId === inst.deviceId}
                    onBackupDb={(dbName) => handleBackupDb(inst, dbName)}
                    backingUpDb={backingUpDb}
                    instanceId={inst.id}
                  />
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Backup Chains */}
      {chains.length > 0 && (
        <div className="rounded-lg border bg-card p-5 shadow-sm">
          <h3 className="mb-4 font-semibold">Backup Chains</h3>
          <div className="space-y-4">
            {chains.map((chain) => (
              <div key={chain.id} className="rounded-md border bg-muted/20 p-4">
                <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                  <Database className="h-4 w-4 text-primary" />
                  {chain.databaseName}
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  {chain.snapshots.map((snap) => {
                    const typeColor =
                      snap.type === 'full'
                        ? 'bg-primary/10 text-primary'
                        : snap.type === 'differential'
                          ? 'bg-warning/10 text-warning'
                          : 'bg-muted text-muted-foreground';
                    return (
                      <div
                        key={snap.id}
                        className={cn(
                          'rounded-md border px-3 py-1.5 text-xs',
                          typeColor
                        )}
                      >
                        <span className="font-medium capitalize">{snap.type}</span>
                        <span className="ml-2 text-muted-foreground">{formatTime(snap.timestamp)}</span>
                        {snap.sizeBytes != null && (
                          <span className="ml-2 text-muted-foreground">{formatBytes(snap.sizeBytes)}</span>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Instance Row Sub-component ────────────────────────────────────

type InstanceRowProps = {
  instance: MssqlInstance;
  statusConfig: { label: string; className: string };
  isExpanded: boolean;
  onToggle: () => void;
  onDiscover: () => void;
  discovering: boolean;
  onBackupDb: (dbName: string) => void;
  backingUpDb: string | null;
  instanceId: string;
};

function InstanceRow({
  instance,
  statusConfig: cfg,
  isExpanded,
  onToggle,
  onDiscover,
  discovering,
  onBackupDb,
  backingUpDb,
  instanceId,
}: InstanceRowProps) {
  return (
    <>
      <tr className="text-sm text-foreground">
        <td className="px-4 py-3">
          <button
            type="button"
            onClick={onToggle}
            className="text-muted-foreground hover:text-foreground"
            aria-label={isExpanded ? 'Collapse' : 'Expand'}
          >
            {isExpanded ? (
              <ChevronDown className="h-4 w-4" />
            ) : (
              <ChevronRight className="h-4 w-4" />
            )}
          </button>
        </td>
        <td className="px-4 py-3 font-medium">
          <div className="flex items-center gap-2">
            <Server className="h-4 w-4 text-muted-foreground" />
            {instance.instanceName}
          </div>
        </td>
        <td className="px-4 py-3 text-muted-foreground">{instance.version ?? '--'}</td>
        <td className="px-4 py-3 text-muted-foreground">{instance.edition ?? '--'}</td>
        <td className="px-4 py-3 text-muted-foreground">{instance.port ?? 1433}</td>
        <td className="px-4 py-3">
          <span
            className={cn(
              'inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium',
              cfg.className
            )}
          >
            {cfg.label}
          </span>
        </td>
        <td className="px-4 py-3 text-muted-foreground">{instance.databases.length}</td>
        <td className="px-4 py-3">
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onDiscover}
              disabled={discovering}
              className="inline-flex items-center gap-1 rounded-md border px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:bg-accent disabled:opacity-50"
            >
              {discovering ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
              Discover
            </button>
          </div>
        </td>
      </tr>
      {isExpanded && instance.databases.length > 0 && (
        <tr>
          <td colSpan={8} className="bg-muted/20 px-8 py-3">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className="pb-2 pr-4 font-medium">Database</th>
                  <th className="pb-2 pr-4 font-medium">Recovery Model</th>
                  <th className="pb-2 pr-4 font-medium">Size</th>
                  <th className="pb-2 pr-4 font-medium">TDE</th>
                  <th className="pb-2 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {instance.databases.map((db) => {
                  const backupKey = `${instanceId}:${db.name}`;
                  return (
                    <tr key={db.name} className="border-b last:border-0">
                      <td className="py-2 pr-4 font-medium text-foreground">
                        <div className="flex items-center gap-2">
                          <Database className="h-3.5 w-3.5 text-muted-foreground" />
                          {db.name}
                        </div>
                      </td>
                      <td className="py-2 pr-4 text-muted-foreground capitalize">{db.recoveryModel}</td>
                      <td className="py-2 pr-4 text-muted-foreground">
                        {db.sizeMb != null ? `${db.sizeMb} MB` : '--'}
                      </td>
                      <td className="py-2 pr-4">
                        {db.tdeEnabled ? (
                          <span className="inline-flex items-center gap-1 rounded-full bg-success/10 px-2 py-0.5 text-xs font-medium text-success">
                            <ShieldCheck className="h-3 w-3" />
                            Enabled
                          </span>
                        ) : (
                          <span className="text-xs text-muted-foreground">Off</span>
                        )}
                      </td>
                      <td className="py-2 text-right">
                        <button
                          type="button"
                          onClick={() => onBackupDb(db.name)}
                          disabled={backingUpDb === backupKey}
                          className="inline-flex items-center gap-1 rounded-md border px-2.5 py-1.5 text-xs font-medium text-primary hover:bg-primary/10 disabled:opacity-50"
                        >
                          {backingUpDb === backupKey ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Play className="h-3.5 w-3.5" />
                          )}
                          Backup Now
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </td>
        </tr>
      )}
    </>
  );
}
