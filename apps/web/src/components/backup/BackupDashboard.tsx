import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Database,
  HardDrive,
  PlayCircle,
  ShieldAlert,
  TrendingUp,
  XCircle
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { fetchWithAuth } from '../../stores/auth';

type StatChangeType = 'positive' | 'negative' | 'neutral';

type BackupStat = {
  id?: string;
  name?: string;
  value?: string | number;
  change?: string;
  changeType?: StatChangeType;
};

type BackupJob = {
  id: string;
  device: string;
  config: string;
  status: string;
  started?: string;
  duration?: string;
  size?: string;
};

type OverdueDevice = {
  id?: string;
  name: string;
  lastBackup?: string;
  schedule?: string;
  owner?: string;
};

type StorageProvider = {
  id?: string;
  name: string;
  used?: string | number;
  total?: string | number;
  percent?: number;
};

type AttentionItem = {
  id?: string;
  title: string;
  description?: string;
  severity?: 'warning' | 'critical' | 'info' | 'success';
};

type UsageHistoryProvider = {
  provider: string;
  bytes: number;
};

type UsageHistoryPoint = {
  timestamp: string;
  totalBytes?: number;
  providers: UsageHistoryProvider[];
};

const statusConfig = {
  success: {
    icon: CheckCircle2,
    label: 'Success',
    className: 'text-success bg-success/10'
  },
  running: {
    icon: Activity,
    label: 'Running',
    className: 'text-primary bg-primary/10'
  },
  failed: {
    icon: XCircle,
    label: 'Failed',
    className: 'text-destructive bg-destructive/10'
  },
  warning: {
    icon: AlertTriangle,
    label: 'Warning',
    className: 'text-warning bg-warning/10'
  }
};

const statIconMap: Record<string, typeof Database> = {
  total_backups: Database,
  backups: Database,
  success_rate: CheckCircle2,
  success: CheckCircle2,
  storage_used: HardDrive,
  storage: HardDrive,
  devices_covered: ShieldAlert,
  devices: ShieldAlert
};

const providerColorMap: Record<string, string> = {
  'aws s3': 'bg-emerald-500',
  's3': 'bg-emerald-500',
  'azure blob': 'bg-sky-500',
  'azure': 'bg-sky-500',
  'local vault': 'bg-amber-500',
  'local': 'bg-amber-500',
  wasabi: 'bg-violet-500'
};

const providerStrokeMap: Record<string, string> = {
  'aws s3': '#10b981',
  's3': '#10b981',
  'azure blob': '#0ea5e9',
  'azure': '#0ea5e9',
  'local vault': '#f59e0b',
  'local': '#f59e0b',
  wasabi: '#8b5cf6'
};

const attentionIconMap: Record<string, typeof AlertTriangle> = {
  warning: AlertTriangle,
  critical: XCircle,
  info: HardDrive,
  success: CheckCircle2
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function parseUsageHistory(payload: unknown): UsageHistoryPoint[] {
  const root = asRecord(payload);
  const data = asRecord(root?.data);
  const rawPoints = Array.isArray(data?.points)
    ? data.points
    : Array.isArray(root?.points)
      ? root.points
      : [];

  const parsed: UsageHistoryPoint[] = [];

  for (const rawPoint of rawPoints) {
    const point = asRecord(rawPoint);
    if (!point) continue;

    const rawProviders = Array.isArray(point.providers) ? point.providers : [];
    const providers: UsageHistoryProvider[] = [];

    for (const rawProvider of rawProviders) {
      const provider = asRecord(rawProvider);
      if (!provider) continue;

      const providerName = String(provider.provider ?? provider.name ?? '').trim();
      const providerBytes = Number(provider.bytes ?? provider.usedBytes ?? provider.value ?? 0);
      if (!providerName || !Number.isFinite(providerBytes)) continue;

      providers.push({
        provider: providerName,
        bytes: Math.max(0, providerBytes)
      });
    }

    const timestamp = String(point.timestamp ?? point.date ?? '');
    if (!timestamp) continue;

    const totalBytesRaw = Number(point.totalBytes);
    const totalBytes = Number.isFinite(totalBytesRaw)
      ? totalBytesRaw
      : providers.reduce((sum, provider) => sum + provider.bytes, 0);

    parsed.push({
      timestamp,
      totalBytes: Math.max(0, totalBytes),
      providers
    });
  }

  return parsed;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  const precision = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(precision)} ${units[unitIndex]}`;
}

function buildLinePath(values: number[], maxValue: number): string {
  if (values.length === 0) return '';

  return values
    .map((value, index) => {
      const x = values.length === 1 ? 50 : (index / (values.length - 1)) * 100;
      const y = 100 - (value / maxValue) * 100;
      return `${x},${Math.max(0, Math.min(100, y))}`;
    })
    .join(' ');
}

function UsageHistoryChart({ points }: { points: UsageHistoryPoint[] }) {
  const providers = Array.from(
    new Set(points.flatMap((point) => point.providers.map((provider) => provider.provider)))
  );

  if (providers.length === 0 || points.length === 0) {
    return (
      <div className="rounded-md border border-dashed bg-muted/30 p-3 text-xs text-muted-foreground">
        No provider timeline available yet.
      </div>
    );
  }

  const normalized = points.map((point) => {
    const byProvider = new Map(point.providers.map((provider) => [provider.provider, provider.bytes]));
    const totalBytes = typeof point.totalBytes === 'number'
      ? point.totalBytes
      : providers.reduce((sum, providerName) => sum + (byProvider.get(providerName) ?? 0), 0);

    return {
      timestamp: point.timestamp,
      totalBytes,
      byProvider
    };
  });

  const maxValue = Math.max(
    1,
    ...normalized.flatMap((point) => [
      point.totalBytes,
      ...providers.map((provider) => point.byProvider.get(provider) ?? 0)
    ])
  );

  const first = normalized[0];
  const last = normalized[normalized.length - 1];

  return (
    <div className="space-y-3">
      <div className="h-28 rounded-md border bg-muted/20 p-2">
        <svg
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          className="h-full w-full"
          aria-label="Provider usage history chart"
        >
          <polyline
            fill="none"
            stroke="#475569"
            strokeWidth="2"
            strokeDasharray="4 3"
            points={buildLinePath(normalized.map((point) => point.totalBytes), maxValue)}
          />
          {providers.map((provider) => (
            <polyline
              key={provider}
              fill="none"
              stroke={providerStrokeMap[provider.toLowerCase()] ?? '#2563eb'}
              strokeWidth="3"
              points={buildLinePath(normalized.map((point) => point.byProvider.get(provider) ?? 0), maxValue)}
            />
          ))}
        </svg>
      </div>
      <div className="grid gap-2 text-xs">
        <div className="flex flex-wrap gap-2">
          {providers.map((provider) => (
            <span
              key={provider}
              className="inline-flex items-center gap-1 rounded-full border bg-background px-2 py-0.5 text-muted-foreground"
            >
              <span
                className="h-2 w-2 rounded-full"
                style={{ backgroundColor: providerStrokeMap[provider.toLowerCase()] ?? '#2563eb' }}
              />
              {provider}
            </span>
          ))}
          <span className="inline-flex items-center gap-1 rounded-full border bg-background px-2 py-0.5 text-muted-foreground">
            <span className="h-2 w-2 rounded-full bg-slate-600" />
            Total
          </span>
        </div>
        <div className="flex items-center justify-between text-muted-foreground">
          <span>{new Date(first.timestamp).toLocaleDateString()}</span>
          <span className="font-medium text-foreground">{formatBytes(last.totalBytes)}</span>
          <span>{new Date(last.timestamp).toLocaleDateString()}</span>
        </div>
      </div>
    </div>
  );
}

export default function BackupDashboard() {
  const [stats, setStats] = useState<BackupStat[]>([]);
  const [recentJobs, setRecentJobs] = useState<BackupJob[]>([]);
  const [overdueDevices, setOverdueDevices] = useState<OverdueDevice[]>([]);
  const [storageProviders, setStorageProviders] = useState<StorageProvider[]>([]);
  const [usageHistory, setUsageHistory] = useState<UsageHistoryPoint[]>([]);
  const [usageHistoryError, setUsageHistoryError] = useState<string>();
  const [attentionItems, setAttentionItems] = useState<AttentionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  const fetchOverview = useCallback(async () => {
    try {
      setLoading(true);
      setError(undefined);
      setUsageHistoryError(undefined);
      const response = await fetchWithAuth('/backup/dashboard');
      if (!response.ok) {
        throw new Error('Failed to fetch backup overview');
      }
      const payload = await response.json();
      const overview = payload?.data ?? payload ?? {};

      setStats(Array.isArray(overview.stats) ? overview.stats : []);
      setRecentJobs(
        Array.isArray(overview.recentJobs)
          ? overview.recentJobs
          : Array.isArray(overview.latestJobs)
            ? overview.latestJobs
            : []
      );
      setOverdueDevices(
        Array.isArray(overview.overdueDevices)
          ? overview.overdueDevices
          : Array.isArray(overview.devicesOverdue)
            ? overview.devicesOverdue
            : []
      );
      setStorageProviders(
        Array.isArray(overview.storageProviders)
          ? overview.storageProviders
          : Array.isArray(overview.providers)
            ? overview.providers
            : []
      );
      setAttentionItems(
        Array.isArray(overview.attentionItems)
          ? overview.attentionItems
          : Array.isArray(overview.alerts)
            ? overview.alerts
            : []
      );

      try {
        const usageResponse = await fetchWithAuth('/backup/usage-history?days=14');
        if (!usageResponse.ok) {
          throw new Error('Usage history is currently unavailable');
        }

        const usagePayload = await usageResponse.json();
        setUsageHistory(parseUsageHistory(usagePayload));
      } catch (usageErr) {
        setUsageHistory([]);
        setUsageHistoryError(
          usageErr instanceof Error ? usageErr.message : 'Usage history is currently unavailable'
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchOverview();
  }, [fetchOverview]);

  const hasData = useMemo(
    () =>
      stats.length > 0 ||
      recentJobs.length > 0 ||
      overdueDevices.length > 0 ||
      storageProviders.length > 0 ||
      usageHistory.length > 0 ||
      attentionItems.length > 0,
    [
      attentionItems.length,
      overdueDevices.length,
      recentJobs.length,
      stats.length,
      storageProviders.length,
      usageHistory.length
    ]
  );

  const resolveChangeType = (stat: BackupStat): StatChangeType => {
    if (stat.changeType) {
      return stat.changeType;
    }
    if (stat.change?.startsWith('-')) {
      return 'negative';
    }
    if (stat.change?.startsWith('+')) {
      return 'positive';
    }
    return 'neutral';
  };

  const resolveStatIcon = (stat: BackupStat) => {
    const rawKey = `${stat.id ?? stat.name ?? ''}`.toLowerCase().replace(/\s+/g, '_');
    return (
      statIconMap[rawKey] ||
      (rawKey.includes('success') ? CheckCircle2 : undefined) ||
      (rawKey.includes('storage') ? HardDrive : undefined) ||
      (rawKey.includes('device') ? ShieldAlert : undefined) ||
      Database
    );
  };

  const resolveJobStatus = (status?: string) => {
    if (!status) {
      return 'warning';
    }
    const normalized = status.toLowerCase();
    if (normalized.includes('success') || normalized.includes('complete')) {
      return 'success';
    }
    if (normalized.includes('run') || normalized.includes('progress')) {
      return 'running';
    }
    if (normalized.includes('fail') || normalized.includes('error')) {
      return 'failed';
    }
    return 'warning';
  };

  const resolveProviderColor = (name: string) => {
    const key = name.toLowerCase();
    return providerColorMap[key] ?? 'bg-primary';
  };

  const resolveProviderPercent = (provider: StorageProvider) => {
    if (typeof provider.percent === 'number') {
      return provider.percent;
    }
    const usedValue = typeof provider.used === 'number' ? provider.used : parseFloat(`${provider.used ?? ''}`);
    const totalValue = typeof provider.total === 'number' ? provider.total : parseFloat(`${provider.total ?? ''}`);
    if (!Number.isFinite(usedValue) || !Number.isFinite(totalValue) || totalValue <= 0) {
      return 0;
    }
    return Math.round((usedValue / totalValue) * 100);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="text-center">
          <div className="mx-auto h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          <p className="mt-4 text-sm text-muted-foreground">Loading backup overview...</p>
        </div>
      </div>
    );
  }

  if (error && !hasData) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
        <p className="text-sm text-destructive">{error}</p>
        <button
          type="button"
          onClick={fetchOverview}
          className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          Try again
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-foreground">Backup Overview</h2>
          <p className="text-sm text-muted-foreground">
            Monitor protection coverage, storage trends, and recent activity.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button className="inline-flex items-center gap-2 rounded-md border bg-card px-4 py-2 text-sm font-medium shadow-sm hover:bg-accent">
            <PlayCircle className="h-4 w-4" />
            Run all backups
          </button>
          <button className="inline-flex items-center gap-2 rounded-md bg-destructive px-4 py-2 text-sm font-medium text-destructive-foreground shadow-sm hover:bg-destructive/90">
            <AlertTriangle className="h-4 w-4" />
            View failed
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {stats.length === 0 ? (
          <div className="rounded-lg border border-dashed bg-muted/30 p-6 text-sm text-muted-foreground lg:col-span-4">
            No backup summary metrics available yet.
          </div>
        ) : (
          stats.map((stat, index) => {
            const StatIcon = resolveStatIcon(stat);
            const changeType = resolveChangeType(stat);
            return (
              <div
                key={`${stat.id ?? stat.name ?? 'stat'}-${index}`}
                className="rounded-lg border bg-card p-5 shadow-sm"
              >
                <div className="flex items-center justify-between">
                  <StatIcon className="h-5 w-5 text-muted-foreground" />
                  <span
                    className={cn(
                      'text-xs font-medium',
                      changeType === 'positive' && 'text-success',
                      changeType === 'negative' && 'text-destructive',
                      changeType === 'neutral' && 'text-muted-foreground'
                    )}
                  >
                    {stat.change ?? '--'}
                  </span>
                </div>
                <div className="mt-4">
                  <div className="text-2xl font-semibold text-foreground">
                    {stat.value ?? '--'}
                  </div>
                  <div className="text-sm text-muted-foreground">{stat.name ?? 'Metric'}</div>
                </div>
              </div>
            );
          })
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="rounded-lg border bg-card p-5 shadow-sm lg:col-span-2">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-base font-semibold text-foreground">Recent Jobs</h3>
              <p className="text-sm text-muted-foreground">Latest backup activity across sites.</p>
            </div>
            <button className="text-sm font-medium text-primary hover:text-primary/80">
              View all
            </button>
          </div>
          <div className="mt-4 space-y-3">
            {recentJobs.length === 0 ? (
              <div className="rounded-md border border-dashed bg-muted/30 p-4 text-sm text-muted-foreground">
                No recent backup jobs available.
              </div>
            ) : (
              recentJobs.map((job) => {
                const normalizedStatus = resolveJobStatus(job.status);
                const status = statusConfig[normalizedStatus as keyof typeof statusConfig];
                const StatusIcon = status.icon;
                return (
                  <div
                    key={job.id}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-dashed bg-muted/30 px-4 py-3"
                  >
                    <div className="flex items-center gap-3">
                      <span
                        className={cn('flex h-9 w-9 items-center justify-center rounded-full', status.className)}
                      >
                        <StatusIcon className="h-4 w-4" />
                      </span>
                      <div>
                        <p className="text-sm font-semibold text-foreground">{job.device}</p>
                        <p className="text-xs text-muted-foreground">{job.config}</p>
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
                      <span className="inline-flex items-center gap-1">
                        <Clock className="h-3.5 w-3.5" /> {job.started ?? '--'}
                      </span>
                      <span>Duration: {job.duration ?? '--'}</span>
                      <span>Size: {job.size ?? '--'}</span>
                      <span className="text-foreground">{status.label}</span>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        <div className="rounded-lg border bg-card p-5 shadow-sm">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-base font-semibold text-foreground">Storage by Provider</h3>
              <p className="text-sm text-muted-foreground">Current usage and capacity.</p>
            </div>
            <TrendingUp className="h-5 w-5 text-muted-foreground" />
          </div>
          <div className="mt-4 space-y-4">
            {storageProviders.length === 0 ? (
              <div className="rounded-md border border-dashed bg-muted/30 p-4 text-sm text-muted-foreground">
                No storage usage data available.
              </div>
            ) : (
              storageProviders.map((provider) => {
                const percent = resolveProviderPercent(provider);
                const color = resolveProviderColor(provider.name);
                return (
                  <div key={provider.id ?? provider.name} className="space-y-2">
                    <div className="flex items-center justify-between text-sm">
                      <span className="font-medium text-foreground">{provider.name}</span>
                      <span className="text-xs text-muted-foreground">
                        {provider.used ?? '--'} / {provider.total ?? '--'}
                      </span>
                    </div>
                    <div className="h-2 w-full rounded-full bg-muted">
                      <div className={cn('h-2 rounded-full', color)} style={{ width: `${percent}%` }} />
                    </div>
                  </div>
                );
              })
            )}
            {usageHistoryError ? (
              <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
                {usageHistoryError}
              </div>
            ) : usageHistory.length === 0 ? (
              <div className="rounded-md border border-dashed bg-muted/40 p-3 text-xs text-muted-foreground">
                No usage history data available yet.
              </div>
            ) : (
              <UsageHistoryChart points={usageHistory} />
            )}
          </div>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="rounded-lg border bg-card p-5 shadow-sm">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-base font-semibold text-foreground">Devices Needing Backup</h3>
              <p className="text-sm text-muted-foreground">Overdue based on schedule.</p>
            </div>
            <AlertTriangle className="h-5 w-5 text-warning" />
          </div>
          <div className="mt-4 space-y-3">
            {overdueDevices.length === 0 ? (
              <div className="rounded-md border border-dashed bg-muted/30 p-4 text-sm text-muted-foreground">
                No overdue devices found.
              </div>
            ) : (
              overdueDevices.map((device) => (
                <div
                  key={device.id ?? device.name}
                  className="flex items-center justify-between gap-3 rounded-md border border-dashed bg-muted/30 px-4 py-3"
                >
                  <div>
                    <p className="text-sm font-semibold text-foreground">{device.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {device.owner ?? 'Unassigned'} {device.schedule ? `- ${device.schedule}` : ''}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-xs text-muted-foreground">Last backup</p>
                    <p className="text-sm font-medium text-destructive">
                      {device.lastBackup ?? '--'}
                    </p>
                  </div>
                </div>
              ))
            )}
          </div>
          <button className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-md border bg-card px-4 py-2 text-sm font-medium hover:bg-accent">
            <PlayCircle className="h-4 w-4" />
            Run overdue backups
          </button>
        </div>

        <div className="rounded-lg border bg-card p-5 shadow-sm lg:col-span-2">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-base font-semibold text-foreground">Attention Needed</h3>
              <p className="text-sm text-muted-foreground">
                Alerts for backup performance and coverage.
              </p>
            </div>
            <button className="text-sm font-medium text-primary hover:text-primary/80">
              Resolve all
            </button>
          </div>
          <div className="mt-4 grid gap-3 md:grid-cols-2">
            {attentionItems.length === 0 ? (
              <div className="rounded-md border border-dashed bg-muted/30 p-4 text-sm text-muted-foreground md:col-span-2">
                No active alerts right now.
              </div>
            ) : (
              attentionItems.map((item) => {
                const severity = item.severity ?? 'warning';
                const Icon = attentionIconMap[severity] ?? AlertTriangle;
                return (
                  <div key={item.id ?? item.title} className="rounded-md border border-dashed bg-muted/30 p-4">
                    <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                      <Icon
                        className={cn(
                          'h-4 w-4',
                          severity === 'critical' && 'text-destructive',
                          severity === 'warning' && 'text-warning',
                          severity === 'info' && 'text-amber-500',
                          severity === 'success' && 'text-success'
                        )}
                      />
                      {item.title}
                    </div>
                    {item.description && (
                      <p className="mt-1 text-xs text-muted-foreground">{item.description}</p>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
