// apps/web/src/components/discovery/AssetDetailModal.tsx
// A READ-ONLY peek at a discovered asset (spec §10, D7).
//
// Everything that writes the asset moved to the device page's
// NetworkAssetSettingsModal — before W04 this modal, EnableMonitoringForm and
// the monitoring dashboard's EditMonitoringModal each edited the same object
// with a different form idiom, and this one reported failure into an inline
// banner below the fold. What remains is the question a click on a list row or
// a topology node actually asks ("what is this?") plus two hand-offs.

import { ExternalLink, Globe, Settings } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { DiscoveredAsset, OpenPortEntry } from './DiscoveredAssetList';
import { typeConfig, approvalStatusConfig } from './DiscoveredAssetList';
import { Dialog } from '../shared/Dialog';
import { formatDateTime } from '@/lib/dateTimeFormat';
import { formatLastSeen } from '@/lib/formatTime';
import { formatNumber } from '@/lib/i18n/format';
import type { DiscoveredAssetLinkSource } from './networkTypes';

/** W01 (spec §4.2). Absent on a pre-W01 API, so every read of it is optional. */
export type AssetReachability = {
  state: 'responding' | 'not_responding' | 'unverified';
  source: 'network_check' | 'probe' | 'scan' | 'unifi' | 'snmp' | null;
  observedAt: string | null;
  lastKnown?: { state: 'responding' | 'not_responding'; source: string; observedAt: string } | null;
};

export type AssetDetail = DiscoveredAsset & {
  openPorts?: OpenPortEntry[];
  osFingerprint?: string;
  snmpData?: Record<string, string>;
  linkedDeviceId?: string | null;
  linkSource?: DiscoveredAssetLinkSource | null;
  label?: string | null;
  notes?: string | null;
  tags?: string[];
  reachability?: AssetReachability | null;
};

// Friendly labels for the scalar SNMP system OIDs the discovery scan collects.
const SNMP_FIELD_LABEL_KEYS: Record<string, string> = {
  sysName: 'assetDetailModal.snmpFields.systemName',
  sysDescr: 'common:labels.description',
  sysObjectId: 'assetDetailModal.snmpFields.objectId',
};

function snmpFieldLabel(key: string, t: (key: string) => string): string {
  return SNMP_FIELD_LABEL_KEYS[key] ? t(/* i18n-dynamic */ SNMP_FIELD_LABEL_KEYS[key]) : key;
}

const REACHABILITY_STATE_KEYS: Record<AssetReachability['state'], string> = {
  responding: 'assetDetailModal.peek.state.responding',
  not_responding: 'assetDetailModal.peek.state.notResponding',
  unverified: 'assetDetailModal.peek.state.unverified',
};

const REACHABILITY_SOURCE_KEYS: Record<string, string> = {
  network_check: 'assetDetailModal.peek.source.networkCheck',
  probe: 'assetDetailModal.peek.source.probe',
  scan: 'assetDetailModal.peek.source.scan',
  unifi: 'assetDetailModal.peek.source.unifi',
  snmp: 'assetDetailModal.peek.source.snmp',
};

/**
 * `<state> · <source> <relative time>` — the spec §10 copy rule. A bare
 * "Online" is exactly what this whole spec exists to remove: it read as live
 * health when it was a 19-hour-old subnet sweep.
 *
 * Returns null when there is nothing sourced to say, so the caller can render
 * an explicit unknown rather than inventing one.
 */
export function reachabilityLine(
  asset: AssetDetail,
  t: (key: string, options?: Record<string, unknown>) => string,
): string | null {
  const reachability = asset.reachability;
  if (reachability?.source && reachability.observedAt) {
    return t('assetDetailModal.peek.reachabilityLine', {
      state: t(/* i18n-dynamic */ REACHABILITY_STATE_KEYS[reachability.state]),
      source: t(/* i18n-dynamic */ REACHABILITY_SOURCE_KEYS[reachability.source] ?? REACHABILITY_SOURCE_KEYS.scan),
      age: formatLastSeen(reachability.observedAt),
    });
  }
  // Pre-W01 API (or an asset nothing has ever observed): the only evidence is
  // the scan's own sighting, and we say so instead of calling it "Online".
  if (asset.lastSeen) {
    return t('assetDetailModal.peek.lastSeenLine', {
      source: t('assetDetailModal.peek.source.scan'),
      age: formatLastSeen(asset.lastSeen),
    });
  }
  return null;
}

type AssetDetailModalProps = {
  open: boolean;
  asset?: AssetDetail | null;
  /** While the detail is being fetched (topology click / deep link). */
  loading?: boolean;
  onClose: () => void;
};

export default function AssetDetailModal({ open, asset, loading = false, onClose }: AssetDetailModalProps) {
  const { t } = useTranslation('discovery');

  // No asset record yet: never render nothing while open, or a node click looks
  // like it did nothing. Loading, then a graceful not-found state (#1728).
  if (!asset) {
    if (!open) return null;
    return (
      <Dialog open={open} onClose={onClose} title={t('assetDetailModal.deviceDetailsTitle')} maxWidth="md">
        <div className="flex flex-col items-center justify-center gap-3 px-6 py-12 text-center">
          {loading ? (
            <>
              <div className="h-7 w-7 animate-spin rounded-full border-[3px] border-primary border-t-transparent" />
              <p className="text-sm text-muted-foreground">{t('assetDetailModal.loadingDetails')}</p>
            </>
          ) : (
            <>
              <Globe className="h-7 w-7 text-muted-foreground/60" aria-hidden />
              <div className="space-y-1">
                <p className="text-sm font-medium text-foreground">{t('assetDetailModal.detailsUnavailableTitle')}</p>
                <p className="text-sm text-muted-foreground">{t('assetDetailModal.detailsUnavailableDescription')}</p>
              </div>
              <button
                type="button"
                onClick={onClose}
                className="mt-1 rounded-md border px-3 py-1.5 text-sm font-medium text-foreground transition hover:bg-muted"
              >
                {t('common:actions.close')}
              </button>
            </>
          )}
        </div>
      </Dialog>
    );
  }

  const openPorts = asset.openPorts ?? [];
  const osFingerprint = asset.osFingerprint ?? '—';
  const snmpData = asset.snmpData ?? {};
  const tags = asset.tags ?? [];
  const displayName = asset.label || asset.hostname || asset.ip;
  const reachability = reachabilityLine(asset, t);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={displayName}
      maxWidth="3xl"
      alignTop
      className="flex flex-col max-h-[calc(100vh-4rem)]"
    >
      <div className="flex items-start justify-between gap-4 border-b px-6 py-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-semibold">{displayName}</h2>
            <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${typeConfig[asset.type].color}`}>
              {t(/* i18n-dynamic */ typeConfig[asset.type].labelKey)}
            </span>
            {asset.approvalStatus !== 'approved' && (
              <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${approvalStatusConfig[asset.approvalStatus].color}`}>
                {t(/* i18n-dynamic */ approvalStatusConfig[asset.approvalStatus].labelKey)}
              </span>
            )}
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {asset.ip}
            {asset.mac !== '—' && <> • {asset.mac}</>}
            {asset.manufacturer !== '—' && <> • {asset.manufacturer}</>}
          </p>
          {/* Spec §10 copy rule: state · source · age, never a bare "Online". */}
          <p
            className="mt-1 text-sm"
            data-testid="asset-modal-reachability"
            aria-label={reachability ? undefined : t('common:states.unknown').toLowerCase()}
            title={asset.lastSeen ? formatDateTime(asset.lastSeen) : undefined}
          >
            {reachability ?? '—'}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md border px-2 py-1 text-xs font-medium text-muted-foreground hover:text-foreground"
        >
          {t('common:actions.close')}
        </button>
      </div>

      <div className="overflow-y-auto px-6 py-5">
        <div className="grid gap-5 lg:grid-cols-2">
          <div className="space-y-4">
            <div className="rounded-md border bg-muted/30 p-4">
              <h3 className="text-sm font-semibold">{t('assetDetailModal.networkDetailsTitle')}</h3>
              <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                <div>
                  <dt className="text-xs text-muted-foreground">{t('assetDetailModal.fields.ping')}</dt>
                  <dd className="font-mono font-medium">
                    {asset.responseTimeMs != null
                      ? asset.responseTimeMs < 1
                        ? '<1 ms'
                        : `${formatNumber(asset.responseTimeMs, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} ms`
                      : '—'}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">{t('assetDetailModal.fields.osFingerprint')}</dt>
                  <dd className="truncate font-medium">{osFingerprint}</dd>
                </div>
              </dl>
              {openPorts.length > 0 ? (
                <div className="mt-3 border-t pt-3">
                  <p className="text-xs font-medium text-muted-foreground">{t('assetDetailModal.openPorts')}</p>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {openPorts.map((p) => (
                      <span key={p.port} className="rounded-full border border-muted bg-background px-2 py-0.5 text-xs">
                        {p.port}{p.service ? ` (${p.service})` : ''}
                      </span>
                    ))}
                  </div>
                </div>
              ) : (
                <p className="mt-3 text-xs text-muted-foreground">{t('assetDetailModal.noOpenPorts')}</p>
              )}
            </div>

            <div className="rounded-md border bg-muted/30 p-4">
              <h3 className="text-sm font-semibold">{t('assetDetailModal.snmpDataTitle')}</h3>
              <dl className="mt-3 space-y-2 text-sm">
                {Object.keys(snmpData).length === 0 ? (
                  <div className="text-xs text-muted-foreground">{t('assetDetailModal.noSnmpData')}</div>
                ) : (
                  Object.entries(snmpData).map(([key, value]) => (
                    <div key={key} className="flex items-center justify-between gap-4">
                      <dt className="text-muted-foreground">{snmpFieldLabel(key, t)}</dt>
                      <dd className="break-all text-right font-medium">{value}</dd>
                    </div>
                  ))
                )}
              </dl>
            </div>
          </div>

          <div className="space-y-4">
            <div className="rounded-md border bg-muted/30 p-4">
              <h3 className="text-sm font-semibold">{t('assetDetailModal.assetInfoTitle')}</h3>
              <dl className="mt-3 space-y-2 text-sm">
                <div>
                  <dt className="text-xs text-muted-foreground">{t('assetDetailModal.fields.displayName')}</dt>
                  <dd className="font-medium">{asset.label || '—'}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">{t('assetDetailModal.fields.notesDescription')}</dt>
                  <dd className="whitespace-pre-wrap font-medium">{asset.notes || '—'}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">{t('assetDetailModal.fields.tags')}</dt>
                  <dd className="mt-1 flex flex-wrap gap-1.5">
                    {tags.length === 0
                      ? '—'
                      : tags.map((tag) => (
                          <span key={tag} className="rounded-full border border-muted bg-background px-2 py-0.5 text-xs">
                            {tag}
                          </span>
                        ))}
                  </dd>
                </div>
              </dl>
            </div>

            {asset.linkedDeviceId && (
              <div className="rounded-md border bg-muted/30 px-4 py-3">
                <a
                  href={`/devices/${asset.linkedDeviceId}`}
                  data-testid="asset-modal-same-device-link"
                  className="text-sm text-primary hover:underline"
                >
                  {t('assetDetailModal.sameDeviceAs', { name: asset.linkedDeviceName || t('common:states.unknown') })}
                </a>
              </div>
            )}

            {/* The two hand-offs. This modal deliberately cannot change
                anything — the device page owns the asset (spec §10, D7). */}
            <div className="rounded-md border bg-muted/30 p-4">
              <h3 className="text-sm font-semibold">{t('assetDetailModal.peek.manageTitle')}</h3>
              <p className="mt-1 text-xs text-muted-foreground">{t('assetDetailModal.peek.manageDescription')}</p>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <a
                  href={`/devices/network/${asset.id}`}
                  data-testid="asset-modal-open-device-page"
                  className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:opacity-90"
                >
                  {t('assetDetailModal.peek.openDevicePage')}
                  <ExternalLink className="h-3.5 w-3.5" />
                </a>
                <a
                  href={`/devices/network/${asset.id}#overview/settings/identity`}
                  data-testid="asset-modal-settings"
                  className="inline-flex h-8 items-center gap-1.5 rounded-md border px-3 text-xs font-medium hover:bg-muted"
                >
                  <Settings className="h-3.5 w-3.5" />
                  {t('assetDetailModal.peek.settings')}
                </a>
              </div>
            </div>
          </div>
        </div>
      </div>
    </Dialog>
  );
}
