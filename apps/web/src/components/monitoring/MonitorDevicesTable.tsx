import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fetchWithAuth } from '../../stores/auth';

type DeviceRow = {
  deviceId: string;
  deviceName: string;
  enabled: boolean;
  overrides?: Record<string, unknown> | null;
  sourcePolicyName?: string | null;
};

export interface MonitorDevicesTableProps {
  monitorId: string;
}

/**
 * "Devices" list under a monitor's Deployed card (#5289): which devices this
 * monitor actually resolves to right now, per `GET /monitor-definitions/:id/devices`
 * — the same resolution the sweep uses, so overrides and a closer disabled
 * policy show up exactly as they'll be honored.
 */
export default function MonitorDevicesTable({ monitorId }: MonitorDevicesTableProps) {
  const { t } = useTranslation('monitoring');
  const [rows, setRows] = useState<DeviceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(false);
    fetchWithAuth(`/monitor-definitions/${monitorId}/devices`)
      .then((res) => {
        if (!res.ok) throw new Error('fetch failed');
        return res.json();
      })
      .then((data) => {
        if (!cancelled) setRows(Array.isArray(data?.data) ? data.data : []);
      })
      .catch(() => {
        if (cancelled) return;
        // Distinct from "no devices": a failed load must never render as the
        // same empty state, or an operator troubleshooting "this monitor
        // isn't firing anywhere" would wrongly conclude it's undeployed.
        setRows([]);
        setError(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [monitorId]);

  return (
    <div data-testid="monitor-devices-table">
      <button
        type="button"
        data-testid="monitor-devices-toggle"
        onClick={() => setExpanded((v) => !v)}
        className="text-sm font-medium text-primary hover:underline"
      >
        {t('devices.title')} {rows.length > 0 ? `(${rows.length})` : ''}
      </button>
      {expanded && (
        <div className="mt-2">
          {loading ? (
            <p className="text-sm text-muted-foreground">{t('editor.loading')}</p>
          ) : error ? (
            <p className="text-sm text-destructive">{t('devices.errors.fetch')}</p>
          ) : rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('devices.empty')}</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-xs font-medium uppercase text-muted-foreground">
                <tr>
                  <th className="py-1">{t('devices.columns.device')}</th>
                  <th className="py-1">{t('devices.columns.enabled')}</th>
                  <th className="py-1">{t('devices.columns.source')}</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {rows.map((row) => (
                  <tr key={row.deviceId} data-testid={`monitor-devices-row-${row.deviceId}`}>
                    <td className="py-1">{row.deviceName}</td>
                    <td className="py-1">{row.enabled ? '✓' : '—'}</td>
                    <td className="py-1">{row.sourcePolicyName ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
