import { useCallback, useEffect, useState } from 'react';
import {
  Activity,
  Globe,
  Network,
  Wifi,
  Server,
  CheckCircle,
  XCircle,
  AlertTriangle,
  HelpCircle,
  RefreshCw,
  Plus,
  Settings,
  Trash2,
  Play,
  Loader2
} from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';
import CreateMonitorForm from './CreateMonitorForm';
import MonitorDetailModal from './MonitorDetailModal';

type NetworkMonitor = {
  id: string;
  orgId: string;
  assetId: string | null;
  name: string;
  monitorType: string;
  target: string;
  config: Record<string, unknown>;
  pollingInterval: number;
  timeout: number;
  isActive: boolean;
  lastChecked: string | null;
  lastStatus: string;
  lastResponseMs: number | null;
  lastError: string | null;
  consecutiveFailures: number;
  createdAt: string;
  updatedAt: string;
};

const typeIcons: Record<string, typeof Activity> = {
  icmp_ping: Wifi,
  tcp_port: Server,
  http_check: Globe,
  dns_check: Network
};

const typeLabels: Record<string, string> = {
  icmp_ping: 'ICMP Ping',
  tcp_port: 'TCP Port',
  http_check: 'HTTP',
  dns_check: 'DNS'
};

const statusConfig: Record<string, { icon: typeof CheckCircle; color: string; label: string }> = {
  online: { icon: CheckCircle, color: 'text-green-600 bg-green-500/20 border-green-500/40', label: 'Online' },
  offline: { icon: XCircle, color: 'text-red-600 bg-red-500/20 border-red-500/40', label: 'Offline' },
  degraded: { icon: AlertTriangle, color: 'text-yellow-600 bg-yellow-500/20 border-yellow-500/40', label: 'Degraded' },
  unknown: { icon: HelpCircle, color: 'text-muted-foreground bg-muted border-muted', label: 'Unknown' }
};

function formatRelativeTime(dateString: string | null) {
  if (!dateString) return 'Never';
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return dateString;
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / (1000 * 60));
  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

function formatInterval(seconds: number) {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h`;
}

export default function NetworkMonitorList() {
  const [monitors, setMonitors] = useState<NetworkMonitor[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [detailMonitorId, setDetailMonitorId] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [filterType, setFilterType] = useState<string>('');
  const [filterStatus, setFilterStatus] = useState<string>('');

  const fetchMonitors = useCallback(async () => {
    try {
      setLoading(true);
      setError(undefined);
      const params = new URLSearchParams();
      if (filterType) params.set('monitorType', filterType);
      if (filterStatus) params.set('status', filterStatus);
      const qs = params.toString();
      const response = await fetchWithAuth(`/monitors${qs ? `?${qs}` : ''}`);
      if (!response.ok) throw new Error('Failed to fetch monitors');
      const data = await response.json();
      setMonitors(data.data ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }, [filterType, filterStatus]);

  useEffect(() => {
    fetchMonitors();
  }, [fetchMonitors]);

  const handleCheck = async (monitorId: string) => {
    setActionLoading(monitorId);
    try {
      const res = await fetchWithAuth(`/monitors/${monitorId}/check`, { method: 'POST' });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error ?? 'Failed to trigger check');
      }
      setTimeout(() => fetchMonitors(), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setActionLoading(null);
    }
  };

  const handleDelete = async (monitorId: string) => {
    if (!confirm('Delete this monitor? This will also remove all results and alert rules.')) return;
    setActionLoading(monitorId);
    try {
      const res = await fetchWithAuth(`/monitors/${monitorId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete monitor');
      await fetchMonitors();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setActionLoading(null);
    }
  };

  if (loading && monitors.length === 0) {
    return (
      <div className="flex items-center justify-center rounded-lg border bg-card p-10 shadow-sm">
        <div className="text-center">
          <div className="mx-auto h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          <p className="mt-4 text-sm text-muted-foreground">Loading monitors...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <select
            value={filterType}
            onChange={(e) => setFilterType(e.target.value)}
            className="h-9 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          >
            <option value="">All Types</option>
            <option value="icmp_ping">ICMP Ping</option>
            <option value="tcp_port">TCP Port</option>
            <option value="http_check">HTTP Check</option>
            <option value="dns_check">DNS Check</option>
          </select>
          <select
            value={filterStatus}
            onChange={(e) => setFilterStatus(e.target.value)}
            className="h-9 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          >
            <option value="">All Status</option>
            <option value="online">Online</option>
            <option value="offline">Offline</option>
            <option value="degraded">Degraded</option>
            <option value="unknown">Unknown</option>
          </select>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={fetchMonitors}
            className="flex h-9 items-center gap-2 rounded-md border px-3 text-sm text-muted-foreground hover:text-foreground"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Refresh
          </button>
          <button
            type="button"
            onClick={() => setShowCreateForm(true)}
            className="flex h-9 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            <Plus className="h-4 w-4" />
            Add Monitor
          </button>
        </div>
      </div>

      <div className="overflow-hidden rounded-md border">
        <table className="min-w-full divide-y">
          <thead className="bg-muted/40">
            <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-3">Name</th>
              <th className="px-4 py-3">Type</th>
              <th className="px-4 py-3">Target</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Response</th>
              <th className="px-4 py-3">Interval</th>
              <th className="px-4 py-3">Last Checked</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {monitors.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-4 py-6 text-center text-sm text-muted-foreground">
                  No network monitors configured.{' '}
                  <button
                    type="button"
                    onClick={() => setShowCreateForm(true)}
                    className="text-primary underline-offset-2 hover:underline"
                  >
                    Create one now.
                  </button>
                </td>
              </tr>
            ) : (
              monitors.map((monitor) => {
                const TypeIcon = typeIcons[monitor.monitorType] ?? Activity;
                const sc = statusConfig[monitor.lastStatus] ?? statusConfig.unknown;
                const StatusIcon = sc.icon;
                const isLoadingAction = actionLoading === monitor.id;

                return (
                  <tr
                    key={monitor.id}
                    className={`transition hover:bg-muted/40 ${!monitor.isActive ? 'opacity-60' : ''}`}
                  >
                    <td className="px-4 py-3">
                      <button
                        type="button"
                        onClick={() => setDetailMonitorId(monitor.id)}
                        className="text-sm font-medium text-primary hover:underline text-left"
                      >
                        {monitor.name}
                      </button>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5">
                        <TypeIcon className="h-3.5 w-3.5 text-muted-foreground" />
                        <span className="text-sm">{typeLabels[monitor.monitorType] ?? monitor.monitorType}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-sm font-mono text-muted-foreground max-w-[200px] truncate" title={monitor.target}>
                      {monitor.target}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium ${sc.color}`}>
                        <StatusIcon className="h-3 w-3" />
                        {sc.label}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-sm text-muted-foreground">
                      {monitor.lastResponseMs != null ? `${Math.round(monitor.lastResponseMs)}ms` : '—'}
                    </td>
                    <td className="px-4 py-3 text-sm text-muted-foreground">
                      {formatInterval(monitor.pollingInterval)}
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">
                      {formatRelativeTime(monitor.lastChecked)}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          type="button"
                          onClick={() => handleCheck(monitor.id)}
                          disabled={isLoadingAction}
                          className="flex h-8 w-8 items-center justify-center rounded-md border hover:bg-muted disabled:opacity-50"
                          title="Run check now"
                        >
                          {isLoadingAction ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                        </button>
                        <button
                          type="button"
                          onClick={() => setDetailMonitorId(monitor.id)}
                          className="flex h-8 w-8 items-center justify-center rounded-md border hover:bg-muted"
                          title="View details"
                        >
                          <Settings className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDelete(monitor.id)}
                          disabled={isLoadingAction}
                          className="flex h-8 w-8 items-center justify-center rounded-md border hover:bg-muted hover:text-destructive disabled:opacity-50"
                          title="Delete monitor"
                        >
                          <Trash2 className="h-4 w-4" />
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

      {showCreateForm && (
        <CreateMonitorForm
          onCreated={() => {
            setShowCreateForm(false);
            fetchMonitors();
          }}
          onCancel={() => setShowCreateForm(false)}
        />
      )}

      {detailMonitorId && (
        <MonitorDetailModal
          monitorId={detailMonitorId}
          onClose={() => setDetailMonitorId(null)}
          onDeleted={() => {
            setDetailMonitorId(null);
            fetchMonitors();
          }}
          onUpdated={fetchMonitors}
        />
      )}
    </div>
  );
}
