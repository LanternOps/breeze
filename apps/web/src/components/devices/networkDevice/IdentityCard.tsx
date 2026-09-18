// Overview row 2. What is ON the card answers "which device is this"; the
// disclosure below holds what the SCANNER saw, which is troubleshooting detail,
// not identity. Keeping the scan's raw sysObjectID and its is_online verdict
// inside the disclosure is deliberate: both used to read as the device's own
// facts (spec §1 F1, F5) and both are really statements about the last sweep.

import { useTranslation } from 'react-i18next';
import { isManualLink } from '../../discovery/networkTypes';
import { typeConfig, type DiscoveredAsset } from '../../discovery/DiscoveredAssetList';
import { Section, Field, UnknownValue } from './primitives';
import { formatTimestamp } from './format';
import { CopyButton } from './CopyButton';
import type { NetworkAssetExtras } from './types';

/** Case- and punctuation-insensitive: "Xerox" and "XEROX CORP." are the same vendor to a reader. */
function sameVendor(a: string | null | undefined, b: string | null | undefined): boolean {
  const norm = (v: string | null | undefined) =>
    (v ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const left = norm(a);
  const right = norm(b);
  if (left === '' || right === '') return false;
  return left.startsWith(right) || right.startsWith(left);
}

export function IdentityCard({
  asset,
  extras,
  timezone,
  onAnnounce,
  onEditIdentity,
}: {
  asset: DiscoveredAsset;
  extras: NetworkAssetExtras;
  timezone: string;
  onAnnounce: (message: string) => void;
  onEditIdentity: () => void;
}) {
  const { t } = useTranslation('devices');
  const typeMeta = typeConfig[asset.type];
  const typeLabel = typeMeta ? t(/* i18n-dynamic */ typeMeta.labelKey) : asset.type;
  const showNicVendor = Boolean(extras.nicVendor) && !sameVendor(extras.nicVendor, asset.manufacturer);
  const sysObjectId = asset.snmpData?.sysObjectId ?? null;
  const tags = asset.tags ?? [];
  const discoveryMethods = asset.discoveryMethods ?? [];
  const unknown = <span aria-label={t('common:states.unknown')}>—</span>;

  return (
    <Section title={t('networkDeviceDetailPage.sections.identity')} testId="network-detail-identity">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm" data-testid="network-detail-identity-primary">
        <Field label={t('networkDeviceDetailPage.fields.displayName')} value={asset.label || asset.hostname || unknown} />
        <div data-testid="network-detail-identity-type">
          <dt className="text-xs text-muted-foreground">{t('networkDeviceDetailPage.fields.assetType')}</dt>
          <dd className="font-medium">
            {typeLabel}
            {asset.typeSource === 'manual' && (
              <span className="ml-1 text-xs font-normal text-muted-foreground">
                {asset.detectedType
                  ? t('networkDeviceDetailPage.manuallySetWithDetected', {
                      type: t(/* i18n-dynamic */ typeConfig[asset.detectedType].labelKey),
                    })
                  : t('networkDeviceDetailPage.manuallySet')}
              </span>
            )}
          </dd>
        </div>

        <div data-testid="network-detail-ip">
          <dt className="text-xs text-muted-foreground">{t('networkDeviceDetailPage.fields.ipAddress')}</dt>
          <dd className="flex items-center gap-1 font-mono font-medium">
            {asset.ip === '—' ? unknown : asset.ip}
            {asset.ip !== '—' && (
              <CopyButton
                value={asset.ip}
                label={t('networkDeviceDetailPage.fields.ipAddress')}
                testId="network-detail-copy-ip"
                onCopied={onAnnounce}
              />
            )}
          </dd>
        </div>
        <div data-testid="network-detail-mac">
          <dt className="text-xs text-muted-foreground">{t('networkDeviceDetailPage.fields.macAddress')}</dt>
          <dd className="flex items-center gap-1 font-mono font-medium">
            {asset.mac === '—' ? unknown : asset.mac}
            {asset.mac !== '—' && (
              <CopyButton
                value={asset.mac}
                label={t('networkDeviceDetailPage.fields.macAddress')}
                testId="network-detail-copy-mac"
                onCopied={onAnnounce}
              />
            )}
          </dd>
        </div>

        <Field
          label={t('networkDeviceDetailPage.fields.manufacturer')}
          value={asset.manufacturer === '—' ? unknown : asset.manufacturer}
        />
        <div data-testid="network-detail-model">
          <dt className="text-xs text-muted-foreground">{t('networkDeviceDetailPage.fields.model')}</dt>
          {/* W01 masks an OID-shaped model server-side; an empty value here is
              an honest "we don't know", never the raw sysObjectID. */}
          <dd className="font-medium break-words">{extras.model || unknown}</dd>
        </div>

        {showNicVendor && (
          <div data-testid="network-detail-nic-vendor">
            <dt className="text-xs text-muted-foreground">{t('networkDeviceDetailPage.fields.nicVendor')}</dt>
            <dd className="font-medium break-words" title={t('networkDeviceDetailPage.fields.nicVendorHint')}>
              {extras.nicVendor}
            </dd>
          </div>
        )}
        <Field label={t('networkDeviceDetailPage.fields.site')} value={extras.siteName || unknown} />

        <div className="col-span-2" data-testid="network-detail-linked">
          <dt className="text-xs text-muted-foreground">{t('networkDeviceDetailPage.fields.linkedDevice')}</dt>
          <dd className="font-medium">
            {asset.linkedDeviceId ? (
              <span className="flex flex-wrap items-center gap-2">
                <a
                  href={`/devices/${asset.linkedDeviceId}`}
                  data-testid="network-detail-linked-device"
                  className="text-primary hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {t('networkDeviceDetailPage.sameDeviceAs', {
                    name: asset.linkedDeviceName || t('common:states.unknown'),
                  })}
                </a>
                <span className="text-xs text-muted-foreground" data-testid="network-detail-link-provenance">
                  {isManualLink(asset.linkSource)
                    ? t('networkDeviceDetailPage.provenance.manual')
                    : t('networkDeviceDetailPage.provenance.auto')}
                </span>
              </span>
            ) : (
              t('networkDeviceDetailPage.notLinked')
            )}
          </dd>
        </div>
      </dl>

      {tags.length > 0 && (
        <div className="mt-3 border-t pt-3">
          <p className="text-xs font-medium text-muted-foreground">{t('networkDeviceDetailPage.fields.tags')}</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {tags.map((tag) => (
              <span key={tag} className="rounded-full border border-muted bg-background px-2 py-0.5 text-xs">{tag}</span>
            ))}
          </div>
        </div>
      )}

      {asset.notes && (
        <div className="mt-3 border-t pt-3">
          <p className="text-xs font-medium text-muted-foreground">{t('networkDeviceDetailPage.fields.notes')}</p>
          <p className="mt-1 text-sm whitespace-pre-wrap">{asset.notes}</p>
        </div>
      )}

      <details className="mt-3 border-t pt-3" data-testid="network-detail-scan-details">
        <summary
          data-testid="network-detail-scan-details-toggle"
          className="cursor-pointer text-xs text-primary hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
        >
          {t('networkDeviceDetailPage.sections.scanDetails')}
        </summary>
        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
          <Field label={t('networkDeviceDetailPage.fields.hostname')} value={asset.hostname || unknown} />
          <Field label={t('networkDeviceDetailPage.fields.netbiosName')} value={extras.netbiosName || unknown} />
          <Field label={t('networkDeviceDetailPage.fields.osFingerprint')} value={asset.osFingerprint || unknown} />
          <div data-testid="network-detail-first-seen">
            <dt className="text-xs text-muted-foreground">{t('networkDeviceDetailPage.fields.firstSeen')}</dt>
            <dd className="font-medium" title={formatTimestamp(extras.firstSeenAt, timezone)}>
              {extras.firstSeenAt ? formatTimestamp(extras.firstSeenAt, timezone) : <UnknownValue />}
            </dd>
          </div>
          <Field
            label={t('networkDeviceDetailPage.fields.discoveryMethods')}
            value={discoveryMethods.length > 0 ? discoveryMethods.join(', ') : unknown}
          />
          <Field label={t('networkDeviceDetailPage.fields.discoveryProfile')} value={asset.profileName || unknown} />
          <div className="col-span-2" data-testid="network-detail-sys-object-id">
            <dt className="text-xs text-muted-foreground">{t('networkDeviceDetailPage.fields.sysObjectId')}</dt>
            <dd className="font-mono text-xs break-all">{sysObjectId ?? unknown}</dd>
          </div>
          <div className="col-span-2" data-testid="network-detail-legacy-verdict">
            <dt className="text-xs text-muted-foreground">{t('networkDeviceDetailPage.fields.legacyScanVerdict')}</dt>
            <dd className="font-medium">
              {asset.isOnline ? t('common:states.online') : t('common:states.offline')}
              <span className="ml-1 text-xs font-normal text-muted-foreground">
                {t('networkDeviceDetailPage.fields.legacyScanVerdictHint')}
              </span>
            </dd>
          </div>
        </dl>
      </details>

      <button
        type="button"
        data-testid="network-detail-edit-identity"
        onClick={onEditIdentity}
        className="mt-3 text-xs text-primary hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
      >
        {t('networkDeviceDetailPage.editInSettings')}
      </button>
    </Section>
  );
}
