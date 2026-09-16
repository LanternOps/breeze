// The page header card: type icon tile, name/type/approval/reachability badges,
// the IP/MAC/manufacturer subtitle line, and the header-level actions (Open
// Web UI, Settings).

import { Settings, MapPin, type LucideIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { DiscoveredAsset } from '../../discovery/DiscoveredAssetList';
import { typeConfig, approvalStatusConfig } from '../../discovery/DiscoveredAssetList';
import { ProxyConnectPopover } from './ProxyConnectPopover';
import { formatReachability, type ReachabilityTone, type TFn } from './reachabilityCopy';
import type { Reachability, DeviceOption } from './types';

export function NetworkDeviceHeader({
  asset,
  lastError,
  reachability,
  timezone,
  nicVendor,
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
  lastError?: string | null;
  reachability: Reachability | null;
  timezone: string;
  nicVendor: string | null;
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
  const reach = formatReachability(reachability, t as TFn, timezone);
  const TONE_CLASSES: Record<ReachabilityTone, string> = {
    success: 'bg-success/15 text-success border-success/30',
    destructive: 'bg-destructive/15 text-destructive border-destructive/30',
    muted: 'bg-muted text-muted-foreground border-muted',
  };
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
              {asset.approvalStatus !== 'approved' && (
                <span
                  data-testid="network-detail-approval-badge"
                  className={`inline-flex shrink-0 items-center rounded-full border px-2.5 py-1 text-xs font-medium ${approvalMeta?.color ?? 'bg-muted text-muted-foreground border-muted'}`}
                >
                  {approvalLabel}
                </span>
              )}
              <span
                data-testid="network-device-status"
                title={reach.title || undefined}
                className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium ${TONE_CLASSES[reach.tone]}`}
              >
                <span aria-hidden="true" className="h-2 w-2 rounded-full bg-current" />
                {reach.label}
              </span>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
              {[
                siteName ? (
                  <span key="site" className="flex items-center gap-1" data-testid="network-detail-site">
                    <MapPin aria-hidden="true" className="h-3.5 w-3.5" />
                    {siteName}
                  </span>
                ) : null,
                <span key="ip" className="font-mono">{asset.ip}</span>,
                asset.mac !== '—' ? <span key="mac" className="font-mono">{asset.mac}</span> : null,
                asset.manufacturer !== '—' ? (
                  <span key="mfr" className="min-w-0 max-w-[16rem] truncate" title={asset.manufacturer}>
                    {asset.manufacturer}
                  </span>
                ) : null,
                nicVendor && nicVendor !== asset.manufacturer ? (
                  <span key="nic" className="min-w-0 max-w-[16rem] truncate" title={nicVendor}>
                    {nicVendor}
                  </span>
                ) : null,
              ]
                .filter(Boolean)
                .map((node, index) => (
                  <span key={index} className="flex items-center gap-2">
                    {index > 0 && <span aria-hidden="true">·</span>}
                    {node}
                  </span>
                ))}
            </div>
            {lastError && (
              <p data-testid="network-device-last-error" className="mt-2 break-words text-sm text-destructive">
                {t('networkDeviceDetailPage.header.lastError', { error: lastError })}
              </p>
            )}
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
