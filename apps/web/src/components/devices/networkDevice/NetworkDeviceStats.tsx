// The four-stat strip: status, ping, last seen, and linked device. Reflects
// the last scan result, not a live probe, so it always pairs with an "as of"
// timestamp rather than implying real-time health.

import { Activity, Gauge, Clock, Link2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { DiscoveredAsset } from '../../discovery/DiscoveredAssetList';
import { formatPing, pingColor } from '../../discovery/pingFormat';
import { formatLastSeen } from '@/lib/formatTime';
import { formatTimestamp } from './format';

export function NetworkDeviceStats({ asset }: { asset: DiscoveredAsset }) {
  const { t } = useTranslation('devices');
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
          <p className="text-xs text-muted-foreground">
            {t('networkDeviceDetailPage.stats.asOf', { time: formatLastSeen(asset.lastSeen) })}
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
        <div className="flex items-center gap-1.5 whitespace-nowrap text-xs font-medium text-muted-foreground">
          <Clock aria-hidden="true" className="h-3.5 w-3.5" />
          {t('networkDeviceDetailPage.fields.lastSeen')}
        </div>
        <p className="mt-1 whitespace-nowrap text-lg font-semibold" title={formatTimestamp(asset.lastSeen)}>
          {asset.lastSeen ? formatLastSeen(asset.lastSeen) : '—'}
        </p>
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
