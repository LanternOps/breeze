import { useCallback, useEffect, useState } from 'react';
import {
  CheckCircle2,
  Clock,
  HardDrive,
  History,
  PlayCircle,
  ShieldAlert,
  XCircle
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { fetchWithAuth } from '../../stores/auth';

type DeviceBackupStatusProps = {
  deviceId?: string;
};

type DeviceBackupStatusData = {
  deviceId?: string;
  deviceName?: string;
  policyName?: string;
  status?: 'healthy' | 'warning' | 'failed';
  lastBackup?: string;
  lastBackupStatus?: string;
  nextScheduled?: string;
  storageUsed?: string;
  restorePoints?: number;
  protectionTier?: string;
  retention?: string;
  encryption?: string;
};

const statusConfig = {
  healthy: {
    label: 'Healthy',
    className: 'text-success bg-success/10',
    icon: CheckCircle2
  },
  warning: {
    label: 'Needs Attention',
    className: 'text-warning bg-warning/10',
    icon: ShieldAlert
  },
  failed: {
    label: 'Failed',
    className: 'text-destructive bg-destructive/10',
    icon: XCircle
  }
};

export default function DeviceBackupStatus({ deviceId }: DeviceBackupStatusProps) {
  const [statusData, setStatusData] = useState<DeviceBackupStatusData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();

  const fetchStatus = useCallback(async () => {
    if (!deviceId) {
      return;
    }
    try {
      setLoading(true);
      setError(undefined);
      const response = await fetchWithAuth(`/backup/status/${deviceId}`);
      if (!response.ok) {
        throw new Error('Failed to fetch device backup status');
      }
      const payload = await response.json();
      const data = payload?.data ?? payload ?? {};
      setStatusData(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }, [deviceId]);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  if (!deviceId) {
    return (
      <div className="rounded-lg border border-dashed bg-muted/20 p-6 text-center text-sm text-muted-foreground">
        Select a device to view backup status.
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-center">
          <div className="mx-auto h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          <p className="mt-4 text-sm text-muted-foreground">Loading device backup status...</p>
        </div>
      </div>
    );
  }

  if (error && !statusData) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
        <p className="text-sm text-destructive">{error}</p>
        <button
          type="button"
          onClick={fetchStatus}
          className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          Try again
        </button>
      </div>
    );
  }

  const statusKey = statusData?.status ?? 'warning';
  const status = statusConfig[statusKey] ?? statusConfig.warning;
  const StatusIcon = status.icon;
  const lastBackupLabel = statusData?.lastBackup
    ? `${statusData.lastBackup}${statusData.lastBackupStatus ? ` - ${statusData.lastBackupStatus}` : ''}`
    : '--';
  const storageLabel = statusData?.storageUsed
    ? `${statusData.storageUsed}${statusData.restorePoints ? ` - ${statusData.restorePoints} restore points` : ''}`
    : '--';
  const protectionLabel = [
    statusData?.protectionTier,
    statusData?.encryption,
    statusData?.retention
  ]
    .filter(Boolean)
    .join(' - ') || '--';

  return (
    <div className="rounded-lg border bg-card p-5 shadow-sm space-y-4">
      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold text-foreground">
            {statusData?.deviceName ?? deviceId}
          </h3>
          <p className="text-sm text-muted-foreground">
            {statusData?.policyName ?? 'Backup policy'}
          </p>
        </div>
        <span
          className={cn(
            'inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-medium',
            status.className
          )}
        >
          <StatusIcon className="h-3.5 w-3.5" />
          {status.label}
        </span>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="rounded-md border border-dashed bg-muted/30 p-4">
          <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <Clock className="h-4 w-4 text-primary" />
            Last backup
          </div>
          <p className="mt-2 text-xs text-muted-foreground">{lastBackupLabel}</p>
        </div>
        <div className="rounded-md border border-dashed bg-muted/30 p-4">
          <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <History className="h-4 w-4 text-primary" />
            Next scheduled
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            {statusData?.nextScheduled ?? '--'}
          </p>
        </div>
        <div className="rounded-md border border-dashed bg-muted/30 p-4">
          <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <HardDrive className="h-4 w-4 text-primary" />
            Storage used
          </div>
          <p className="mt-2 text-xs text-muted-foreground">{storageLabel}</p>
        </div>
        <div className="rounded-md border border-dashed bg-muted/30 p-4">
          <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <ShieldAlert className="h-4 w-4 text-primary" />
            Protection tier
          </div>
          <p className="mt-2 text-xs text-muted-foreground">{protectionLabel}</p>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <button className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90">
          <PlayCircle className="h-4 w-4" />
          Run quick backup
        </button>
        <button className="inline-flex items-center gap-2 rounded-md border px-4 py-2 text-sm font-medium text-muted-foreground hover:bg-accent">
          View history
        </button>
      </div>
    </div>
  );
}
