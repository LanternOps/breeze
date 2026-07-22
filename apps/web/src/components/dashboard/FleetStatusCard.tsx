import { CheckCircle2, WifiOff } from 'lucide-react';
import { formatTimeAgo } from '@/lib/formatTime';
import { useTranslation } from 'react-i18next';
import SegmentedBar from './SegmentedBar';
import type { DashboardQueryState } from '../../hooks/useDashboardQuery';
import type { DeviceStats, OfflineDevice } from './types';

/**
 * Fleet availability at a glance: online/offline/other split as a status
 * bar, then the most recently seen offline devices as jump-off points.
 */
export default function FleetStatusCard({
  devices,
  offline,
}: {
  devices: DashboardQueryState<DeviceStats>;
  offline: DashboardQueryState<OfflineDevice[]>;
}) {
  const { t } = useTranslation('common');

  if (devices.isLoading) {
    return (
      <div className="rounded-lg border bg-card p-5 shadow-xs" data-testid="dashboard-fleet-status">
        <div className="skeleton mb-4 h-4 w-24 rounded" />
        <div className="skeleton mb-3 h-2 w-full rounded" />
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <div key={i} className="skeleton h-4 w-full" />
          ))}
        </div>
      </div>
    );
  }

  const stats = devices.data;
  if (!stats || stats.total === 0) return null;

  const other = Math.max(stats.total - stats.online - (stats.byStatus.offline ?? 0), 0);
  const offlineExact = stats.byStatus.offline ?? 0;

  const offlineDevices = [...(offline.data ?? [])]
    .sort((a, b) => {
      const aTime = a.lastSeen || a.lastHeartbeat || '';
      const bTime = b.lastSeen || b.lastHeartbeat || '';
      return bTime.localeCompare(aTime);
    })
    .slice(0, 5);

  const allOnline = stats.online === stats.total;

  return (
    <div className="rounded-lg border bg-card p-5 shadow-xs" data-testid="dashboard-fleet-status">
      <div className="mb-3 flex items-center justify-between">
        <a href="/devices" className="text-sm font-semibold transition-colors hover:text-primary">
          {t('dashboard.fleetStatus.title')}
        </a>
        <span className="text-xs font-medium tabular-nums text-muted-foreground">
          {t('dashboard.fleetStatus.onlineCount', { online: stats.online, total: stats.total })}
        </span>
      </div>

      <SegmentedBar
        ariaLabel={t('dashboard.fleetStatus.onlineCount', { online: stats.online, total: stats.total })}
        segments={[
          { key: 'online', label: t('states.online'), count: stats.online, colorClass: 'bg-success' },
          { key: 'offline', label: t('states.offline'), count: offlineExact, colorClass: 'bg-chart-neutral' },
          // Deliberately omitted when zero (unlike SegmentedBar's stable-legend
          // default): "Other" is rare, and a permanent 0-count legend entry
          // would beg the question of what it means.
          ...(other > 0
            ? [{ key: 'other', label: t('dashboard.fleetStatus.other'), count: other, colorClass: 'bg-info' }]
            : []),
        ]}
      />

      {allOnline ? (
        <div className="flex flex-col items-center py-5 text-center">
          <div className="mb-2.5 rounded-full bg-success/10 p-2.5">
            <CheckCircle2 className="h-5 w-5 text-success" />
          </div>
          <p className="text-sm font-medium text-foreground">{t('dashboard.fleetStatus.allOnline')}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">{t('dashboard.fleetStatus.healthy')}</p>
        </div>
      ) : (
        <div className="mt-4 space-y-0.5">
          {offline.error != null && !offline.data && (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">{t('dashboard.stats.loadFailed')}</p>
          )}
          {offlineDevices.map((device) => {
            const lastTime = device.lastSeen || device.lastHeartbeat;
            return (
              <a
                key={device.id}
                href={`/devices/${device.id}`}
                className="flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-muted/40"
              >
                <WifiOff className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate font-medium">
                  {device.name || device.hostname || t('states.unknown')}
                </span>
                {lastTime && (
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                    {formatTimeAgo(lastTime)}
                  </span>
                )}
              </a>
            );
          })}
          {offlineExact > offlineDevices.length && (
            <a
              href="/devices?status=offline"
              className="block pt-2 text-center text-xs font-medium text-primary hover:underline"
            >
              {t('dashboard.fleetStatus.viewOffline', { count: offlineExact })}
            </a>
          )}
        </div>
      )}
    </div>
  );
}
