// The page header card: type icon tile, name/type/approval/online badges,
// the IP/MAC/manufacturer subtitle line, and the header-level actions (Open
// Web UI, Settings).

import { Settings, MapPin, Wifi, WifiOff, type LucideIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { DiscoveredAsset } from '../../discovery/DiscoveredAssetList';
import { typeConfig, approvalStatusConfig } from '../../discovery/DiscoveredAssetList';
import { ProxyConnectPopover } from './ProxyConnectPopover';
import type { DeviceOption } from './types';

export function NetworkDeviceHeader({
  asset,
  displayName,
  siteName,
  typeMeta,
  typeLabel,
  approvalMeta,
  approvalLabel,
  TypeIcon,
  defaultWebPort,
  suggestedBridgeDeviceId,
  devices,
  devicesError,
  onRetryDevices,
  onAnnounce,
  onOpenSettings,
}: {
  asset: DiscoveredAsset;
  displayName: string;
  siteName: string | null;
  typeMeta?: (typeof typeConfig)[keyof typeof typeConfig];
  typeLabel: string;
  approvalMeta?: (typeof approvalStatusConfig)[keyof typeof approvalStatusConfig];
  approvalLabel: string;
  TypeIcon: LucideIcon;
  defaultWebPort?: { port: number; service?: string };
  suggestedBridgeDeviceId: string | null;
  devices: DeviceOption[];
  devicesError: boolean;
  onRetryDevices: () => void;
  onAnnounce: (message: string) => void;
  onOpenSettings: () => void;
}) {
  const { t } = useTranslation('devices');
  return (
    <div className="rounded-lg border bg-card p-6 shadow-xs">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-4">
          <div className={`flex h-14 w-14 items-center justify-center rounded-lg border ${typeMeta?.tile ?? typeConfig.unknown.tile}`}>
            <TypeIcon aria-hidden="true" className="h-7 w-7" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2 min-w-0">
              <h1
                className="truncate text-xl font-semibold tracking-tight"
                title={displayName}
                data-testid="network-device-name"
              >
                {displayName}
              </h1>
              <span
                data-testid="network-asset-type"
                className={`inline-flex shrink-0 items-center rounded-full border px-2.5 py-1 text-xs font-medium ${typeMeta?.color ?? typeConfig.unknown.color}`}
              >
                {typeLabel}
              </span>
              <span
                className={`inline-flex shrink-0 items-center rounded-full border px-2.5 py-1 text-xs font-medium ${approvalMeta?.color ?? approvalStatusConfig.dismissed.color}`}
              >
                {approvalLabel}
              </span>
              <span
                data-testid="network-device-status"
                className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium ${
                  asset.isOnline
                    ? 'bg-success/15 text-success border-success/30'
                    : 'bg-muted text-muted-foreground border-muted'
                }`}
              >
                {asset.isOnline ? <Wifi aria-hidden="true" className="h-3 w-3" /> : <WifiOff aria-hidden="true" className="h-3 w-3" />}
                {asset.isOnline ? t('common:states.online') : t('common:states.offline')}
              </span>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
              {siteName && (
                <span className="flex items-center gap-1" data-testid="network-detail-site">
                  <MapPin aria-hidden="true" className="h-3.5 w-3.5" />
                  {siteName}
                </span>
              )}
              <span className="font-mono">{asset.ip}</span>
              {asset.mac !== '—' && <span className="font-mono">{asset.mac}</span>}
              {asset.manufacturer !== '—' && (
                <span className="min-w-0 max-w-[16rem] truncate" title={asset.manufacturer}>
                  {asset.manufacturer}
                </span>
              )}
            </div>
          </div>
        </div>
        {/* The device page owns this asset now (spec §10, D7): Settings is the
            one way in, and the old "Manage in Discovery" hand-off is gone —
            Discovery links HERE, not the other way round. */}
        <div className="flex items-center gap-2">
          <ProxyConnectPopover
            variant="header"
            assetId={asset.id}
            assetIp={asset.ip}
            port={defaultWebPort?.port ?? 443}
            service={defaultWebPort?.service}
            suggestedBridgeDeviceId={suggestedBridgeDeviceId}
            devices={devices}
            devicesError={devicesError}
            onRetryDevices={onRetryDevices}
            onAnnounce={onAnnounce}
          />
          <button
            type="button"
            data-testid="network-detail-settings"
            onClick={onOpenSettings}
            className="inline-flex items-center gap-1.5 rounded-md border px-3 py-2 text-sm font-medium hover:bg-muted focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Settings aria-hidden="true" className="h-4 w-4" />
            {t('networkDeviceDetailPage.header.settings')}
          </button>
        </div>
      </div>
    </div>
  );
}
