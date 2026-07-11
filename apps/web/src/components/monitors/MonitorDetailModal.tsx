import { useCallback, useEffect, useState } from 'react';
import {
  X,
  CheckCircle,
  XCircle,
  AlertTriangle,
  HelpCircle,
  Loader2,
  Play,
  Trash2
} from 'lucide-react';
import { Dialog } from '../shared/Dialog';
import { fetchWithAuth } from '../../stores/auth';
import { useTranslation } from 'react-i18next';

type MonitorDetail = {
  id: string;
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
  recentResults: Array<{
    id: string;
    status: string;
    responseMs: number | null;
    statusCode: number | null;
    error: string | null;
    details: Record<string, unknown> | null;
    timestamp: string;
  }>;
  alertRules: Array<{
    id: string;
    condition: string;
    threshold: string | null;
    severity: string;
    message: string | null;
    isActive: boolean;
  }>;
};

const statusConfig: Record<string, { icon: typeof CheckCircle; color: string; labelKey: string }> = {
  online: { icon: CheckCircle, color: 'text-success bg-success/15 border-success/30', labelKey: 'common:states.online' },
  offline: { icon: XCircle, color: 'text-destructive bg-destructive/15 border-destructive/30', labelKey: 'common:states.offline' },
  degraded: { icon: AlertTriangle, color: 'text-warning bg-warning/15 border-warning/30', labelKey: 'longTail.monitors.MonitorDetailModal.status.degraded' },
  unknown: { icon: HelpCircle, color: 'text-muted-foreground bg-muted border-muted', labelKey: 'common:states.unknown' }
};

const typeLabelKeys: Record<string, string> = {
  icmp_ping: 'longTail.monitors.MonitorDetailModal.types.icmpPing',
  tcp_port: 'longTail.monitors.MonitorDetailModal.types.tcpPort',
  http_check: 'longTail.monitors.MonitorDetailModal.types.httpCheck',
  dns_check: 'longTail.monitors.MonitorDetailModal.types.dnsCheck'
};

function formatRelativeTime(dateString: string | null, t: (key: string, options?: Record<string, unknown>) => string) {
  if (!dateString) return t('longTail.monitors.MonitorDetailModal.time.never');
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return dateString;
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / (1000 * 60));
  if (diffMins < 1) return t('longTail.monitors.MonitorDetailModal.time.justNow');
  if (diffMins < 60) return t('longTail.monitors.MonitorDetailModal.time.minutesAgo', { count: diffMins });
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return t('longTail.monitors.MonitorDetailModal.time.hoursAgo', { count: diffHours });
  const diffDays = Math.floor(diffHours / 24);
  return t('longTail.monitors.MonitorDetailModal.time.daysAgo', { count: diffDays });
}

type MonitorDetailModalProps = {
  monitorId: string;
  onClose: () => void;
  onDeleted: () => void;
  onUpdated: () => void;
};

export default function MonitorDetailModal({ monitorId, onClose, onDeleted, onUpdated }: MonitorDetailModalProps) {
  const { t } = useTranslation('common');
  const [monitor, setMonitor] = useState<MonitorDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [actionLoading, setActionLoading] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState('');
  const [editInterval, setEditInterval] = useState(60);
  const [editTimeout, setEditTimeout] = useState(5);
  const [editActive, setEditActive] = useState(true);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const fetchDetail = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetchWithAuth(`/monitors/${monitorId}`);
      if (!res.ok) throw new Error(t('longTail.monitors.MonitorDetailModal.errors.loadDetails'));
      const data = await res.json();
      const m = data.data;
      setMonitor(m);
      setEditName(m.name);
      setEditInterval(m.pollingInterval);
      setEditTimeout(m.timeout);
      setEditActive(m.isActive);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('longTail.monitors.MonitorDetailModal.errors.generic'));
    } finally {
      setLoading(false);
    }
  }, [monitorId, t]);

  useEffect(() => {
    fetchDetail();
  }, [fetchDetail]);

  const handleCheck = async () => {
    setActionLoading(true);
    try {
      const res = await fetchWithAuth(`/monitors/${monitorId}/check`, { method: 'POST' });
      if (!res.ok) throw new Error(t('longTail.monitors.MonitorDetailModal.errors.triggerCheck'));
      setTimeout(() => fetchDetail(), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('longTail.monitors.MonitorDetailModal.errors.generic'));
    } finally {
      setActionLoading(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setError(undefined);
    try {
      const res = await fetchWithAuth(`/monitors/${monitorId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: editName,
          pollingInterval: editInterval,
          timeout: editTimeout,
          isActive: editActive
        })
      });
      if (!res.ok) throw new Error(t('longTail.monitors.MonitorDetailModal.errors.updateMonitor'));
      setEditing(false);
      await fetchDetail();
      onUpdated();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('longTail.monitors.MonitorDetailModal.errors.generic'));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    setActionLoading(true);
    try {
      const res = await fetchWithAuth(`/monitors/${monitorId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(t('longTail.monitors.MonitorDetailModal.errors.deleteMonitor'));
      onDeleted();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('longTail.monitors.MonitorDetailModal.errors.generic'));
    } finally {
      setActionLoading(false);
    }
  };

  const sc = monitor ? (statusConfig[monitor.lastStatus] ?? statusConfig.unknown) : statusConfig.unknown;
  const StatusIcon = sc.icon;

  return (
    <Dialog open={true} onClose={onClose} title={monitor?.name ?? t('longTail.monitors.MonitorDetailModal.fallbackTitle')} maxWidth="3xl" className="max-h-[90vh] overflow-y-auto p-6">
      {loading ? (
        <div className="flex flex-col items-center py-8">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
          <p className="mt-2 text-sm text-muted-foreground">{t('common:states.loading')}</p>
        </div>
      ) : !monitor ? (
        <div>
          <p className="text-sm text-destructive">{error ?? t('longTail.monitors.MonitorDetailModal.notFound')}</p>
          <button type="button" onClick={onClose} className="mt-4 rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground">
            {t('common:actions.close')}
          </button>
        </div>
      ) : (
        <>
        {/* Header */}
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold">{monitor.name}</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {typeLabelKeys[monitor.monitorType] ? t(typeLabelKeys[monitor.monitorType]) : monitor.monitorType} &middot; {monitor.target}
            </p>
          </div>
          <button type="button" onClick={onClose} className="flex h-8 w-8 items-center justify-center rounded-md border hover:bg-muted">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Status Bar */}
        <div className="mt-4 flex flex-wrap items-center gap-4 rounded-md border bg-muted/30 px-4 py-3">
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">{t('longTail.monitors.MonitorDetailModal.labels.status')}</span>
            <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${sc.color}`}>
              <StatusIcon className="h-3 w-3" />
              {t(sc.labelKey)}
            </span>
          </div>
          <div className="text-xs text-muted-foreground">
            {t('longTail.monitors.MonitorDetailModal.labels.response', { response: monitor.lastResponseMs != null ? `${Math.round(monitor.lastResponseMs)}ms` : '—' })}
          </div>
          <div className="text-xs text-muted-foreground">
            {t('longTail.monitors.MonitorDetailModal.labels.lastChecked', { time: formatRelativeTime(monitor.lastChecked, t) })}
          </div>
          {monitor.consecutiveFailures > 0 && (
            <div className="text-xs text-destructive">
              {t('longTail.monitors.MonitorDetailModal.consecutiveFailures', { count: monitor.consecutiveFailures })}
            </div>
          )}
          {monitor.lastError && (
            <div className="w-full text-xs text-destructive mt-1">{monitor.lastError}</div>
          )}
        </div>

        {/* Actions */}
        <div className="mt-4 flex items-center gap-2">
          <button
            type="button"
            onClick={handleCheck}
            disabled={actionLoading}
            className="flex h-8 items-center gap-1.5 rounded-md border px-3 text-sm hover:bg-muted disabled:opacity-50"
          >
            {actionLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
            {t('longTail.monitors.MonitorDetailModal.actions.checkNow')}
          </button>
          <button
            type="button"
            onClick={() => setEditing(!editing)}
            className="flex h-8 items-center rounded-md border px-3 text-sm hover:bg-muted"
          >
            {editing ? t('longTail.monitors.MonitorDetailModal.actions.cancelEdit') : t('common:actions.edit')}
          </button>
        </div>

        {/* Edit Form */}
        {editing && (
          <div className="mt-4 rounded-md border bg-muted/20 p-4 space-y-3">
            <div className="grid gap-3 sm:grid-cols-3">
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1">{t('common:labels.name')}</label>
                <input
                  type="text"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1">{t('longTail.monitors.MonitorDetailModal.fields.interval')}</label>
                <input
                  type="number"
                  value={editInterval}
                  onChange={(e) => setEditInterval(Number(e.target.value))}
                  min={10}
                  max={86400}
                  className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1">{t('longTail.monitors.MonitorDetailModal.fields.timeout')}</label>
                <input
                  type="number"
                  value={editTimeout}
                  onChange={(e) => setEditTimeout(Number(e.target.value))}
                  min={1}
                  max={300}
                  className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                />
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={editActive}
                onChange={(e) => setEditActive(e.target.checked)}
                className="rounded border"
              />
              {t('common:states.active')}
            </label>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={handleSave}
                disabled={saving}
                className="h-8 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-70 flex items-center gap-1"
              >
                {saving && <Loader2 className="h-3 w-3 animate-spin" />}
                {t('common:actions.save')}
              </button>
            </div>
          </div>
        )}

        {/* Recent Results */}
        {monitor.recentResults.length > 0 && (
          <div className="mt-6">
            <h3 className="text-sm font-semibold mb-2">{t('longTail.monitors.MonitorDetailModal.recentResults.title')}</h3>
            <div className="max-h-60 overflow-y-auto rounded-md border">
              <table className="min-w-full divide-y text-xs">
                <thead className="bg-muted/40 sticky top-0">
                  <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    <th className="px-3 py-2">{t('longTail.monitors.MonitorDetailModal.recentResults.time')}</th>
                    <th className="px-3 py-2">{t('common:labels.status')}</th>
                    <th className="px-3 py-2 text-right">{t('longTail.monitors.MonitorDetailModal.recentResults.response')}</th>
                    <th className="px-3 py-2">{t('common:states.error')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {monitor.recentResults.map((r) => {
                    const rsc = statusConfig[r.status] ?? statusConfig.unknown;
                    return (
                      <tr key={r.id}>
                        <td className="px-3 py-1.5 text-muted-foreground">{formatRelativeTime(r.timestamp, t)}</td>
                        <td className="px-3 py-1.5">
                          <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs ${rsc.color}`}>
                            {t(rsc.labelKey)}
                          </span>
                        </td>
                        <td className="px-3 py-1.5 text-right font-mono">
                          {r.responseMs != null ? `${Math.round(r.responseMs)}ms` : '—'}
                        </td>
                        <td className="px-3 py-1.5 text-muted-foreground max-w-[200px] truncate" title={r.error ?? ''}>
                          {r.error ?? '—'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Alert Rules */}
        {monitor.alertRules.length > 0 && (
          <div className="mt-6">
            <h3 className="text-sm font-semibold mb-2">{t('longTail.monitors.MonitorDetailModal.alertRules.title')}</h3>
            <div className="space-y-2">
              {monitor.alertRules.map((rule) => (
                <div key={rule.id} className="flex items-center justify-between rounded-md border px-3 py-2 text-xs">
                  <div>
                    <span className="font-medium">{rule.condition}</span>
                    {rule.threshold && <span className="text-muted-foreground ml-1">({rule.threshold})</span>}
                    <span className={`ml-2 inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
                      rule.severity === 'critical' ? 'bg-destructive/15 text-destructive' :
                      rule.severity === 'high' ? 'bg-warning/15 text-warning' :
                      rule.severity === 'medium' ? 'bg-primary/15 text-primary' :
                      'bg-muted text-muted-foreground'
                    }`}>
                      {rule.severity}
                    </span>
                    {!rule.isActive && <span className="ml-2 text-muted-foreground">{t('longTail.monitors.MonitorDetailModal.alertRules.disabled')}</span>}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {error && (
          <div className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error}
          </div>
        )}

        {/* Footer */}
        <div className="mt-6 flex items-center justify-between border-t pt-4">
          <div>
            {!confirmDelete ? (
              <button
                type="button"
                onClick={() => setConfirmDelete(true)}
                className="flex items-center gap-1 text-xs text-destructive hover:underline"
              >
                <Trash2 className="h-3 w-3" />
                {t('longTail.monitors.MonitorDetailModal.actions.deleteMonitor')}
              </button>
            ) : (
              <div className="flex items-center gap-2">
                <span className="text-xs text-destructive">{t('longTail.monitors.MonitorDetailModal.delete.confirmShort')}</span>
                <button
                  type="button"
                  onClick={handleDelete}
                  disabled={actionLoading}
                  className="h-7 rounded-md border border-destructive/40 px-3 text-xs font-medium text-destructive hover:bg-destructive/10 disabled:opacity-50"
                >
                  {actionLoading ? t('longTail.monitors.MonitorDetailModal.actions.deleting') : t('longTail.monitors.MonitorDetailModal.actions.yesDelete')}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmDelete(false)}
                  className="h-7 rounded-md border px-3 text-xs font-medium text-muted-foreground"
                >
                  {t('common:actions.cancel')}
                </button>
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="h-9 rounded-md border px-4 text-sm font-medium text-muted-foreground hover:text-foreground"
          >
            {t('common:actions.close')}
          </button>
        </div>
        </>
      )}
    </Dialog>
  );
}
