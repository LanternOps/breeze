// The four-stat strip: status, ping, open ports, and linked device. Status
// and ping reflect the last scan result, not a live probe, so status always
// pairs with an "as of" timestamp rather than implying real-time health.

import { Activity, Gauge, Link2, Plug } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { DiscoveredAsset } from '../../discovery/DiscoveredAssetList';
import { formatPing, pingColor } from '../../discovery/pingFormat';
import { formatLastSeen } from '@/lib/formatTime';
import { formatTimestamp } from './format';

export function NetworkDeviceStats({
  asset,
  onViewPorts,
}: {
  asset: DiscoveredAsset;
  // Switches the page to the overview tab and scrolls the open-ports section
  // into view — lets the "Open ports" stat act as a shortcut instead of a
  // second place that merely repeats a count shown again below.
  onViewPorts: () => void;
}) {
  const { t } = useTranslation('devices');
  // DeviceDetails.tsx's `effectiveTimezone` falls back to the browser's own
  // zone the same way when no timezone is supplied — this page has no
  // timezone source of its own (no org/site timezone is threaded into it),
  // so replicate just that fallback.
  const effectiveTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const openPortsCount = asset.openPorts?.length ?? 0;
  return (
    <div
      className="flex flex-col gap-4 rounded-lg border bg-card px-5 py-4 sm:flex-row sm:gap-6"
      data-testid="network-detail-stats"
    >
      <div className="shrink-0">
        <div className="flex items-center gap-1.5 whitespace-nowrap text-xs font-medium text-muted-foreground">
          <Activity aria-hidden="true" className="h-3.5 w-3.5" />
          {t('networkDeviceDetailPage.fields.status')}
        </div>
        <p className="mt-1 flex items-center gap-1.5 text-lg font-semibold">
          <span
            aria-hidden="true"
            className={`h-2.5 w-2.5 rounded-full ${asset.isOnline ? 'bg-success' : 'bg-muted-foreground'}`}
          />
          {asset.isOnline ? t('common:states.online') : t('common:states.offline')}
        </p>
        {asset.lastSeen && (
          <p className="text-xs text-muted-foreground" title={formatTimestamp(asset.lastSeen)}>
            {t('networkDeviceDetailPage.stats.asOf', { time: formatLastSeen(asset.lastSeen, effectiveTimezone) })}
          </p>
        )}
      </div>
      <div className="hidden w-px self-stretch bg-border sm:block" aria-hidden="true" />
      <div className="shrink-0">
        <div className="flex items-center gap-1.5 whitespace-nowrap text-xs font-medium text-muted-foreground">
          <Gauge aria-hidden="true" className="h-3.5 w-3.5" />
          {t('networkDeviceDetailPage.fields.ping')}
        </div>
        <p
          className={`mt-1 text-lg font-semibold tabular-nums ${pingColor(asset.responseTimeMs)}`}
          data-testid="network-detail-ping"
        >
          {formatPing(asset.responseTimeMs)}
        </p>
      </div>
      <div className="hidden w-px self-stretch bg-border sm:block" aria-hidden="true" />
      <div className="shrink-0">
        <button
          type="button"
          data-testid="network-detail-stat-ports"
          onClick={onViewPorts}
          className="rounded-sm text-left focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
        >
          <div className="flex items-center gap-1.5 whitespace-nowrap text-xs font-medium text-muted-foreground">
            <Plug aria-hidden="true" className="h-3.5 w-3.5" />
            {t('networkDeviceDetailPage.sections.openPorts')}
          </div>
          <p className="mt-1 text-lg font-semibold tabular-nums">{openPortsCount}</p>
        </button>
      </div>
      <div className="hidden w-px self-stretch bg-border sm:block" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 whitespace-nowrap text-xs font-medium text-muted-foreground">
          <Link2 aria-hidden="true" className="h-3.5 w-3.5" />
          {t('networkDeviceDetailPage.fields.linkedDevice')}
        </div>
        <p className="mt-1 truncate text-lg font-semibold">
          {asset.linkedDeviceId ? (
            <a
              href={`/devices/${asset.linkedDeviceId}`}
              data-testid="network-detail-stat-linked"
              className="text-primary hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
            >
              {asset.linkedDeviceName || t('common:states.unknown')}
            </a>
          ) : (
            '—'
          )}
        </p>
      </div>
    </div>
  );
}
