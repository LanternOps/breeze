// Network device detail page (route `/devices/network/:id`): owns page-level
// state (tabs and settings) and composes the presentational/data
// modules in `./networkDevice/` — kept thin so each concern stays reviewable
// on its own.

import { useCallback, useEffect, useRef, useState } from 'react';
import { ActionError } from '@/lib/runAction';
import { showToast } from '../shared/Toast';
import { ApprovalBanner } from './networkDevice/ApprovalBanner';
import { resolveAssetTimezone } from './networkDevice/reachabilityCopy';
import { useNetworkAssetMutations } from './networkDevice/settings/useNetworkAssetMutations';
import { useHashState } from '@/lib/useHashState';
import { Activity, LayoutGrid } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { navigateTo } from '@/lib/navigation';
import Breadcrumbs from '../layout/Breadcrumbs';
import { OverflowTabs, overflowPanelId, overflowTabId, type OverflowTab } from '../shared/OverflowTabs';
import { assetTypeIcons } from '../discovery/assetTypeIcon';
import { isWebPort, sortPorts } from '../discovery/portCatalog';
import { typeConfig, approvalStatusConfig } from '../discovery/DiscoveredAssetList';
import type { NetworkDeviceDetailPageProps, Tab } from './networkDevice/types';
import { useNetworkAsset } from './networkDevice/useNetworkAsset';
import { IdentityCard } from './networkDevice/IdentityCard';
import { NetworkDeviceHeader } from './networkDevice/NetworkDeviceHeader';
import { ReachabilityCard } from './networkDevice/ReachabilityCard';
import { resolveHealthCard } from './networkDevice/health';
import { MonitoringTab } from './networkDevice/MonitoringTab';
import { useAssetMonitoring } from './networkDevice/useAssetMonitoring';
import { useAssetProbe } from './networkDevice/useAssetProbe';
import { NetworkDeviceStats } from './networkDevice/NetworkDeviceStats';
import { NetworkDeviceSkeleton } from './networkDevice/NetworkDeviceSkeleton';
import { OpenPortsSection } from './networkDevice/OpenPortsSection';
import { SnmpSection } from './networkDevice/SnmpSection';

import { NetworkAssetSettingsModal } from './networkDevice/settings/NetworkAssetSettingsModal';
import { buildDetailHash, parseDetailHash, type SettingsSection } from './networkDevice/settings/settingsHash';

export default function NetworkDeviceDetailPage({ assetId }: NetworkDeviceDetailPageProps) {
  const { t } = useTranslation('devices');
  const mutations = useNetworkAssetMutations();
  const [approvalBusy, setApprovalBusy] = useState(false);
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

  const { collection, snmpDevice } = useAssetMonitoring(assetId);
  const probeState = useAssetProbe({
    assetId,
    probe: extras.probe,
    onRefresh: () => fetchAsset({ background: true }),
  });

  // --- hash state -----------------------------------------------------------
  // Both halves of `#<tab>[/settings/<section>]` are hash-derived and adopted
  // post-mount (#2421). `parse` returning null is honoured by useHashState —
  // only `undefined` falls back to the default — so a tab-only hash is what
  // CLOSES the modal, which is what makes browser Back close it too.
  const [activeTab, setActiveTab] = useHashState<Tab>('overview', (h) => parseDetailHash(h).tab);
  const [settingsSection, setSettingsSection] = useHashState<SettingsSection | null>(
    null,
    (h) => parseDetailHash(h).settings,
  );

  const goTo = useCallback((tab: Tab, section: SettingsSection | null) => {
    window.location.hash = buildDetailHash(tab, section);
    setActiveTab(tab);
    setSettingsSection(section);
  }, [setActiveTab, setSettingsSection]);

  const switchTab = useCallback((tab: Tab) => goTo(tab, null), [goTo]);
  const openSettings = useCallback((section: SettingsSection) => goTo(activeTab, section), [goTo, activeTab]);
  const closeSettings = useCallback(() => goTo(activeTab, null), [goTo, activeTab]);

  const handleBack = () => {
    void navigateTo('/devices');
  };

  // The "Open ports" stat is a shortcut to the ports section, not just a
  // second place that repeats its count — this flag survives the tab-switch
  // render so the scroll only fires once the overview panel (and the ports
  // section inside it) is actually back in the DOM, and never on an
  // unrelated tab change (URL back/forward, clicking a tab directly).
  const overviewPanelRef = useRef<HTMLDivElement>(null);
  const monitoringPanelRef = useRef<HTMLDivElement>(null);
  const portsSectionRef = useRef<HTMLDivElement>(null);
  const [pendingPortsScroll, setPendingPortsScroll] = useState(false);
  const handleViewPorts = useCallback(() => {
    setPendingPortsScroll(true);
    switchTab('overview');
  }, [switchTab]);
  useEffect(() => {
    if (!pendingPortsScroll || activeTab !== 'overview') return;
    portsSectionRef.current?.scrollIntoView?.({ block: 'start' });
    portsSectionRef.current?.focus();
    setPendingPortsScroll(false);
  }, [pendingPortsScroll, activeTab]);

  // Shortcuts move keyboard focus along with the viewport.
  const [pendingMonitoringFocus, setPendingMonitoringFocus] = useState(false);
  const handleViewMonitoring = useCallback(() => {
    setPendingMonitoringFocus(true);
    switchTab('monitoring');
  }, [switchTab]);
  useEffect(() => {
    if (!pendingMonitoringFocus || activeTab !== 'monitoring') return;
    monitoringPanelRef.current?.focus();
    setPendingMonitoringFocus(false);
  }, [pendingMonitoringFocus, activeTab]);

  // Lifted here (rather than local to OpenPortsSection) because that section
  // unmounts whenever the Monitoring tab is active — local state would reset
  // "Show all" on every tab round-trip.
  const [portsExpanded, setPortsExpanded] = useState(false);
  if (loading) {
    return <NetworkDeviceSkeleton label={t('networkDeviceDetailPage.loading')} />;
  }

  if (error || !asset) {
    return (
      <div className="space-y-6" data-testid="network-device-detail-error">
        {/* Same breadcrumb the loaded page renders (below) — an error must
            not drop the operator into a different navigational frame. */}
        <Breadcrumbs items={[
          { label: t('devicesPage.title'), href: '/devices#deviceClass=network' },
          { label: t('networkDeviceDetailPage.networkDevice') },
        ]} />
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
  const timezone = resolveAssetTimezone(extras.siteTimezone);
  const HealthCard = resolveHealthCard({ assetType: asset.type, collection, snmpEnabled: !!extras.snmpMonitoringEnabled });
  const bridgeDeviceId = extras.suggestedBridgeDeviceId ?? null;
  const bridgeDeviceName = devices.find((device) => device.id === bridgeDeviceId)?.name ?? null;
  // `mapAsset` normalizes `type` to a valid key, but `approvalStatus` is passed
  // through raw — guard both lookups so an out-of-enum value from the API can't
  // throw during render (which, with no error boundary, would blank the page).
  const typeMeta = typeConfig[asset.type];
  const approvalMeta = approvalStatusConfig[asset.approvalStatus];
  const typeLabel = typeMeta ? t(/* i18n-dynamic */ typeMeta.labelKey) : asset.type;
  const approvalLabel = approvalMeta ? t(/* i18n-dynamic */ approvalMeta.labelKey) : asset.approvalStatus;
  const TypeIcon = assetTypeIcons[asset.type] ?? assetTypeIcons.unknown;
  const tabDefs: OverflowTab[] = [
    { id: 'overview', label: t('networkDeviceDetailPage.tabs.overview'), icon: <LayoutGrid aria-hidden="true" className="h-4 w-4" /> },
    { id: 'monitoring', label: t('networkDeviceDetailPage.tabs.monitoring'), icon: <Activity aria-hidden="true" className="h-4 w-4" /> },
  ];
  // Must match the `testIdPrefix` passed to OverflowTabs below — it's the
  // same string OverflowTabs uses internally (via `overflowPanelId`) to build
  // each tab button's `aria-controls` target, which each `role="tabpanel"`
  // below supplies as its own `id`.
  const TAB_ID_PREFIX = 'network-detail-tab-';

  return (
    <div className="space-y-6" data-testid="network-device-detail">
      {/* Screen-reader-only outcome announcements — see the `announce`
          callback in useNetworkAsset for what posts here and why. */}
      <div aria-live="polite" aria-atomic="true" className="sr-only" data-testid="network-detail-live">
        {liveMessage}
      </div>
      <Breadcrumbs items={[
        { label: t('devicesPage.title'), href: '/devices#deviceClass=network' },
        { label: displayName || t('networkDeviceDetailPage.networkDevice') },
      ]} />

      <ApprovalBanner
        approvalStatus={asset.approvalStatus}
        busy={approvalBusy}
        onApprove={async () => {
          setApprovalBusy(true);
          try {
            await mutations.approve(asset.id);
            if (!await fetchAsset({ background: true })) {
              showToast({ type: 'error', message: t('networkDeviceDetailPage.settings.refreshFailed') });
            }
            announce(t('networkDeviceDetailPage.approval.approvedAnnouncement'));
          } catch (err) {
            if (err instanceof ActionError && err.status === 401) return;
            if (!(err instanceof ActionError)) {
              showToast({ type: 'error', message: t('networkDeviceDetailPage.errors.unexpected') });
            }
          } finally {
            setApprovalBusy(false);
          }
        }}
        onDismiss={async () => {
          setApprovalBusy(true);
          try {
            await mutations.dismiss(asset.id);
            if (!await fetchAsset({ background: true })) {
              showToast({ type: 'error', message: t('networkDeviceDetailPage.settings.refreshFailed') });
            }
            announce(t('networkDeviceDetailPage.approval.dismissedAnnouncement'));
          } catch (err) {
            if (err instanceof ActionError && err.status === 401) return;
            if (!(err instanceof ActionError)) {
              showToast({ type: 'error', message: t('networkDeviceDetailPage.errors.unexpected') });
            }
          } finally {
            setApprovalBusy(false);
          }
        }}
      />

      <NetworkDeviceHeader
        asset={asset}
        lastError={snmpDevice?.lastError ?? null}
        reachability={extras.reachability ?? null}
        timezone={resolveAssetTimezone(extras.siteTimezone)}
        nicVendor={extras.nicVendor ?? null}
        displayName={displayName}
        siteName={extras.siteName ?? null}
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
        onOpenSettings={() => openSettings('identity')}
      />

      <NetworkDeviceStats
        asset={asset}
        reachability={extras.reachability ?? null}
        collection={collection}
        timezone={resolveAssetTimezone(extras.siteTimezone)}
        probeState={probeState}
        onViewPorts={handleViewPorts}
        onViewMonitoring={handleViewMonitoring}
      />

      <OverflowTabs
        tabs={tabDefs}
        activeTab={activeTab}
        onTabChange={(id) => switchTab(id as Tab)}
        testIdPrefix={TAB_ID_PREFIX}
      />

      {activeTab === 'overview' && (
        <div
          className="space-y-5"
          data-testid="network-detail-overview"
          role="tabpanel"
          id={overflowPanelId('overview', TAB_ID_PREFIX)}
          aria-labelledby={overflowTabId('overview', TAB_ID_PREFIX)}
          tabIndex={-1}
          ref={overviewPanelRef}
        >
          <div className="grid gap-5 lg:grid-cols-3">
            <div className="min-w-0 lg:col-span-2">
              <HealthCard
                assetId={asset.id}
                assetType={asset.type}
                collection={collection}
                snmpEnabled={!!extras.snmpMonitoringEnabled}
                timezone={timezone}
                onSetUpMonitoring={() => openSettings('monitoring')}
                onViewMonitoring={handleViewMonitoring}
              />
            </div>
            <div className="min-w-0">
              <ReachabilityCard
                reachability={extras.reachability ?? null}
                collection={collection}
                timezone={timezone}
                bridgeDeviceId={bridgeDeviceId}
                bridgeDeviceName={bridgeDeviceName}
                probeState={probeState}
                onViewMonitoring={handleViewMonitoring}
              />
            </div>
          </div>
          <div className="space-y-5">
            <IdentityCard
              asset={asset}
              extras={extras}
              timezone={resolveAssetTimezone(extras.siteTimezone)}
              onAnnounce={announce}
              onEditIdentity={() => openSettings('identity')}
            />

            {!asset.linkedDeviceId && extras.autoLinkSuppressedAt && (
              <p className="text-xs text-muted-foreground" data-testid="network-detail-suppressed">
                {t('networkDeviceDetailPage.autoLinkSuppressed')}
              </p>
            )}
            <button
              type="button"
              data-testid="network-detail-edit-link"
              onClick={() => openSettings('link')}
              className="text-xs text-primary hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
            >
              {t('networkDeviceDetailPage.settings.openLinkSettings')}
            </button>
            <SnmpSection snmpData={snmpData} />
          </div>

          <div className="space-y-5">
            <OpenPortsSection
              sectionRef={portsSectionRef}
              openPorts={openPorts}
              assetId={asset.id}
              assetIp={asset.ip}
              suggestedBridgeDeviceId={extras.suggestedBridgeDeviceId ?? null}
              devices={devices}
              devicesError={devicesError}
              onRetryDevices={fetchDevices}
              onAnnounce={announce}
              expanded={portsExpanded}
              onToggle={() => setPortsExpanded((expanded) => !expanded)}
            />
          </div>
        </div>
      )}

      {activeTab === 'monitoring' && (
        <div
          className="space-y-5"
          data-testid="network-detail-monitoring"
          role="tabpanel"
          id={overflowPanelId('monitoring', TAB_ID_PREFIX)}
          aria-labelledby={overflowTabId('monitoring', TAB_ID_PREFIX)}
          tabIndex={-1}
          ref={monitoringPanelRef}
        >
          <MonitoringTab
            assetId={asset.id}
            timezone={timezone}
            onOpenMonitoringSettings={() => openSettings('monitoring')}
          />
        </div>
      )}

      <NetworkAssetSettingsModal
        open={settingsSection !== null}
        section={settingsSection}
        assetId={asset.id}
        asset={asset}
        extras={extras}
        onSectionChange={(section) => openSettings(section)}
        onClose={closeSettings}
        // `background: true`: a save must not flip `loading` and swap the whole
        // page for the skeleton under an open modal.
        onSaved={() => fetchAsset({ background: true })}
        onAnnounce={announce}
      />
    </div>
  );
}
