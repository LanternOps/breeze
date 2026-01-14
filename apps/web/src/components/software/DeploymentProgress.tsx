import { useMemo } from 'react';
import { Activity, AlertTriangle, RefreshCcw } from 'lucide-react';
import { cn } from '@/lib/utils';

type DeviceStatus = 'queued' | 'running' | 'completed' | 'failed';

type DeviceProgress = {
  id: string;
  name: string;
  status: DeviceStatus;
  startedAt?: string;
  completedAt?: string;
  error?: string;
};

const statusStyles: Record<DeviceStatus, { label: string; color: string }> = {
  queued: { label: 'Queued', color: 'bg-slate-500/20 text-slate-700 border-slate-500/40' },
  running: { label: 'Running', color: 'bg-blue-500/20 text-blue-700 border-blue-500/40' },
  completed: { label: 'Completed', color: 'bg-emerald-500/20 text-emerald-700 border-emerald-500/40' },
  failed: { label: 'Failed', color: 'bg-red-500/20 text-red-700 border-red-500/40' }
};

const deviceProgress: DeviceProgress[] = [
  {
    id: 'dev-fin-021',
    name: 'FIN-LT-021',
    status: 'completed',
    startedAt: '2024-03-18 09:12',
    completedAt: '2024-03-18 09:18'
  },
  {
    id: 'dev-fin-024',
    name: 'FIN-DT-024',
    status: 'running',
    startedAt: '2024-03-18 09:14'
  },
  {
    id: 'dev-hr-011',
    name: 'HR-MB-011',
    status: 'queued'
  },
  {
    id: 'dev-hr-012',
    name: 'HR-MB-012',
    status: 'failed',
    startedAt: '2024-03-18 09:10',
    completedAt: '2024-03-18 09:15',
    error: 'Insufficient disk space'
  }
];

export default function DeploymentProgress() {
  const stats = useMemo(() => {
    const total = deviceProgress.length;
    const completed = deviceProgress.filter(item => item.status === 'completed').length;
    const running = deviceProgress.filter(item => item.status === 'running').length;
    const failed = deviceProgress.filter(item => item.status === 'failed').length;
    const queued = deviceProgress.filter(item => item.status === 'queued').length;
    const progress = total > 0 ? Math.round((completed / total) * 100) : 0;

    return { total, completed, running, failed, queued, progress };
  }, []);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold">Deployment Progress</h1>
          <p className="text-sm text-muted-foreground">Chrome 122 · Finance rollout</p>
        </div>
        <div className="flex items-center gap-2 rounded-full border px-3 py-1 text-xs text-muted-foreground">
          <Activity className="h-3.5 w-3.5 text-emerald-500" />
          Live updates enabled
        </div>
      </div>

      <div className="rounded-lg border bg-card p-6 shadow-sm">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-semibold">Overall progress</p>
            <p className="text-xs text-muted-foreground">{stats.completed} of {stats.total} devices completed</p>
          </div>
          <div className="text-right">
            <p className="text-2xl font-semibold">{stats.progress}%</p>
            <p className="text-xs text-muted-foreground">Deployment complete</p>
          </div>
        </div>
        <div className="mt-4 h-3 w-full rounded-full bg-muted">
          <div className="h-3 rounded-full bg-primary" style={{ width: `${stats.progress}%` }} />
        </div>

        <div className="mt-4 grid gap-4 sm:grid-cols-4">
          <div className="rounded-md border bg-muted/30 p-4">
            <p className="text-xs uppercase text-muted-foreground">Completed</p>
            <p className="mt-2 text-lg font-semibold">{stats.completed}</p>
          </div>
          <div className="rounded-md border bg-muted/30 p-4">
            <p className="text-xs uppercase text-muted-foreground">Running</p>
            <p className="mt-2 text-lg font-semibold">{stats.running}</p>
          </div>
          <div className="rounded-md border bg-muted/30 p-4">
            <p className="text-xs uppercase text-muted-foreground">Queued</p>
            <p className="mt-2 text-lg font-semibold">{stats.queued}</p>
          </div>
          <div className="rounded-md border bg-muted/30 p-4">
            <p className="text-xs uppercase text-muted-foreground">Failed</p>
            <p className="mt-2 text-lg font-semibold text-destructive">{stats.failed}</p>
          </div>
        </div>

        <div className="mt-4 flex items-center justify-end">
          <button
            type="button"
            className="inline-flex h-9 items-center justify-center gap-2 rounded-md border bg-background px-4 text-sm font-medium hover:bg-muted"
          >
            <RefreshCcw className="h-4 w-4" />
            Retry failed
          </button>
        </div>
      </div>

      <div className="rounded-lg border bg-card p-6 shadow-sm">
        <h2 className="text-lg font-semibold">Per-device status</h2>
        <p className="text-sm text-muted-foreground">Track status updates as devices report back.</p>

        <div className="mt-4 overflow-hidden rounded-md border">
          <table className="min-w-full divide-y">
            <thead className="bg-muted/40">
              <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-3">Device</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Started</th>
                <th className="px-4 py-3">Completed</th>
                <th className="px-4 py-3">Error</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {deviceProgress.map(device => (
                <tr key={device.id} className="text-sm">
                  <td className="px-4 py-3 font-medium text-foreground">{device.name}</td>
                  <td className="px-4 py-3">
                    <span
                      className={cn(
                        'inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium',
                        statusStyles[device.status].color
                      )}
                    >
                      {statusStyles[device.status].label}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{device.startedAt ?? '—'}</td>
                  <td className="px-4 py-3 text-muted-foreground">{device.completedAt ?? '—'}</td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {device.error ? (
                      <span className="inline-flex items-center gap-1 text-xs text-destructive">
                        <AlertTriangle className="h-3.5 w-3.5" />
                        {device.error}
                      </span>
                    ) : (
                      '—'
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
