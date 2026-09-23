import { useCallback, useEffect, useRef, useState } from 'react';
import { Activity, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { fetchWithAuth } from '../../stores/auth';
import { ActionError, runAction } from '@/lib/runAction';
import { formatDateTime } from '@/lib/dateTimeFormat';
import { showToast } from '../shared/Toast';
import '../../lib/i18n';

/**
 * Device page → Monitoring tab (#6371, W05c2 Task 10): the monitors that
 * effectively apply to this device (resolver output joined to per-device state
 * and the open episode), read from `GET /devices/:id/monitors`. The only
 * mutation is the existing W03 escalation reset route.
 */
export interface DeviceEffectiveMonitorRow {
  monitorId: string;
  name: string;
  kind: string;
  enabled: boolean;
  sourcePolicyId: string;
  sourcePolicyName: string | null;
  lastState: 'ok' | 'breach' | 'unknown';
  lastEvaluatedAt: string | null;
  openEpisode: { id: string; startedAt: string; alertId: string | null } | null;
  escalatedAt: string | null;
  escalationAlertId: string | null;
  responsesPaused: boolean;
}

type DeviceMonitoringTabProps = {
  deviceId: string;
  timezone?: string;
};

const STATE_STYLES: Record<string, string> = {
  ok: 'bg-success/15 text-success border-success/30',
  breach: 'bg-destructive/15 text-destructive border-destructive/30',
  unknown: 'bg-muted text-muted-foreground border-border',
};

const COLUMNS = ['monitor', 'kind', 'policy', 'state', 'episode', 'escalation'] as const;

export default function DeviceMonitoringTab({ deviceId, timezone }: DeviceMonitoringTabProps) {
  const { t } = useTranslation(['monitoring', 'common']);
  const [rows, setRows] = useState<DeviceEffectiveMonitorRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [resetting, setResetting] = useState<string | null>(null);
  // Guards against a slow earlier read overwriting a newer one (device switch
  // or a Refresh racing a post-reset reload).
  const generation = useRef(0);

  const load = useCallback(async () => {
    const request = ++generation.current;
    setLoading(true);
    setError(false);
    try {
      const response = await fetchWithAuth(`/devices/${deviceId}/monitors`);
      if (!response.ok) throw new Error('read_failed');
      const body = (await response.json()) as { data?: DeviceEffectiveMonitorRow[] };
      if (!Array.isArray(body.data)) throw new Error('read_failed');
      if (request === generation.current) setRows(body.data);
    } catch {
      if (request === generation.current) setError(true);
    } finally {
      if (request === generation.current) setLoading(false);
    }
  }, [deviceId]);

  useEffect(() => {
    setRows([]);
    void load();
    return () => {
      generation.current++;
    };
  }, [load]);

  const reset = async (row: DeviceEffectiveMonitorRow) => {
    if (!window.confirm(t('monitoring:activity.reset.confirm', { device: row.name }))) return;
    setResetting(row.monitorId);
    try {
      await runAction({
        request: () =>
          fetchWithAuth(`/monitor-definitions/${row.monitorId}/devices/${deviceId}/reset`, { method: 'POST' }),
        successMessage: t('monitoring:activity.reset.success'),
        errorFallback: t('monitoring:activity.reset.error'),
      });
      await load();
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) showToast({ type: 'error', message: t('monitoring:activity.reset.error') });
    } finally {
      setResetting(null);
    }
  };

  return (
    <section className="space-y-4 rounded-lg border bg-card p-6 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Activity className="h-5 w-5 text-muted-foreground" aria-hidden />
          <h2 className="text-lg font-semibold">{t('monitoring:device.title')}</h2>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
        >
          <RefreshCw className="h-4 w-4" aria-hidden />
          {t('common:actions.refresh')}
        </button>
      </div>

      {loading ? (
        <p className="text-sm text-muted-foreground">{t('common:states.loading')}</p>
      ) : error ? (
        <p role="alert" data-testid="device-monitoring-error" className="text-sm text-destructive">
          {t('monitoring:device.error')}
        </p>
      ) : rows.length === 0 ? (
        <p data-testid="device-monitoring-empty" className="text-sm text-muted-foreground">
          {t('monitoring:device.empty')}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs uppercase text-muted-foreground">
              <tr>
                {COLUMNS.map((key) => (
                  <th key={key} className="p-3 font-medium">
                    {t(/* i18n-dynamic */ `monitoring:device.${key}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.monitorId} data-testid="device-monitoring-row" className="border-t">
                  <td className="p-3">
                    <a href={`/alerts/monitors/${row.monitorId}`} className="font-medium text-primary hover:underline">
                      {row.name}
                    </a>
                    {!row.enabled && (
                      <span className="ml-2 rounded-full border px-2 py-0.5 text-xs text-muted-foreground">
                        {t('common:states.disabled')}
                      </span>
                    )}
                  </td>
                  <td className="p-3">{t(/* i18n-dynamic */ `monitoring:kinds.${row.kind}`, { defaultValue: row.kind })}</td>
                  <td className="p-3">
                    <a href={`/configuration-policies/${row.sourcePolicyId}#monitors`} className="hover:underline">
                      {row.sourcePolicyName ?? row.sourcePolicyId}
                    </a>
                  </td>
                  <td className="p-3">
                    <span
                      className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-medium ${
                        STATE_STYLES[row.lastState] ?? STATE_STYLES.unknown
                      }`}
                    >
                      {t(/* i18n-dynamic */ `monitoring:activity.state.${row.lastState}`)}
                    </span>
                  </td>
                  <td className="p-3">
                    {row.openEpisode ? (
                      <a
                        data-testid={`device-monitor-episode-${row.monitorId}`}
                        className="hover:underline"
                        href={
                          row.openEpisode.alertId
                            ? `/alerts/${row.openEpisode.alertId}`
                            : `/alerts/monitors/${row.monitorId}#activity`
                        }
                      >
                        {formatDateTime(row.openEpisode.startedAt, { timeZone: timezone })}
                      </a>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="p-3">
                    {row.escalatedAt ? formatDateTime(row.escalatedAt, { timeZone: timezone }) : '—'}
                    <span className="block text-xs text-muted-foreground">
                      {t(/* i18n-dynamic */ `monitoring:activity.responses.${row.responsesPaused ? 'paused' : 'active'}`)}
                    </span>
                    {(row.escalatedAt || row.responsesPaused) && (
                      <button
                        type="button"
                        data-testid={`device-monitor-reset-${row.monitorId}`}
                        disabled={resetting !== null}
                        onClick={() => void reset(row)}
                        className="mt-1 rounded-md border px-2 py-1 text-xs hover:bg-muted disabled:opacity-50"
                      >
                        {t('monitoring:activity.reset.button')}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
