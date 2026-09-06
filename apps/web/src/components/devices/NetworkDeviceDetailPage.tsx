// Network device detail page (route `/devices/network/:id`): owns page-level
// state (tab, type-editor, unlink) and composes the presentational/data
// modules in `./networkDevice/` — kept thin so each concern stays reviewable
// on its own.

import { useCallback, useState } from 'react';
import { useHashState } from '@/lib/useHashState';
import { ArrowLeft, Activity, LayoutGrid } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { fetchWithAuth } from '../../stores/auth';
import { runAction } from '../../lib/runAction';
import { isManualLink } from '../discovery/networkTypes';
import { navigateTo } from '@/lib/navigation';
import Breadcrumbs from '../layout/Breadcrumbs';
import { OverflowTabs, overflowTabId, type OverflowTab } from '../shared/OverflowTabs';
import { ConfirmDialog } from '../shared/ConfirmDialog';
import { assetTypeIcons } from '../discovery/assetTypeIcon';
import { isWebPort, sortPorts } from '../discovery/portCatalog';
import { typeConfig, approvalStatusConfig, type DiscoveredAssetType } from '../discovery/DiscoveredAssetList';
import type { NetworkDeviceDetailPageProps, Tab } from './networkDevice/types';
import { VALID_TABS } from './networkDevice/types';
import { formatTimestamp } from './networkDevice/format';
import { Section, Field } from './networkDevice/primitives';
import { useNetworkAsset } from './networkDevice/useNetworkAsset';
import { NetworkDeviceHeader } from './networkDevice/NetworkDeviceHeader';
import { NetworkDeviceStats } from './networkDevice/NetworkDeviceStats';
import { NetworkDeviceSkeleton } from './networkDevice/NetworkDeviceSkeleton';
import { OpenPortsSection } from './networkDevice/OpenPortsSection';
import { SnmpSection } from './networkDevice/SnmpSection';
import { LinkManuallyControl } from './networkDevice/LinkManuallyControl';

export default function NetworkDeviceDetailPage({ assetId }: NetworkDeviceDetailPageProps) {
  const { t } = useTranslation('devices');
  const {
    asset,
    extras,
    loading,
    error,
    liveMessage,
    announce,
    fetchAsset,
    devices,
    devicesError,
    fetchDevices,
  } = useNetworkAsset(assetId);

  // Hash-derived tab adopted post-mount to avoid an SSR hydration mismatch
  // (#2421); the hook also syncs back/forward via hashchange.
  const [activeTab, setActiveTab] = useHashState<Tab>('overview', (h) => {
    const seg = h.split('/')[0] ?? '';
    return (VALID_TABS as readonly string[]).includes(seg) ? (seg as Tab) : undefined;
  });

  const switchTab = (tab: Tab) => {
    window.location.hash = tab;
    setActiveTab(tab);
  };

  const handleBack = () => {
    void navigateTo('/devices');
  };

  const [unlinking, setUnlinking] = useState(false);
  // Which type-editor action (if any) is in flight — distinct from a plain
  // boolean so Save and Reset can each show their own loading label without
  // the other one flashing the wrong text while it's merely disabled.
  const [typeAction, setTypeAction] = useState<'save' | 'reset' | null>(null);
  const typeSaving = typeAction !== null;
  const [confirmUnlinkOpen, setConfirmUnlinkOpen] = useState(false);
  // Uncommitted type-select value. Arrowing through a native <select> with a
  // keyboard fires a change event per option landed on, so committing on
  // change used to PATCH once per arrow key — this decouples the control's
  // value from the save action. `null` means "no pending edit, show the
  // asset's saved type"; the Save/Cancel row only appears once this differs
  // from `asset.type`.
  const [pendingType, setPendingType] = useState<DiscoveredAssetType | null>(null);

  // Unlink now works for both auto and manual links (#3261 Task 2 reverses the
  // old manual-only rule — the server sets auto_link_suppressed_at so a
  // subsequent rescan doesn't just re-create the link). This handler only
  // guards that a link exists; runAction surfaces success/failure via toast.
  // Confirmation lives in the ConfirmDialog rendered at the bottom of this
  // component — this handler runs only after the user has confirmed.
  const handleUnlink = useCallback(async () => {
    if (!asset?.linkedDeviceId) return;
    setUnlinking(true);
    try {
      await runAction({
        request: () => fetchWithAuth(`/discovery/assets/${asset.id}/link`, { method: 'DELETE' }),
        successMessage: t('networkDeviceDetailPage.toasts.unlinked'),
        errorFallback: t('networkDeviceDetailPage.toasts.unlinkFailed'),
      });
      await fetchAsset();
      announce(t('networkDeviceDetailPage.toasts.unlinked'));
    } catch {
      // runAction already toasted the failure; leave the linked state in place.
    } finally {
      setUnlinking(false);
    }
  }, [asset, fetchAsset, t, announce]);

  // Manual override of the scan-detected device type. `reset` restores the
  // auto-detected classification; any other value pins the type as a manual
  // override (server stamps type_source='manual'). runAction surfaces the
  // outcome via toast; we refetch on success so the badge/select reflect the
  // server's canonical state. Returns whether the change actually committed,
  // so the Save button (below) knows whether to clear its pending selection.
  const changeType = useCallback(
    async (next: DiscoveredAssetType | 'reset'): Promise<boolean> => {
      if (!asset) return false;
      setTypeAction(next === 'reset' ? 'reset' : 'save');
      let succeeded = false;
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
        succeeded = true;
        announce(
          next === 'reset'
            ? t('networkDeviceDetailPage.toasts.typeReset')
            : t('networkDeviceDetailPage.toasts.typeUpdated'),
        );
      } catch {
        // runAction already toasted the failure; leave the current type in place.
      } finally {
        setTypeAction(null);
      }
      return succeeded;
    },
    [asset, fetchAsset, t, announce],
  );

  // Reset also discards any uncommitted select edit — its whole point is to
  // throw away manual overrides, so a pending one shouldn't survive it either.
  const handleResetType = useCallback(() => {
    setPendingType(null);
    void changeType('reset');
  }, [changeType]);

  const handleSaveType = useCallback(async () => {
    if (pendingType === null) return;
    const succeeded = await changeType(pendingType);
    if (succeeded) setPendingType(null);
  }, [pendingType, changeType]);

  const handleCancelType = useCallback(() => setPendingType(null), []);

  if (loading) {
    return <NetworkDeviceSkeleton label={t('networkDeviceDetailPage.loading')} />;
  }

  if (error || !asset) {
    return (
      <div className="space-y-6" data-testid="network-device-detail-error">
        <button
          type="button"
          onClick={handleBack}
          className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ArrowLeft aria-hidden="true" className="h-4 w-4" />
          {t('networkDeviceDetailPage.backToDevices')}
        </button>
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
          <p className="text-sm text-destructive">{error || t('networkDeviceDetailPage.errors.notFound')}</p>
          <div className="mt-4 flex items-center justify-center gap-2">
            <button
              type="button"
              data-testid="network-detail-retry"
              onClick={() => void fetchAsset()}
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
            >
              {t('networkDeviceDetailPage.tryAgain')}
            </button>
            <button
              type="button"
              onClick={handleBack}
              className="rounded-md border px-4 py-2 text-sm font-medium text-muted-foreground hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
            >
              {t('networkDeviceDetailPage.goBack')}
            </button>
          </div>
        </div>
      </div>
    );
  }

  const displayName = asset.label || asset.hostname || asset.ip;
  const openPorts = sortPorts(asset.openPorts ?? []);
  // Page-level proxy entry point: default to the first scanned web-ish port,
  // else 443 — so the action exists even when the scan recorded no ports.
  const defaultWebPort = openPorts.find((p) => isWebPort(p.port, p.service));
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
  const TypeIcon = assetTypeIcons[asset.type] ?? assetTypeIcons.unknown;
  // The select shows the uncommitted choice while one is pending, else the
  // asset's saved type; Save only appears once the two actually differ.
  const selectedType = pendingType ?? asset.type;
  const typeDirty = pendingType !== null && pendingType !== asset.type;

  const tabDefs: OverflowTab[] = [
    { id: 'overview', label: t('networkDeviceDetailPage.tabs.overview'), icon: <LayoutGrid aria-hidden="true" className="h-4 w-4" /> },
    { id: 'monitoring', label: t('networkDeviceDetailPage.tabs.monitoring'), icon: <Activity aria-hidden="true" className="h-4 w-4" /> },
  ];
  // Must match the `testIdPrefix` passed to OverflowTabs below — it's the
  // same string OverflowTabs uses internally (via `overflowTabId`) to build
  // each tab button's `id`, which each `role="tabpanel"` below points back to.
  const TAB_ID_PREFIX = 'network-detail-tab-';

  return (
    <div className="max-w-6xl space-y-6" data-testid="network-device-detail">
      {/* Screen-reader-only outcome announcements — see the `announce`
          callback in useNetworkAsset for what posts here and why. */}
      <div aria-live="polite" aria-atomic="true" className="sr-only" data-testid="network-detail-live">
        {liveMessage}
      </div>
      <Breadcrumbs items={[
        { label: t('devicesPage.title'), href: '/devices' },
        { label: displayName || t('networkDeviceDetailPage.networkDevice') },
      ]} />

      <NetworkDeviceHeader
        asset={asset}
        displayName={displayName}
        typeMeta={typeMeta}
        typeLabel={typeLabel}
        approvalMeta={approvalMeta}
        approvalLabel={approvalLabel}
        TypeIcon={TypeIcon}
        defaultWebPort={defaultWebPort}
        suggestedBridgeDeviceId={extras.suggestedBridgeDeviceId ?? null}
        devices={devices}
        devicesError={devicesError}
        onRetryDevices={fetchDevices}
        onAnnounce={announce}
      />

      <NetworkDeviceStats asset={asset} />

      <OverflowTabs
        tabs={tabDefs}
        activeTab={activeTab}
        onTabChange={(id) => switchTab(id as Tab)}
        testIdPrefix={TAB_ID_PREFIX}
      />

      {activeTab === 'overview' && (
        <div
          className="grid gap-5 lg:grid-cols-2"
          data-testid="network-detail-overview"
          role="tabpanel"
          aria-labelledby={overflowTabId('overview', TAB_ID_PREFIX)}
        >
          <div className="space-y-5">
            <Section title={t('networkDeviceDetailPage.sections.identity')}>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
                <Field label={t('networkDeviceDetailPage.fields.hostname')} value={asset.hostname || '—'} />
                <Field label={t('networkDeviceDetailPage.fields.displayName')} value={asset.label || '—'} />
                <Field label={t('networkDeviceDetailPage.fields.manufacturer')} value={asset.manufacturer} />
                <Field label={t('networkDeviceDetailPage.fields.model')} value={extras.model || '—'} />
                <Field label={t('networkDeviceDetailPage.fields.osFingerprint')} value={asset.osFingerprint || '—'} />
                <Field label={t('networkDeviceDetailPage.fields.firstSeen')} value={formatTimestamp(extras.firstSeenAt)} />
                <div>
                  <div className="text-xs font-medium text-muted-foreground">{t('networkDeviceDetailPage.fields.assetType')}</div>
                  <div className="mt-1 flex items-center gap-2">
                    <select
                      data-testid="network-asset-type-select"
                      className="rounded-md border bg-background px-2 py-1 text-sm disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                      value={selectedType}
                      disabled={typeSaving}
                      onChange={(e) => setPendingType(e.target.value as DiscoveredAssetType)}
                      onKeyDown={(e) => {
                        if (e.key === 'Escape' && typeDirty) {
                          e.preventDefault();
                          handleCancelType();
                        }
                      }}
                    >
                      {(Object.keys(typeConfig) as DiscoveredAssetType[]).map((type) => (
                        <option key={type} value={type}>{t(/* i18n-dynamic */ typeConfig[type].labelKey)}</option>
                      ))}
                    </select>
                    {typeDirty && (
                      <>
                        <button
                          type="button"
                          data-testid="network-detail-type-save"
                          className="text-xs font-medium text-primary hover:underline disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                          disabled={typeSaving}
                          onClick={() => void handleSaveType()}
                        >
                          {typeAction === 'save' ? t('networkDeviceDetailPage.savingType') : t('common:actions.save')}
                        </button>
                        <button
                          type="button"
                          data-testid="network-detail-type-cancel"
                          className="text-xs text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                          disabled={typeSaving}
                          onClick={handleCancelType}
                        >
                          {t('common:actions.cancel')}
                        </button>
                      </>
                    )}
                    {asset.typeSource === 'manual' && (
                      <button
                        type="button"
                        data-testid="network-asset-type-reset"
                        className="text-xs text-muted-foreground underline hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                        disabled={typeSaving}
                        onClick={handleResetType}
                      >
                        {typeAction === 'reset' ? t('networkDeviceDetailPage.resettingType') : t('networkDeviceDetailPage.resetToAutoDetected')}
                      </button>
                    )}
                  </div>
                  {asset.typeSource === 'manual' && (
                    <p className="mt-1 text-xs text-muted-foreground">
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

            <SnmpSection snmpData={snmpData} />
          </div>

          <div className="space-y-5">
            <OpenPortsSection
              openPorts={openPorts}
              assetId={asset.id}
              assetIp={asset.ip}
              suggestedBridgeDeviceId={extras.suggestedBridgeDeviceId ?? null}
              devices={devices}
              devicesError={devicesError}
              onRetryDevices={fetchDevices}
              onAnnounce={announce}
            />
          </div>
        </div>
      )}

      {activeTab === 'monitoring' && (
        <div
          className="grid gap-5 lg:grid-cols-2"
          data-testid="network-detail-monitoring"
          role="tabpanel"
          aria-labelledby={overflowTabId('monitoring', TAB_ID_PREFIX)}
        >
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
              <a href={`/discovery?asset=${asset.id}#assets`} className="text-primary hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring">
                {t('networkDeviceDetailPage.discoveryAssetView')}
              </a>
            </p>
          </Section>

          <Section title={t('networkDeviceDetailPage.sections.discovery')}>
            <dl className="grid grid-cols-1 gap-y-3 text-sm">
              <Field
                label={t('networkDeviceDetailPage.fields.linkedDevice')}
                value={
                  asset.linkedDeviceId ? (
                    <span className="flex flex-wrap items-center gap-3">
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
                      <button
                        type="button"
                        data-testid="network-detail-unlink"
                        onClick={() => setConfirmUnlinkOpen(true)}
                        disabled={unlinking}
                        className="text-xs text-destructive hover:underline disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        {unlinking ? t('networkDeviceDetailPage.unlinking') : t('networkDeviceDetailPage.unlink')}
                      </button>
                    </span>
                  ) : (
                    <div className="space-y-1.5">
                      <p>{t('networkDeviceDetailPage.notLinked')}</p>
                      {extras.autoLinkSuppressedAt && (
                        <p className="text-xs text-muted-foreground" data-testid="network-detail-suppressed">
                          {t('networkDeviceDetailPage.autoLinkSuppressed')}
                        </p>
                      )}
                      <LinkManuallyControl
                        assetId={asset.id}
                        siteId={extras.siteId ?? null}
                        onLinked={fetchAsset}
                      />
                    </div>
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

      <ConfirmDialog
        open={confirmUnlinkOpen}
        onClose={() => setConfirmUnlinkOpen(false)}
        onConfirm={() => {
          setConfirmUnlinkOpen(false);
          void handleUnlink();
        }}
        title={t('networkDeviceDetailPage.confirmUnlink')}
        message={t('networkDeviceDetailPage.confirmUnlinkMessage')}
        confirmLabel={t('networkDeviceDetailPage.unlink')}
        variant="destructive"
        isLoading={unlinking}
        confirmTestId="network-detail-unlink-confirm"
      />
    </div>
  );
}
