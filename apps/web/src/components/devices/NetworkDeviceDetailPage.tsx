import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, Globe, ExternalLink, Wifi, WifiOff } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { fetchWithAuth } from '../../stores/auth';
import { runAction } from '../../lib/runAction';
import { isManualLink } from '../discovery/networkTypes';
import { navigateTo } from '@/lib/navigation';
import { formatDateTime } from '@/lib/dateTimeFormat';
import Breadcrumbs from '../layout/Breadcrumbs';
import { formatNumber } from '@/lib/i18n/format';
import {
  mapAsset,
  typeConfig,
  approvalStatusConfig,
  type ApiDiscoveryAsset,
  type DiscoveredAsset,
  type DiscoveredAssetType,
} from '../discovery/DiscoveredAssetList';

type NetworkDeviceDetailPageProps = {
  assetId: string;
};

// Extra fields the single-asset endpoint (`GET /discovery/assets/:id`) returns
// on top of what `mapAsset` normalizes for the list. Kept local so we read the
// monitoring/identity extras without forking the shared mapper.
type AssetDetailExtras = {
  model?: string | null;
  netbiosName?: string | null;
  siteId?: string | null;
  firstSeenAt?: string | null;
  snmpMonitoringEnabled?: boolean;
  networkMonitoringEnabled?: boolean;
};

// Friendly labels for the scalar SNMP system OIDs the discovery scan collects.
const SNMP_FIELD_LABELS: Record<string, string> = {
  sysName: 'System Name',
  sysDescr: 'Description',
  sysObjectId: 'Object ID',
};

function snmpFieldLabel(key: string): string {
  return SNMP_FIELD_LABELS[key] ?? key;
}

function formatPing(ms?: number | null): string {
  if (ms == null) return '—';
  if (ms < 1) return '<1 ms';
  return `${formatNumber(ms, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} ms`;
}

function formatTimestamp(value?: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return formatDateTime(date);
}

const VALID_TABS = ['overview', 'monitoring'] as const;
type Tab = (typeof VALID_TABS)[number];

function getTabFromHash(): Tab {
  if (typeof window === 'undefined') return 'overview';
  const hash = window.location.hash.replace('#', '').split('/')[0] ?? '';
  if ((VALID_TABS as readonly string[]).includes(hash)) return hash as Tab;
  return 'overview';
}

function Section({
  title,
  children,
  testId,
}: {
  title: string;
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <div className="rounded-md border bg-muted/30 p-4" data-testid={testId}>
      <h3 className="text-sm font-semibold">{title}</h3>
      <div className="mt-3">{children}</div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-medium break-words">{value ?? '—'}</dd>
    </div>
  );
}

export default function NetworkDeviceDetailPage({ assetId }: NetworkDeviceDetailPageProps) {
  const { t } = useTranslation('devices');
  const [asset, setAsset] = useState<DiscoveredAsset | null>(null);
  const [extras, setExtras] = useState<AssetDetailExtras>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [activeTab, setActiveTab] = useState<Tab>(getTabFromHash);

  // Keep the active tab in sync with the URL hash so the view is shareable and
  // the browser back/forward buttons move between tabs (mirrors DeviceDetails).
  useEffect(() => {
    const onHashChange = () => setActiveTab(getTabFromHash());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const switchTab = (tab: Tab) => {
    window.location.hash = tab;
    setActiveTab(tab);
  };

  const fetchAsset = useCallback(async () => {
    try {
      setLoading(true);
      setError(undefined);

      const response = await fetchWithAuth(`/discovery/assets/${assetId}`);
      if (!response.ok) {
        if (response.status === 404) {
          throw new Error(t('networkDeviceDetailPage.errors.notFound'));
        }
        throw new Error(t('networkDeviceDetailPage.errors.load'));
      }

      const body = await response.json();
      const raw: (ApiDiscoveryAsset & AssetDetailExtras) | undefined =
        body?.data ?? body?.asset ?? body;
      // A 200 with an empty/wrong-shaped body would otherwise sail through
      // `mapAsset` (which never returns null) and render a blank "—" shell with
      // an `asset=undefined` deep-link. Treat a missing id as a load failure.
      if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string') {
        throw new Error(t('networkDeviceDetailPage.errors.malformed'));
      }
      setAsset(mapAsset(raw));
      setExtras({
        model: raw.model ?? null,
        netbiosName: raw.netbiosName ?? null,
        siteId: raw.siteId ?? null,
        firstSeenAt: raw.firstSeenAt ?? null,
        snmpMonitoringEnabled: raw.snmpMonitoringEnabled ?? false,
        networkMonitoringEnabled: raw.networkMonitoringEnabled ?? false,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : t('networkDeviceDetailPage.errors.load'));
    } finally {
      setLoading(false);
    }
  }, [assetId, t]);

  useEffect(() => {
    void fetchAsset();
  }, [fetchAsset]);

  const handleBack = () => {
    void navigateTo('/devices');
  };

  const [unlinking, setUnlinking] = useState(false);
  const [typeSaving, setTypeSaving] = useState(false);

  // The Unlink button only renders for manual links (see render guard below) and
  // the server independently rejects non-manual unlinks; this handler guards only
  // that a link exists. runAction surfaces success/failure via toast.
  const handleUnlink = useCallback(async () => {
    if (!asset?.linkedDeviceId) return;
    if (typeof window !== 'undefined' && !window.confirm(t('networkDeviceDetailPage.confirmUnlink'))) return;
    setUnlinking(true);
    try {
      await runAction({
        request: () => fetchWithAuth(`/discovery/assets/${asset.id}/link`, { method: 'DELETE' }),
        successMessage: t('networkDeviceDetailPage.toasts.unlinked'),
        errorFallback: t('networkDeviceDetailPage.toasts.unlinkFailed'),
      });
      await fetchAsset();
    } catch {
      // runAction already toasted the failure; leave the linked state in place.
    } finally {
      setUnlinking(false);
    }
  }, [asset, fetchAsset, t]);

  // Manual override of the scan-detected device type. `reset` restores the
  // auto-detected classification; any other value pins the type as a manual
  // override (server stamps type_source='manual'). runAction surfaces the
  // outcome via toast; we refetch on success so the badge/select reflect the
  // server's canonical state.
  const changeType = useCallback(
    async (next: DiscoveredAssetType | 'reset') => {
      if (!asset) return;
      setTypeSaving(true);
      try {
        await runAction({
          request: () =>
            fetchWithAuth(`/discovery/assets/${asset.id}`, {
              method: 'PATCH',
              body: JSON.stringify(
                next === 'reset' ? { resetTypeToAuto: true } : { assetType: next },
              ),
            }),
          successMessage: next === 'reset'
            ? t('networkDeviceDetailPage.toasts.typeReset')
            : t('networkDeviceDetailPage.toasts.typeUpdated'),
          errorFallback:
            next === 'reset'
              ? t('networkDeviceDetailPage.toasts.typeResetFailed')
              : t('networkDeviceDetailPage.toasts.typeUpdateFailed'),
        });
        await fetchAsset();
      } catch {
        // runAction already toasted the failure; leave the current type in place.
      } finally {
        setTypeSaving(false);
      }
    },
    [asset, fetchAsset, t],
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12" data-testid="network-device-detail-loading">
        <div className="text-center">
          <div className="mx-auto h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          <p className="mt-4 text-sm text-muted-foreground">{t('networkDeviceDetailPage.loading')}</p>
        </div>
      </div>
    );
  }

  if (error || !asset) {
    return (
      <div className="space-y-6" data-testid="network-device-detail-error">
        <button
          type="button"
          onClick={handleBack}
          className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          {t('networkDeviceDetailPage.backToDevices')}
        </button>
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
          <p className="text-sm text-destructive">{error || t('networkDeviceDetailPage.errors.notFound')}</p>
          <button
            type="button"
            onClick={handleBack}
            className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            {t('networkDeviceDetailPage.goBack')}
          </button>
        </div>
      </div>
    );
  }

  const displayName = asset.label || asset.hostname || asset.ip;
  const openPorts = asset.openPorts ?? [];
  const snmpData = asset.snmpData ?? {};
  const tags = asset.tags ?? [];
  const discoveryMethods = asset.discoveryMethods ?? [];
  // `mapAsset` normalizes `type` to a valid key, but `approvalStatus` is passed
  // through raw — guard both lookups so an out-of-enum value from the API can't
  // throw during render (which, with no error boundary, would blank the page).
  const typeMeta = typeConfig[asset.type];
  const approvalMeta = approvalStatusConfig[asset.approvalStatus];
  const typeLabel = typeMeta ? t(/* i18n-dynamic */ typeMeta.labelKey) : asset.type;
  const approvalLabel = approvalMeta ? t(/* i18n-dynamic */ approvalMeta.labelKey) : asset.approvalStatus;

  return (
    <div className="space-y-6" data-testid="network-device-detail">
      <Breadcrumbs items={[
        { label: t('devicesPage.title'), href: '/devices' },
        { label: displayName || t('networkDeviceDetailPage.networkDevice') },
      ]} />

      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4 rounded-lg border bg-card p-5">
        <div className="flex items-start gap-3">
          <div className="rounded-md border bg-muted/40 p-2 text-muted-foreground">
            <Globe className="h-6 w-6" />
          </div>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-lg font-semibold" data-testid="network-device-name">{displayName}</h1>
              <span
                data-testid="network-asset-type"
                className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${typeMeta?.color ?? typeConfig.unknown.color}`}
              >
                {typeLabel}
              </span>
              <span
                className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${approvalMeta?.color ?? approvalStatusConfig.dismissed.color}`}
              >
                {approvalLabel}
              </span>
              <span
                data-testid="network-device-status"
                className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${
                  asset.isOnline
                    ? 'bg-success/15 text-success border-success/30'
                    : 'bg-muted text-muted-foreground border-muted'
                }`}
              >
                {asset.isOnline ? <Wifi className="h-3 w-3" /> : <WifiOff className="h-3 w-3" />}
                {asset.isOnline ? t('common:states.online') : t('common:states.offline')}
              </span>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              {asset.ip}
              {asset.mac !== '—' && <> • {asset.mac}</>}
              {asset.manufacturer !== '—' && <> • {asset.manufacturer}</>}
              {asset.lastSeen && <> • {t('networkDeviceDetailPage.lastSeen', { time: formatTimestamp(asset.lastSeen) })}</>}
            </p>
          </div>
        </div>
        {/* Approve / reclassify remain in Discovery until slice 3 of #1424
            brings them inline; unlink for manual links is available inline on
            the Monitoring tab. Other actions link out for now. */}
        <a
          href={`/discovery?asset=${asset.id}#assets`}
          data-testid="network-detail-manage-discovery"
          className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm font-medium text-muted-foreground hover:text-foreground"
        >
          {t('networkDeviceDetailPage.manageInDiscovery')}
          <ExternalLink className="h-3.5 w-3.5" />
        </a>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b">
        {VALID_TABS.map((tab) => (
          <button
            key={tab}
            type="button"
            data-testid={`network-detail-tab-${tab}`}
            onClick={() => switchTab(tab)}
            className={`-mb-px border-b-2 px-4 py-2 text-sm font-medium capitalize ${
              activeTab === tab
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            {t(/* i18n-dynamic */ `networkDeviceDetailPage.tabs.${tab}`)}
          </button>
        ))}
      </div>

      {activeTab === 'overview' && (
        <div className="grid gap-5 lg:grid-cols-2" data-testid="network-detail-overview">
          <div className="space-y-5">
            <Section title={t('networkDeviceDetailPage.sections.identity')}>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
                <Field label={t('networkDeviceDetailPage.fields.hostname')} value={asset.hostname || '—'} />
                <Field label={t('networkDeviceDetailPage.fields.displayName')} value={asset.label || '—'} />
                <Field label={t('networkDeviceDetailPage.fields.ipAddress')} value={<span className="font-mono">{asset.ip}</span>} />
                <Field label={t('networkDeviceDetailPage.fields.macAddress')} value={<span className="font-mono">{asset.mac}</span>} />
                <Field label={t('networkDeviceDetailPage.fields.manufacturer')} value={asset.manufacturer} />
                <Field label={t('networkDeviceDetailPage.fields.model')} value={extras.model || '—'} />
                <div>
                  <div className="text-xs font-medium text-muted-foreground">{t('networkDeviceDetailPage.fields.assetType')}</div>
                  <div className="mt-1 flex items-center gap-2">
                    <select
                      data-testid="network-asset-type-select"
                      className="rounded-md border bg-background px-2 py-1 text-sm disabled:opacity-60"
                      value={asset.type}
                      disabled={typeSaving}
                      onChange={(e) => void changeType(e.target.value as DiscoveredAssetType)}
                    >
                      {(Object.keys(typeConfig) as DiscoveredAssetType[]).map((type) => (
                        <option key={type} value={type}>{t(/* i18n-dynamic */ typeConfig[type].labelKey)}</option>
                      ))}
                    </select>
                    {asset.typeSource === 'manual' && (
                      <button
                        type="button"
                        data-testid="network-asset-type-reset"
                        className="text-xs text-muted-foreground underline hover:text-foreground disabled:opacity-60"
                        disabled={typeSaving}
                        onClick={() => void changeType('reset')}
                      >
                        {t('networkDeviceDetailPage.resetToAutoDetected')}
                      </button>
                    )}
                  </div>
                  {asset.typeSource === 'manual' && (
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      {asset.detectedType
                        ? t('networkDeviceDetailPage.manuallySetWithDetected', { type: t(/* i18n-dynamic */ typeConfig[asset.detectedType].labelKey) })
                        : t('networkDeviceDetailPage.manuallySet')}
                    </p>
                  )}
                </div>
                {extras.netbiosName && <Field label={t('networkDeviceDetailPage.fields.netbiosName')} value={extras.netbiosName} />}
              </dl>
              {tags.length > 0 && (
                <div className="mt-3 border-t pt-3">
                  <p className="text-xs font-medium text-muted-foreground">{t('networkDeviceDetailPage.fields.tags')}</p>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {tags.map((tag) => (
                      <span key={tag} className="rounded-full border border-muted bg-background px-2 py-0.5 text-xs">
                        {tag}
                      </span>
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
            </Section>

            <Section title={t('networkDeviceDetailPage.sections.snmpData')} testId="network-detail-snmp">
              <dl className="space-y-2 text-sm">
                {Object.keys(snmpData).length === 0 ? (
                  <div className="text-xs text-muted-foreground">
                    {t('networkDeviceDetailPage.emptySnmp')}
                  </div>
                ) : (
                  Object.entries(snmpData).map(([key, value]) => (
                    <div key={key} className="flex items-center justify-between gap-4">
                      <dt className="text-muted-foreground">{snmpFieldLabel(key)}</dt>
                      <dd className="font-medium text-right break-all">{value}</dd>
                    </div>
                  ))
                )}
              </dl>
            </Section>
          </div>

          <div className="space-y-5">
            <Section title={t('networkDeviceDetailPage.sections.networkReachability')}>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
                <Field label={t('networkDeviceDetailPage.fields.status')} value={asset.isOnline ? t('common:states.online') : t('common:states.offline')} />
                <Field
                  label={t('networkDeviceDetailPage.fields.ping')}
                  value={<span className="font-mono" data-testid="network-detail-ping">{formatPing(asset.responseTimeMs)}</span>}
                />
                <Field label={t('networkDeviceDetailPage.fields.osFingerprint')} value={asset.osFingerprint || '—'} />
                <Field label={t('networkDeviceDetailPage.fields.lastSeen')} value={formatTimestamp(asset.lastSeen)} />
                <Field label={t('networkDeviceDetailPage.fields.firstSeen')} value={formatTimestamp(extras.firstSeenAt)} />
              </dl>
            </Section>

            <Section title={t('networkDeviceDetailPage.sections.openPorts')} testId="network-detail-ports">
              {openPorts.length === 0 ? (
                <p className="text-xs text-muted-foreground">{t('networkDeviceDetailPage.emptyPorts')}</p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {openPorts.map((p) => (
                    <span
                      key={p.port}
                      className="rounded-full border border-muted bg-background px-2 py-0.5 text-xs"
                    >
                      {p.port}{p.service ? ` (${p.service})` : ''}
                    </span>
                  ))}
                </div>
              )}
            </Section>
          </div>
        </div>
      )}

      {activeTab === 'monitoring' && (
        <div className="grid gap-5 lg:grid-cols-2" data-testid="network-detail-monitoring">
          <Section title={t('networkDeviceDetailPage.sections.monitoringStatus')}>
            <dl className="space-y-3 text-sm">
              <div className="flex items-center justify-between gap-4">
                <dt className="text-muted-foreground">{t('networkDeviceDetailPage.fields.snmpMonitoring')}</dt>
                <dd className="font-medium">{extras.snmpMonitoringEnabled ? t('common:states.enabled') : t('networkDeviceDetailPage.notConfigured')}</dd>
              </div>
              <div className="flex items-center justify-between gap-4">
                <dt className="text-muted-foreground">{t('networkDeviceDetailPage.fields.networkMonitoring')}</dt>
                <dd className="font-medium">{extras.networkMonitoringEnabled ? t('common:states.enabled') : t('networkDeviceDetailPage.notConfigured')}</dd>
              </div>
            </dl>
            <p className="mt-3 border-t pt-3 text-xs text-muted-foreground">
              {t('networkDeviceDetailPage.configurePrefix')}{' '}
              <a href={`/discovery?asset=${asset.id}#assets`} className="text-primary hover:underline">
                {t('networkDeviceDetailPage.discoveryAssetView')}
              </a>
              .
            </p>
          </Section>

          <Section title={t('networkDeviceDetailPage.sections.discovery')}>
            <dl className="grid grid-cols-1 gap-y-3 text-sm">
              <Field
                label={t('networkDeviceDetailPage.fields.linkedDevice')}
                value={
                  asset.linkedDeviceId ? (
                    <span className="inline-flex items-center gap-3">
                      <a
                        href={`/devices/${asset.linkedDeviceId}`}
                        data-testid="network-detail-linked-device"
                        className="text-primary hover:underline"
                      >
                        {asset.linkedDeviceName || t('networkDeviceDetailPage.viewManagedDevice')}
                      </a>
                      {isManualLink(asset.linkSource) && (
                        <button
                          type="button"
                          data-testid="network-detail-unlink"
                          onClick={handleUnlink}
                          disabled={unlinking}
                          className="text-xs text-destructive hover:underline disabled:opacity-50"
                        >
                          {unlinking ? t('networkDeviceDetailPage.unlinking') : t('networkDeviceDetailPage.unlink')}
                        </button>
                      )}
                    </span>
                  ) : (
                    t('networkDeviceDetailPage.notLinked')
                  )
                }
              />
              <Field
                label={t('networkDeviceDetailPage.fields.discoveryMethods')}
                value={discoveryMethods.length > 0 ? discoveryMethods.join(', ') : '—'}
              />
              <Field label={t('networkDeviceDetailPage.fields.discoveryProfile')} value={asset.profileName || '—'} />
            </dl>
          </Section>
        </div>
      )}
    </div>
  );
}
