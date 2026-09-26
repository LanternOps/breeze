import { useCallback, useEffect, useState } from 'react';
import {
  X,
  CheckCircle,
  XCircle,
  AlertTriangle,
  HelpCircle,
  Loader2,
  Play
} from 'lucide-react';
import { showToast } from '../shared/Toast';
import { Dialog } from '../shared/Dialog';
import { ActionError, runAction } from '../../lib/runAction';
import { formatDate } from '../../lib/dateTimeFormat';
import { fetchWithAuth } from '../../stores/auth';
import { useTranslation } from 'react-i18next';
import { useStableT } from '@/lib/i18n/useStableT';

type MonitorDetail = {
  id: string;
  name: string;
  managedByMonitorId: string | null;
  monitorType: string;
  target: string;
  config: Record<string, unknown>;
  tlsState: string | null;
  tlsIssuer: string | null;
  tlsNotAfter: string | null;
  tlsObservedHost: string | null;
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

};

const statusConfig: Record<string, { icon: typeof CheckCircle; color: string; labelKey: string }> = {
  online: { icon: CheckCircle, color: 'text-success bg-success/15 border-success/30', labelKey: 'common:states.online' },
  offline: { icon: XCircle, color: 'text-destructive bg-destructive/15 border-destructive/30', labelKey: 'common:states.offline' },
  degraded: { icon: AlertTriangle, color: 'text-warning bg-warning/15 border-warning/30', labelKey: 'longTail.monitors.MonitorDetailModal.status.degraded' },
  unknown: { icon: HelpCircle, color: 'text-muted-foreground bg-muted border-muted', labelKey: 'common:states.unknown' }
};

const tlsStateLabelKeys: Record<string, string> = {
  observed: 'longTail.monitors.MonitorDetailModal.certificate.states.observed',
  handshake_failed: 'longTail.monitors.MonitorDetailModal.certificate.states.handshakeFailed',
  not_tls: 'longTail.monitors.MonitorDetailModal.certificate.states.notTls'
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
  onUpdated: () => void;
};

export default function MonitorDetailModal({ monitorId, onClose, onUpdated }: MonitorDetailModalProps) {
  const { t } = useTranslation('common');
  const stableT = useStableT(t); // #3632: effect-safe translator; JSX keeps `t`
  const [monitor, setMonitor] = useState<MonitorDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [actionLoading, setActionLoading] = useState(false);
  const fetchDetail = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetchWithAuth(`/monitors/${monitorId}`);
      if (!res.ok) throw new Error(stableT('longTail.monitors.MonitorDetailModal.errors.loadDetails'));
      const data = await res.json();
      const m = data.data;
      setMonitor(m);
    } catch (err) {
      setError(err instanceof Error ? err.message : stableT('longTail.monitors.MonitorDetailModal.errors.generic'));
    } finally {
      setLoading(false);
    }
  }, [monitorId, stableT]);

  useEffect(() => {
    fetchDetail();
  }, [fetchDetail]);

  const handleCheck = async () => {
    setActionLoading(true);
    try {
      await runAction({
        request: () => fetchWithAuth(`/monitors/${monitorId}/check`, { method: 'POST' }),
        successMessage: t('longTail.monitors.NetworkMonitorList.messages.checkQueued'),
        errorFallback: t('longTail.monitors.MonitorDetailModal.errors.triggerCheck')
      });
      onUpdated();
      setTimeout(() => fetchDetail(), 3000);
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) showToast({ type: 'error', message: t('longTail.monitors.MonitorDetailModal.errors.triggerCheck') });
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
              {typeLabelKeys[monitor.monitorType] ? t(/* i18n-dynamic */ typeLabelKeys[monitor.monitorType]) : monitor.monitorType} &middot; {monitor.target}
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
              {t(/* i18n-dynamic */ sc.labelKey)}
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

        {monitor.managedByMonitorId
          ? <a data-testid="monitor-check-open-monitor" href={`/alerts/monitors/${monitor.managedByMonitorId}`} className="mt-3 inline-block text-sm text-primary hover:underline">{t('longTail.monitors.MonitorDetailModal.openMonitor')}</a>
          : <p data-testid="monitor-check-not-converted" className="mt-3 text-sm text-muted-foreground">{t('longTail.monitors.MonitorDetailModal.notConverted')}</p>}

        {monitor.tlsState != null && (
          <section data-testid="monitor-check-certificate" aria-labelledby="monitor-certificate-title" className="mt-4 rounded-md border p-4">
            <h3 id="monitor-certificate-title" className="text-sm font-semibold mb-2">{t('longTail.monitors.MonitorDetailModal.certificate.title')}</h3>
            <dl className="grid gap-3 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-xs text-muted-foreground">{t('longTail.monitors.MonitorDetailModal.certificate.issuer')}</dt>
                <dd className="break-words">{monitor.tlsIssuer ?? '—'}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">{t('longTail.monitors.MonitorDetailModal.certificate.expires')}</dt>
                <dd>{formatDate(monitor.tlsNotAfter, { year: 'numeric', month: 'short', day: 'numeric', fallback: '—' })}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">{t('longTail.monitors.MonitorDetailModal.certificate.observedHost')}</dt>
                <dd className="break-words">{monitor.tlsObservedHost ?? '—'}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">{t('longTail.monitors.MonitorDetailModal.certificate.state')}</dt>
                <dd>{tlsStateLabelKeys[monitor.tlsState] ? t(/* i18n-dynamic */ tlsStateLabelKeys[monitor.tlsState]) : monitor.tlsState}</dd>
              </div>
            </dl>
          </section>
        )}

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
        </div>

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
                            {t(/* i18n-dynamic */ rsc.labelKey)}
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

        {error && (
          <div className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error}
          </div>
        )}

        {/* Footer */}
        <div className="mt-6 flex items-center justify-between border-t pt-4">
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
