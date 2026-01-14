import { useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle, PauseCircle, PlayCircle, XCircle } from 'lucide-react';
import { cn } from '@/lib/utils';

type DeploymentStatus = 'pending' | 'running' | 'completed' | 'failed' | 'paused' | 'canceled';

type DeploymentType = 'manual' | 'scheduled' | 'maintenance';

type DeploymentRecord = {
  id: string;
  name: string;
  software: string;
  type: DeploymentType;
  status: DeploymentStatus;
  progress: number;
  createdAt: string;
  createdBy: string;
};

const statusConfig: Record<DeploymentStatus, { label: string; color: string; icon: typeof PlayCircle }> = {
  pending: { label: 'Pending', color: 'bg-yellow-500/20 text-yellow-700 border-yellow-500/40', icon: PlayCircle },
  running: { label: 'Running', color: 'bg-blue-500/20 text-blue-700 border-blue-500/40', icon: PlayCircle },
  completed: { label: 'Completed', color: 'bg-emerald-500/20 text-emerald-700 border-emerald-500/40', icon: CheckCircle },
  failed: { label: 'Failed', color: 'bg-red-500/20 text-red-700 border-red-500/40', icon: AlertTriangle },
  paused: { label: 'Paused', color: 'bg-gray-500/20 text-gray-700 border-gray-500/40', icon: PauseCircle },
  canceled: { label: 'Canceled', color: 'bg-slate-500/20 text-slate-700 border-slate-500/40', icon: XCircle }
};

const deployments: DeploymentRecord[] = [
  {
    id: 'dep-1001',
    name: 'Chrome March Rollout',
    software: 'Google Chrome 122',
    type: 'scheduled',
    status: 'running',
    progress: 64,
    createdAt: '2024-03-18',
    createdBy: 'Jordan Lee'
  },
  {
    id: 'dep-1002',
    name: '7-Zip Utility Update',
    software: '7-Zip 23.01',
    type: 'manual',
    status: 'pending',
    progress: 0,
    createdAt: '2024-03-20',
    createdBy: 'Priya Patel'
  },
  {
    id: 'dep-1003',
    name: 'VS Code Dev Team',
    software: 'VS Code 1.87.2',
    type: 'maintenance',
    status: 'completed',
    progress: 100,
    createdAt: '2024-03-10',
    createdBy: 'Jules Nguyen'
  },
  {
    id: 'dep-1004',
    name: 'Firefox Emergency Patch',
    software: 'Firefox 124',
    type: 'manual',
    status: 'failed',
    progress: 42,
    createdAt: '2024-03-14',
    createdBy: 'Avery Cole'
  },
  {
    id: 'dep-1005',
    name: 'Zoom Client Maintenance',
    software: 'Zoom 5.17.2',
    type: 'maintenance',
    status: 'paused',
    progress: 28,
    createdAt: '2024-03-12',
    createdBy: 'Sam Rivera'
  }
];

function formatDate(dateString: string): string {
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return dateString;
  return date.toLocaleDateString();
}

export default function DeploymentList() {
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  const filteredDeployments = useMemo(() => {
    return deployments.filter(item => {
      const matchesStatus = statusFilter === 'all' ? true : item.status === statusFilter;
      const matchesType = typeFilter === 'all' ? true : item.type === typeFilter;
      const itemDate = new Date(item.createdAt).getTime();
      const fromDate = dateFrom ? new Date(dateFrom).getTime() : null;
      const toDate = dateTo ? new Date(dateTo).getTime() : null;
      const matchesFrom = fromDate ? itemDate >= fromDate : true;
      const matchesTo = toDate ? itemDate <= toDate : true;
      return matchesStatus && matchesType && matchesFrom && matchesTo;
    });
  }, [statusFilter, typeFilter, dateFrom, dateTo]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Deployments</h1>
        <p className="text-sm text-muted-foreground">Monitor progress and manage deployment workflows.</p>
      </div>

      <div className="flex flex-col gap-3 rounded-lg border bg-card p-4 shadow-sm lg:flex-row lg:items-end">
        <div className="flex-1">
          <label className="text-xs font-semibold uppercase text-muted-foreground">Status</label>
          <select
            value={statusFilter}
            onChange={event => setStatusFilter(event.target.value)}
            className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          >
            <option value="all">All statuses</option>
            <option value="pending">Pending</option>
            <option value="running">Running</option>
            <option value="completed">Completed</option>
            <option value="failed">Failed</option>
            <option value="paused">Paused</option>
            <option value="canceled">Canceled</option>
          </select>
        </div>
        <div className="flex-1">
          <label className="text-xs font-semibold uppercase text-muted-foreground">Type</label>
          <select
            value={typeFilter}
            onChange={event => setTypeFilter(event.target.value)}
            className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          >
            <option value="all">All types</option>
            <option value="manual">Manual</option>
            <option value="scheduled">Scheduled</option>
            <option value="maintenance">Maintenance</option>
          </select>
        </div>
        <div className="flex-1">
          <label className="text-xs font-semibold uppercase text-muted-foreground">From</label>
          <input
            type="date"
            value={dateFrom}
            onChange={event => setDateFrom(event.target.value)}
            className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>
        <div className="flex-1">
          <label className="text-xs font-semibold uppercase text-muted-foreground">To</label>
          <input
            type="date"
            value={dateTo}
            onChange={event => setDateTo(event.target.value)}
            className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>
      </div>

      <div className="rounded-lg border bg-card p-6 shadow-sm">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold">Deployment List</h2>
            <p className="text-sm text-muted-foreground">{filteredDeployments.length} deployments found.</p>
          </div>
        </div>

        <div className="mt-5 overflow-hidden rounded-md border">
          <table className="min-w-full divide-y">
            <thead className="bg-muted/40">
              <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3">Software</th>
                <th className="px-4 py-3">Type</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Progress</th>
                <th className="px-4 py-3">Created</th>
                <th className="px-4 py-3">Created by</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {filteredDeployments.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-4 py-6 text-center text-sm text-muted-foreground">
                    No deployments match your filters.
                  </td>
                </tr>
              ) : (
                filteredDeployments.map(item => {
                  const status = statusConfig[item.status];
                  const StatusIcon = status.icon;

                  return (
                    <tr key={item.id} className="text-sm">
                      <td className="px-4 py-3">
                        <p className="font-medium text-foreground">{item.name}</p>
                        <p className="text-xs text-muted-foreground">{item.id}</p>
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">{item.software}</td>
                      <td className="px-4 py-3">
                        <span className="rounded-full border px-2 py-1 text-xs font-medium text-muted-foreground">
                          {item.type}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <span className={cn('inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium', status.color)}>
                          <StatusIcon className="h-3.5 w-3.5" />
                          {status.label}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        {item.status === 'running' ? (
                          <div className="flex items-center gap-2">
                            <div className="h-2 w-24 rounded-full bg-muted">
                              <div className="h-2 rounded-full bg-primary" style={{ width: `${item.progress}%` }} />
                            </div>
                            <span className="text-xs text-muted-foreground">{item.progress}%</span>
                          </div>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">{formatDate(item.createdAt)}</td>
                      <td className="px-4 py-3 text-muted-foreground">{item.createdBy}</td>
                      <td className="px-4 py-3 text-right">
                        {item.status === 'pending' ? (
                          <button
                            type="button"
                            className="inline-flex h-8 items-center justify-center rounded-md border px-3 text-xs font-medium text-destructive hover:bg-destructive/10"
                          >
                            Cancel
                          </button>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
