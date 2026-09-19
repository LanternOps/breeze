import { Activity, Gauge, Plug, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { DiscoveredAsset, DiscoveredAssetType } from '../../discovery/DiscoveredAssetList';
import { formatPing, pingColor } from '../../discovery/pingFormat';
import { formatPercent } from '@/lib/i18n/format';
import { formatLastPoll, formatReachability, type TFn } from './reachabilityCopy';
import { lowestSupply } from './health/printerMib';
import { portsUp } from './health/ifTable';
import type { Collection, Reachability } from './types';
import { PROBE_ERROR_KEYS, type useAssetProbe } from './useAssetProbe';

export type NetworkDeviceStatsProps = {
  asset: DiscoveredAsset;
  reachability: Reachability | null;
  collection: Collection | null;
  timezone: string;
  probeState: ReturnType<typeof useAssetProbe>;
  onViewPorts: () => void;
  onViewMonitoring: () => void;
};

const TONE_CLASSES = { success: 'text-success', destructive: 'text-destructive', muted: 'text-muted-foreground' };

export function NetworkDeviceStats({
  asset, reachability, collection, timezone, probeState, onViewPorts, onViewMonitoring,
}: NetworkDeviceStatsProps) {
  const { t } = useTranslation('devices');
  const reach = formatReachability(reachability, t as TFn, timezone);
  const poll = formatLastPoll(collection, t as TFn, timezone);
  const typeSlot = resolveTypeSlot(asset, collection, reachability, t as TFn);
  const labelClass = 'flex items-center gap-1.5 text-xs font-medium text-muted-foreground';
  const shortcutClass = 'rounded-sm text-left hover:text-primary focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring';

  return (
    <div className="flex flex-col gap-4 rounded-lg border bg-card px-5 py-4 sm:flex-row sm:flex-wrap sm:gap-6" data-testid="network-detail-stats">
      <div className="min-w-0 shrink-0 sm:basis-64 sm:grow" data-testid="network-detail-stat-reachability">
        <div className={labelClass}>
          <Activity aria-hidden="true" className="h-3.5 w-3.5" />
          {t('networkDeviceDetailPage.stats.reachability')}
        </div>
        <p className={`mt-1 text-lg font-semibold ${TONE_CLASSES[reach.tone]}`} title={reach.title}>{reach.label}</p>
        <button
          type="button"
          data-testid="network-detail-check-now"
          disabled={probeState.checking || probeState.pending}
          onClick={() => void probeState.checkNow()}
          className="mt-1 text-xs text-primary hover:underline disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
        >
          {t('networkDeviceDetailPage.probe.checkNow')}
        </button>
        {(probeState.checking || probeState.pending) && (
          <p className="text-xs text-muted-foreground" data-testid="network-detail-probe-status" role="status">
            {t('networkDeviceDetailPage.probe.checking')}
          </p>
        )}
        {probeState.errorCode && (
          <p className="text-xs text-destructive" data-testid="network-detail-probe-error" role="status">
            {t(/* i18n-dynamic */ `networkDeviceDetailPage.probe.errors.${PROBE_ERROR_KEYS[probeState.errorCode]}`)}
          </p>
        )}
      </div>
      <div className="hidden w-px self-stretch bg-border sm:block" aria-hidden="true" />
      <div className="shrink-0">
        <button type="button" data-testid="network-detail-stat-last-poll" onClick={onViewMonitoring} className={shortcutClass}>
          <div className={labelClass}>
            <RefreshCw aria-hidden="true" className="h-3.5 w-3.5" />
            {t('networkDeviceDetailPage.stats.lastPoll')}
          </div>
          <p className={`mt-1 text-lg font-semibold ${TONE_CLASSES[poll.tone]}`} title={poll.title}>{poll.label}</p>
        </button>
      </div>
      <div className="hidden w-px self-stretch bg-border sm:block" aria-hidden="true" />
      <div className="shrink-0" data-testid="network-detail-stat-type">
        <div className={labelClass}>
          <Gauge aria-hidden="true" className="h-3.5 w-3.5" />
          {typeSlot.label}
        </div>
        <p
          className={`mt-1 text-lg font-semibold tabular-nums ${typeSlot.ping !== undefined ? pingColor(typeSlot.ping) : ''}`}
          data-testid={typeSlot.ping !== undefined ? 'network-detail-ping' : undefined}
          aria-label={typeSlot.value === '—' ? t('common:states.unknown') : undefined}
        >{typeSlot.value}</p>
      </div>
      <div className="hidden w-px self-stretch bg-border sm:block" aria-hidden="true" />
      <div className="shrink-0">
        <button type="button" data-testid="network-detail-stat-ports" onClick={onViewPorts} className={shortcutClass}>
          <div className={labelClass}>
            <Plug aria-hidden="true" className="h-3.5 w-3.5" />
            {t('networkDeviceDetailPage.sections.openPorts')}
          </div>
          <p className="mt-1 text-lg font-semibold tabular-nums">{asset.openPorts?.length ?? 0}</p>
        </button>
      </div>
    </div>
  );
}

type TypeSlot = { label: string; value: string; ping?: number | null };
const NETWORK_GEAR: DiscoveredAssetType[] = ['switch', 'router', 'firewall', 'access_point'];

function resolveTypeSlot(asset: DiscoveredAsset, collection: Collection | null, reachability: Reachability | null, t: TFn): TypeSlot {
  if (asset.type === 'printer') {
    const lowest = lowestSupply(collection);
    if (lowest) {
      return {
        label: t('networkDeviceDetailPage.stats.lowestSupply'),
        value: `${lowest.description ?? t('common:states.unknown')} ${lowest.percent === null
          ? t('common:states.unknown') : formatPercent(lowest.percent / 100, { maximumFractionDigits: 0 })}`,
      };
    }
  }
  if (NETWORK_GEAR.includes(asset.type)) {
    const ports = portsUp(collection);
    if (ports) return { label: t('networkDeviceDetailPage.stats.portsUp'), value: t('networkDeviceDetailPage.stats.portsUpValue', ports) };
  }
  const ms = reachability?.detail.probe?.responseMs ?? reachability?.detail.networkCheck?.responseMs ?? asset.responseTimeMs ?? null;
  return { label: t('networkDeviceDetailPage.fields.ping'), value: formatPing(ms), ping: ms };
}
