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

const configs: BackupConfig[] = [
  {
    id: 'cfg-001',
    name: 'Primary SQL S3',
    type: 'database',
    provider: 's3',
    schedule: 'Every 4 hours',
    devices: 42,
    lastRun: '12 min ago',
    status: 'healthy'
  },
  {
    id: 'cfg-002',
    name: 'File Shares - Azure',
    type: 'file',
    provider: 'azure',
    schedule: 'Daily at 2:00 AM',
    devices: 128,
    lastRun: '38 min ago',
    status: 'warning'
  },
  {
    id: 'cfg-003',
    name: 'VM Images Local',
    type: 'image',
    provider: 'local',
    schedule: 'Weekly on Sunday',
    devices: 18,
    lastRun: '2 days ago',
    status: 'healthy'
  },
  {
    id: 'cfg-004',
    name: 'Archive NAS S3',
    type: 'file',
    provider: 's3',
    schedule: 'Monthly on 1st',
    devices: 9,
    lastRun: '11 days ago',
    status: 'offline'
  }
];

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
            {configs.map((config) => {
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
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
