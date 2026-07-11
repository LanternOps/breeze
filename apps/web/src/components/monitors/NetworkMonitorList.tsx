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
import { useOrgStore } from '../../stores/orgStore';
import CreateMonitorForm from './CreateMonitorForm';
import MonitorDetailModal from './MonitorDetailModal';
import { ConfirmDialog } from '../shared/ConfirmDialog';
import { showToast } from '../shared/Toast';
import { useTranslation } from 'react-i18next';

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

const typeLabelKeys: Record<string, string> = {
  icmp_ping: 'longTail.monitors.NetworkMonitorList.types.icmpPing',
  tcp_port: 'longTail.monitors.NetworkMonitorList.types.tcpPort',
  http_check: 'longTail.monitors.NetworkMonitorList.types.httpCheck',
  dns_check: 'longTail.monitors.NetworkMonitorList.types.dnsCheck'
};

const statusConfig: Record<string, { icon: typeof CheckCircle; color: string; labelKey: string }> = {
  online: { icon: CheckCircle, color: 'text-green-600 bg-green-500/20 border-green-500/40', labelKey: 'common:states.online' },
  offline: { icon: XCircle, color: 'text-red-600 bg-red-500/20 border-red-500/40', labelKey: 'common:states.offline' },
  degraded: { icon: AlertTriangle, color: 'text-yellow-600 bg-yellow-500/20 border-yellow-500/40', labelKey: 'longTail.monitors.NetworkMonitorList.status.degraded' },
  unknown: { icon: HelpCircle, color: 'text-muted-foreground bg-muted border-muted', labelKey: 'common:states.unknown' }
};

function formatRelativeTime(dateString: string | null, t: (key: string, options?: Record<string, unknown>) => string) {
  if (!dateString) return t('longTail.monitors.NetworkMonitorList.time.never');
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return dateString;
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / (1000 * 60));
  if (diffMins < 1) return t('longTail.monitors.NetworkMonitorList.time.justNow');
  if (diffMins < 60) return t('longTail.monitors.NetworkMonitorList.time.minutesAgo', { count: diffMins });
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return t('longTail.monitors.NetworkMonitorList.time.hoursAgo', { count: diffHours });
  const diffDays = Math.floor(diffHours / 24);
  return t('longTail.monitors.NetworkMonitorList.time.daysAgo', { count: diffDays });
}

function formatInterval(seconds: number) {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h`;
}

type NetworkMonitorListProps = {
  assetId?: string | null;
};

export default function NetworkMonitorList({ assetId }: NetworkMonitorListProps) {
  const { t } = useTranslation('common');
  const { currentOrgId } = useOrgStore();
  const [monitors, setMonitors] = useState<NetworkMonitor[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [detailMonitorId, setDetailMonitorId] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [filterType, setFilterType] = useState<string>('');
  const [filterStatus, setFilterStatus] = useState<string>('');
  const [filterAssetId, setFilterAssetId] = useState<string | null>(assetId ?? null);
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);

  useEffect(() => {
    setFilterAssetId(assetId ?? null);
  }, [assetId]);

  const fetchMonitors = useCallback(async () => {
    try {
      setLoading(true);
      setError(undefined);
      const params = new URLSearchParams();
      if (filterAssetId) params.set('assetId', filterAssetId);
      else if (currentOrgId) params.set('orgId', currentOrgId);
      if (filterType) params.set('monitorType', filterType);
      if (filterStatus) params.set('status', filterStatus);
      const qs = params.toString();
      const response = await fetchWithAuth(`/monitors${qs ? `?${qs}` : ''}`);
      if (!response.ok) throw new Error(t('longTail.monitors.NetworkMonitorList.errors.fetchMonitors'));
      const data = await response.json();
      setMonitors(data.data ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('longTail.monitors.NetworkMonitorList.errors.generic'));
    } finally {
      setLoading(false);
    }
  }, [filterAssetId, currentOrgId, filterType, filterStatus, t]);

  useEffect(() => {
    fetchMonitors();
  }, [fetchMonitors]);

  const handleCheck = async (monitorId: string) => {
    setActionLoading(monitorId);
    try {
      const res = await fetchWithAuth(`/monitors/${monitorId}/check`, { method: 'POST' });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error ?? t('longTail.monitors.NetworkMonitorList.errors.triggerCheck'));
      }
      setTimeout(() => fetchMonitors(), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('longTail.monitors.NetworkMonitorList.errors.generic'));
    } finally {
      setActionLoading(null);
    }
  };

  const handleDelete = (monitorId: string) => {
    setDeleteTargetId(monitorId);
  };

  const handleConfirmDelete = async () => {
    if (!deleteTargetId) return;
    const monitorId = deleteTargetId;
    setDeleteTargetId(null);
    setActionLoading(monitorId);
    try {
      const res = await fetchWithAuth(`/monitors/${monitorId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(t('longTail.monitors.NetworkMonitorList.errors.deleteMonitor'));
      await fetchMonitors();
      showToast({ message: t('longTail.monitors.NetworkMonitorList.messages.monitorDeleted'), type: 'success' });
    } catch (err) {
      setError(err instanceof Error ? err.message : t('longTail.monitors.NetworkMonitorList.errors.generic'));
    } finally {
      setActionLoading(null);
    }
  };

  if (loading && monitors.length === 0) {
    return (
      <div className="flex items-center justify-center rounded-lg border bg-card p-10 shadow-xs">
        <div className="text-center">
          <div className="mx-auto h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          <p className="mt-4 text-sm text-muted-foreground">{t('longTail.monitors.NetworkMonitorList.loading')}</p>
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

      {filterAssetId && (
        <div className="flex items-center justify-between rounded-md border bg-muted/20 px-4 py-2 text-sm">
          <span className="text-muted-foreground">{t('longTail.monitors.NetworkMonitorList.assetFilter')}</span>
          <button
            type="button"
            onClick={() => setFilterAssetId(null)}
            className="text-primary underline-offset-2 hover:underline"
          >
            {t('common:actions.clear')}
          </button>
        </div>
      )}

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <select
            value={filterType}
            onChange={(e) => setFilterType(e.target.value)}
            className="h-9 rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
          >
            <option value="">{t('longTail.monitors.NetworkMonitorList.filters.allTypes')}</option>
            <option value="icmp_ping">{t('longTail.monitors.NetworkMonitorList.types.icmpPing')}</option>
            <option value="tcp_port">{t('longTail.monitors.NetworkMonitorList.types.tcpPort')}</option>
            <option value="http_check">{t('longTail.monitors.NetworkMonitorList.types.httpCheck')}</option>
            <option value="dns_check">{t('longTail.monitors.NetworkMonitorList.types.dnsCheck')}</option>
          </select>
          <select
            value={filterStatus}
            onChange={(e) => setFilterStatus(e.target.value)}
            className="h-9 rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
          >
            <option value="">{t('longTail.monitors.NetworkMonitorList.filters.allStatus')}</option>
            <option value="online">{t('common:states.online')}</option>
            <option value="offline">{t('common:states.offline')}</option>
            <option value="degraded">{t('longTail.monitors.NetworkMonitorList.status.degraded')}</option>
            <option value="unknown">{t('common:states.unknown')}</option>
          </select>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={fetchMonitors}
            className="flex h-9 items-center gap-2 rounded-md border px-3 text-sm text-muted-foreground hover:text-foreground"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            {t('common:actions.refresh')}
          </button>
          <button
            type="button"
            onClick={() => setShowCreateForm(true)}
            className="flex h-9 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            <Plus className="h-4 w-4" />
            {t('longTail.monitors.NetworkMonitorList.actions.addMonitor')}
          </button>
        </div>
      </div>

      <div className="overflow-x-auto rounded-md border">
        <table className="min-w-full divide-y">
          <thead className="bg-muted/40">
            <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-3">{t('common:labels.name')}</th>
              <th className="px-4 py-3">{t('common:labels.type')}</th>
              <th className="px-4 py-3">{t('longTail.monitors.NetworkMonitorList.headers.target')}</th>
              <th className="px-4 py-3">{t('common:labels.status')}</th>
              <th className="px-4 py-3">{t('longTail.monitors.NetworkMonitorList.headers.response')}</th>
              <th className="px-4 py-3">{t('longTail.monitors.NetworkMonitorList.headers.interval')}</th>
              <th className="px-4 py-3">{t('longTail.monitors.NetworkMonitorList.headers.lastChecked')}</th>
              <th className="px-4 py-3 text-right">{t('common:labels.actions')}</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {monitors.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-4 py-6 text-center text-sm text-muted-foreground">
                  {t('longTail.monitors.NetworkMonitorList.empty.prefix')}{' '}
                  <button
                    type="button"
                    onClick={() => setShowCreateForm(true)}
                    className="text-primary underline-offset-2 hover:underline"
                  >
                    {t('longTail.monitors.NetworkMonitorList.empty.action')}
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
                        <span className="text-sm">{typeLabelKeys[monitor.monitorType] ? t(typeLabelKeys[monitor.monitorType]) : monitor.monitorType}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-sm font-mono text-muted-foreground max-w-[200px] truncate" title={monitor.target}>
                      {monitor.target}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium ${sc.color}`}>
                        <StatusIcon className="h-3 w-3" />
                        {t(sc.labelKey)}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-sm text-muted-foreground">
                      {monitor.lastResponseMs != null ? `${Math.round(monitor.lastResponseMs)}ms` : '—'}
                    </td>
                    <td className="px-4 py-3 text-sm text-muted-foreground">
                      {formatInterval(monitor.pollingInterval)}
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">
                      {formatRelativeTime(monitor.lastChecked, t)}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          type="button"
                          onClick={() => handleCheck(monitor.id)}
                          disabled={isLoadingAction}
                          className="flex h-8 w-8 items-center justify-center rounded-md border hover:bg-muted disabled:opacity-50"
                          title={t('longTail.monitors.NetworkMonitorList.actions.runCheckNow')}
                        >
                          {isLoadingAction ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                        </button>
                        <button
                          type="button"
                          onClick={() => setDetailMonitorId(monitor.id)}
                          className="flex h-8 w-8 items-center justify-center rounded-md border hover:bg-muted"
                          title={t('longTail.monitors.NetworkMonitorList.actions.viewDetails')}
                        >
                          <Settings className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDelete(monitor.id)}
                          disabled={isLoadingAction}
                          className="flex h-8 w-8 items-center justify-center rounded-md border hover:bg-muted hover:text-destructive disabled:opacity-50"
                          title={t('longTail.monitors.NetworkMonitorList.actions.deleteMonitor')}
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
          orgId={currentOrgId ?? undefined}
          assetId={filterAssetId ?? undefined}
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
      <ConfirmDialog
        open={deleteTargetId !== null}
        onClose={() => setDeleteTargetId(null)}
        onConfirm={handleConfirmDelete}
        title={t('longTail.monitors.NetworkMonitorList.delete.title')}
        message={t('longTail.monitors.NetworkMonitorList.delete.message')}
        confirmLabel={t('longTail.monitors.NetworkMonitorList.delete.confirmLabel')}
        variant="destructive"
        isLoading={actionLoading !== null}
      />
    </div>
  );
}
