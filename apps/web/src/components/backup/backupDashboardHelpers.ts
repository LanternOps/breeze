import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Database,
  HardDrive,
  ShieldAlert,
  XCircle
} from 'lucide-react';

// ── Types ──────────────────────────────────────────────────────────

export type StatChangeType = 'positive' | 'negative' | 'neutral';

export type BackupStat = {
  id?: string;
  name?: string;
  value?: string | number;
  change?: string;
  changeType?: StatChangeType;
};

export type BackupJob = {
  id: string;
  deviceId?: string;
  deviceName?: string | null;
  configId?: string;
  configName?: string | null;
  status: string;
  startedAt?: string | null;
  completedAt?: string | null;
  totalSize?: number | null;
  errorCount?: number | null;
  errorLog?: string | null;
  // Legacy fields for compatibility
  device?: string;
  config?: string;
  started?: string;
  duration?: string;
  size?: string;
};

export type OverdueDevice = {
  id?: string;
  name: string;
  lastBackup?: string;
  schedule?: string;
  owner?: string;
};

export type StorageProvider = {
  id?: string;
  name: string;
  used?: string | number;
  total?: string | number;
  percent?: number;
};

export type AttentionItem = {
  id?: string;
  title: string;
  description?: string;
  severity?: 'warning' | 'critical' | 'info' | 'success';
};

export type UsageHistoryProvider = {
  provider: string;
  bytes: number;
};

export type UsageHistoryPoint = {
  timestamp: string;
  totalBytes?: number;
  providers: UsageHistoryProvider[];
};

// ── Static config maps ─────────────────────────────────────────────

export const statusConfig = {
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
} as const;

export type StatusConfigKey = keyof typeof statusConfig;

export const statIconMap: Record<string, typeof Database> = {
  total_backups: Database,
  backups: Database,
  success_rate: CheckCircle2,
  success: CheckCircle2,
  storage_used: HardDrive,
  storage: HardDrive,
  devices_covered: ShieldAlert,
  devices: ShieldAlert
};

export const providerColorMap: Record<string, string> = {
  'aws s3': 'bg-success',
  's3': 'bg-success',
  'azure blob': 'bg-primary',
  'azure': 'bg-primary',
  'local vault': 'bg-warning',
  'local': 'bg-warning',
  wasabi: 'bg-[hsl(var(--chart-4,262_80%_50%))]'
};

export const providerStrokeMap: Record<string, string> = {
  'aws s3': 'hsl(var(--success))',
  's3': 'hsl(var(--success))',
  'azure blob': 'hsl(var(--primary))',
  'azure': 'hsl(var(--primary))',
  'local vault': 'hsl(var(--warning))',
  'local': 'hsl(var(--warning))',
  wasabi: 'hsl(var(--chart-4,262 80% 50%))'
};

export const attentionIconMap: Record<string, typeof AlertTriangle> = {
  warning: AlertTriangle,
  critical: XCircle,
  info: HardDrive,
  success: CheckCircle2
};

// ── Helper functions ───────────────────────────────────────────────

export function resolveProviderColor(name: string): string {
  const key = name.toLowerCase();
  return providerColorMap[key] ?? 'bg-primary';
}

export function resolveProviderStroke(name: string): string {
  const key = name.toLowerCase();
  return providerStrokeMap[key] ?? 'hsl(var(--primary))';
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

export function parseUsageHistory(payload: unknown): UsageHistoryPoint[] {
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
      : providers.reduce((sum, p) => sum + p.bytes, 0);

    parsed.push({
      timestamp,
      totalBytes: Math.max(0, totalBytes),
      providers
    });
  }

  return parsed;
}

export function formatBytes(bytes: number): string {
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

export function formatTime(iso?: string | null): string {
  if (!iso) return '--';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '--';
  return date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function formatDuration(startedAt?: string | null, completedAt?: string | null): string {
  if (!startedAt) return '--';
  const start = new Date(startedAt).getTime();
  if (Number.isNaN(start)) return '--';
  const end = completedAt ? new Date(completedAt).getTime() : Date.now();
  if (Number.isNaN(end)) return '--';
  const seconds = Math.max(0, Math.floor((end - start) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function resolveJobDevice(job: BackupJob): string {
  return job.deviceName ?? job.device ?? job.deviceId?.slice(0, 8) ?? '--';
}

export function resolveJobConfig(job: BackupJob): string {
  return job.configName ?? job.config ?? '--';
}

export function resolveJobStarted(job: BackupJob): string {
  return formatTime(job.startedAt) || job.started || '--';
}

export function resolveJobDuration(job: BackupJob): string {
  if (job.startedAt) return formatDuration(job.startedAt, job.completedAt);
  return job.duration ?? '--';
}

export function resolveJobSize(job: BackupJob): string {
  if (typeof job.totalSize === 'number' && job.totalSize > 0) return formatBytes(job.totalSize);
  return job.size ?? '--';
}

export function buildLinePath(values: number[], maxValue: number): string {
  if (values.length === 0) return '';

  return values
    .map((value, index) => {
      const x = values.length === 1 ? 50 : (index / (values.length - 1)) * 100;
      const y = 100 - (value / maxValue) * 100;
      return `${x},${Math.max(0, Math.min(100, y))}`;
    })
    .join(' ');
}
