import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Cloud,
  HardDrive,
  Pencil,
  Plus,
  RefreshCw,
  Server,
  Trash2,
  XCircle
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { fetchWithAuth } from '../../stores/auth';

type BackupConfig = {
  id: string;
  name: string;
  type: 'file' | 'image' | 'database';
  provider: 's3' | 'azure' | 'local';
  schedule: string;
  devices: number;
  lastRun: string;
  status: 'healthy' | 'warning' | 'offline';
};

const providerIcon = {
  s3: Cloud,
  azure: Server,
  local: HardDrive
};

const providerLabel = {
  s3: 'AWS S3',
  azure: 'Azure Blob',
  local: 'Local Vault'
};

const statusConfig = {
  healthy: {
    label: 'Healthy',
    icon: CheckCircle2,
    className: 'text-success bg-success/10'
  },
  warning: {
    label: 'Needs Attention',
    icon: AlertTriangle,
    className: 'text-warning bg-warning/10'
  },
  offline: {
    label: 'Offline',
    icon: XCircle,
    className: 'text-destructive bg-destructive/10'
  }
};

export default function BackupConfigList() {
  const [configs, setConfigs] = useState<BackupConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  const fetchConfigs = useCallback(async () => {
    try {
      setLoading(true);
      setError(undefined);
      const response = await fetchWithAuth('/backup/configs');
      if (!response.ok) {
        throw new Error('Failed to fetch backup configurations');
      }
      const payload = await response.json();
      const data = payload?.data ?? payload ?? [];
      setConfigs(Array.isArray(data) ? data : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchConfigs();
  }, [fetchConfigs]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="text-center">
          <div className="mx-auto h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          <p className="mt-4 text-sm text-muted-foreground">Loading configurations...</p>
        </div>
      </div>
    );
  }

  if (error && configs.length === 0) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
        <p className="text-sm text-destructive">{error}</p>
        <button
          type="button"
          onClick={fetchConfigs}
          className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          Try again
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-foreground">Backup Configurations</h2>
          <p className="text-sm text-muted-foreground">
            Manage provider connections, schedules, and coverage.
          </p>
        </div>
        <button className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-sm hover:bg-primary/90">
          <Plus className="h-4 w-4" />
          Add new config
        </button>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="overflow-hidden rounded-lg border bg-card shadow-sm">
        <table className="w-full">
          <thead className="bg-muted/40 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-4 py-3">Name</th>
              <th className="px-4 py-3">Type</th>
              <th className="px-4 py-3">Provider</th>
              <th className="px-4 py-3">Schedule</th>
              <th className="px-4 py-3 text-center">Devices</th>
              <th className="px-4 py-3">Last Run</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {configs.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-4 py-8 text-center text-sm text-muted-foreground">
                  No backup configurations found.
                </td>
              </tr>
            ) : (
              configs.map((config) => {
                const ProviderIcon = providerIcon[config.provider];
                const status = statusConfig[config.status];
                const StatusIcon = status.icon;
                return (
                  <tr key={config.id} className="text-sm text-foreground">
                    <td className="px-4 py-3">
                      <div>
                        <p className="font-medium text-foreground">{config.name}</p>
                        <p className="text-xs text-muted-foreground">ID: {config.id}</p>
                      </div>
                    </td>
                    <td className="px-4 py-3 capitalize text-muted-foreground">{config.type}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <span className="flex h-8 w-8 items-center justify-center rounded-full bg-muted">
                          <ProviderIcon
                            className={cn(
                              'h-4 w-4',
                              config.provider === 's3' && 'text-emerald-600',
                              config.provider === 'azure' && 'text-sky-600',
                              config.provider === 'local' && 'text-amber-600'
                            )}
                          />
                        </span>
                        <span className="text-sm font-medium">{providerLabel[config.provider]}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{config.schedule}</td>
                    <td className="px-4 py-3 text-center">
                      <span className="inline-flex items-center justify-center rounded-full bg-muted px-2 py-1 text-xs font-medium text-foreground">
                        {config.devices}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{config.lastRun}</td>
                    <td className="px-4 py-3">
                      <span
                        className={cn(
                          'inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs font-medium',
                          status.className
                        )}
                      >
                        <StatusIcon className="h-3.5 w-3.5" />
                        {status.label}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-2">
                        <button className="rounded-md border px-2.5 py-1 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground">
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                        <button className="rounded-md border px-2.5 py-1 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground">
                          <RefreshCw className="h-3.5 w-3.5" />
                        </button>
                        <button className="rounded-md border px-2.5 py-1 text-xs font-medium text-destructive hover:bg-destructive/10">
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
