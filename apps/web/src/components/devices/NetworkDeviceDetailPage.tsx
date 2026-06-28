import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, Globe, ExternalLink, Wifi, WifiOff } from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';
import { runAction } from '../../lib/runAction';
import { isManualLink } from '../discovery/networkTypes';
import { navigateTo } from '@/lib/navigation';
import { formatDateTime } from '@/lib/dateTimeFormat';
import Breadcrumbs from '../layout/Breadcrumbs';
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
  return `${ms.toFixed(1)} ms`;
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
          throw new Error('Network device not found');
        }
        throw new Error('Failed to load network device');
      }

      const body = await response.json();
      const raw: (ApiDiscoveryAsset & AssetDetailExtras) | undefined =
        body?.data ?? body?.asset ?? body;
      // A 200 with an empty/wrong-shaped body would otherwise sail through
      // `mapAsset` (which never returns null) and render a blank "—" shell with
      // an `asset=undefined` deep-link. Treat a missing id as a load failure.
      if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string') {
        throw new Error('Network device response was malformed');
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
      setError(err instanceof Error ? err.message : 'Failed to load network device');
    } finally {
      setLoading(false);
    }
  }, [assetId]);

  useEffect(() => {
    void fetchAsset();
  }, [fetchAsset]);

  const handleBack = () => {
    void navigateTo('/devices');
  };

  const [unlinking, setUnlinking] = useState(false);

  // The Unlink button only renders for manual links (see render guard below) and
  // the server independently rejects non-manual unlinks; this handler guards only
  // that a link exists. runAction surfaces success/failure via toast.
  const handleUnlink = useCallback(async () => {
    if (!asset?.linkedDeviceId) return;
    if (typeof window !== 'undefined' && !window.confirm('Unlink this device?')) return;
    setUnlinking(true);
    try {
      await runAction({
        request: () => fetchWithAuth(`/discovery/assets/${asset.id}/link`, { method: 'DELETE' }),
        successMessage: 'Device unlinked.',
        errorFallback: 'Failed to unlink device.',
      });
      await fetchAsset();
    } catch {
      // runAction already toasted the failure; leave the linked state in place.
    } finally {
      setUnlinking(false);
    }
  }, [asset, fetchAsset]);

  // Manual override of the scan-detected device type. `reset` restores the
  // auto-detected classification; any other value pins the type as a manual
  // override (server stamps type_source='manual'). runAction surfaces the
  // outcome via toast; we refetch on success so the badge/select reflect the
  // server's canonical state.
  const changeType = useCallback(
    async (next: DiscoveredAssetType | 'reset') => {
      if (!asset) return;
      try {
        await runAction({
          request: () =>
            fetchWithAuth(`/discovery/assets/${asset.id}`, {
              method: 'PATCH',
              body: JSON.stringify(
                next === 'reset' ? { resetTypeToAuto: true } : { assetType: next },
              ),
            }),
          successMessage: next === 'reset' ? 'Type reset to auto-detected' : 'Device type updated',
          errorFallback:
            next === 'reset' ? 'Failed to reset device type.' : 'Failed to update device type.',
        });
        await fetchAsset();
      } catch {
        // runAction already toasted the failure; leave the current type in place.
      }
    },
    [asset, fetchAsset],
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12" data-testid="network-device-detail-loading">
        <div className="text-center">
          <div className="mx-auto h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          <p className="mt-4 text-sm text-muted-foreground">Loading network device...</p>
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
          Back to devices
        </button>
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
          <p className="text-sm text-destructive">{error || 'Network device not found'}</p>
          <button
            type="button"
            onClick={handleBack}
            className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            Go back
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
  const typeMeta = typeConfig[asset.type] ?? { label: asset.type, color: typeConfig.unknown.color };
  const approvalMeta = approvalStatusConfig[asset.approvalStatus] ??
    { label: asset.approvalStatus, color: approvalStatusConfig.dismissed.color };

  return (
    <div className="space-y-6" data-testid="network-device-detail">
      <Breadcrumbs items={[
        { label: 'Devices', href: '/devices' },
        { label: displayName || 'Network Device' },
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
                className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${typeMeta.color}`}
              >
                {typeMeta.label}
              </span>
              <span
                className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${approvalMeta.color}`}
              >
                {approvalMeta.label}
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
                {asset.isOnline ? 'Online' : 'Offline'}
              </span>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              {asset.ip}
              {asset.mac !== '—' && <> • {asset.mac}</>}
              {asset.manufacturer !== '—' && <> • {asset.manufacturer}</>}
              {asset.lastSeen && <> • Last seen {formatTimestamp(asset.lastSeen)}</>}
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
          Manage in Discovery
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
            {tab}
          </button>
        ))}
      </div>

      {activeTab === 'overview' && (
        <div className="grid gap-5 lg:grid-cols-2" data-testid="network-detail-overview">
          <div className="space-y-5">
            <Section title="Identity">
              <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
                <Field label="Hostname" value={asset.hostname || '—'} />
                <Field label="Display Name" value={asset.label || '—'} />
                <Field label="IP Address" value={<span className="font-mono">{asset.ip}</span>} />
                <Field label="MAC Address" value={<span className="font-mono">{asset.mac}</span>} />
                <Field label="Manufacturer" value={asset.manufacturer} />
                <Field label="Model" value={extras.model || '—'} />
                <div>
                  <div className="text-xs font-medium text-muted-foreground">Asset Type</div>
                  <div className="mt-1 flex items-center gap-2">
                    <select
                      data-testid="network-asset-type-select"
                      className="rounded-md border bg-background px-2 py-1 text-sm"
                      value={asset.type}
                      onChange={(e) => void changeType(e.target.value as DiscoveredAssetType)}
                    >
                      {(Object.keys(typeConfig) as DiscoveredAssetType[]).map((t) => (
                        <option key={t} value={t}>{typeConfig[t].label}</option>
                      ))}
                    </select>
                    {asset.typeSource === 'manual' && (
                      <button
                        type="button"
                        data-testid="network-asset-type-reset"
                        className="text-xs text-muted-foreground underline hover:text-foreground"
                        onClick={() => void changeType('reset')}
                      >
                        Reset to auto-detected
                      </button>
                    )}
                  </div>
                  {asset.typeSource === 'manual' && (
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      Manually set{asset.detectedType ? ` · scan detected ${typeConfig[asset.detectedType].label}` : ''}
                    </p>
                  )}
                </div>
                {extras.netbiosName && <Field label="NetBIOS Name" value={extras.netbiosName} />}
              </dl>
              {tags.length > 0 && (
                <div className="mt-3 border-t pt-3">
                  <p className="text-xs font-medium text-muted-foreground">Tags</p>
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
                  <p className="text-xs font-medium text-muted-foreground">Notes</p>
                  <p className="mt-1 text-sm whitespace-pre-wrap">{asset.notes}</p>
                </div>
              )}
            </Section>

            <Section title="SNMP Data" testId="network-detail-snmp">
              <dl className="space-y-2 text-sm">
                {Object.keys(snmpData).length === 0 ? (
                  <div className="text-xs text-muted-foreground">
                    No SNMP data was collected — the device may not have responded, or SNMP was not
                    probed. Check that the SNMP method is enabled and the community string is set on
                    the discovery profile.
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
            <Section title="Network & Reachability">
              <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
                <Field label="Status" value={asset.isOnline ? 'Online' : 'Offline'} />
                <Field
                  label="Ping"
                  value={<span className="font-mono" data-testid="network-detail-ping">{formatPing(asset.responseTimeMs)}</span>}
                />
                <Field label="OS Fingerprint" value={asset.osFingerprint || '—'} />
                <Field label="Last Seen" value={formatTimestamp(asset.lastSeen)} />
                <Field label="First Seen" value={formatTimestamp(extras.firstSeenAt)} />
              </dl>
            </Section>

            <Section title="Open Ports" testId="network-detail-ports">
              {openPorts.length === 0 ? (
                <p className="text-xs text-muted-foreground">No open ports detected.</p>
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
          <Section title="Monitoring Status">
            <dl className="space-y-3 text-sm">
              <div className="flex items-center justify-between gap-4">
                <dt className="text-muted-foreground">SNMP Monitoring</dt>
                <dd className="font-medium">{extras.snmpMonitoringEnabled ? 'Enabled' : 'Not configured'}</dd>
              </div>
              <div className="flex items-center justify-between gap-4">
                <dt className="text-muted-foreground">Network Monitoring</dt>
                <dd className="font-medium">{extras.networkMonitoringEnabled ? 'Enabled' : 'Not configured'}</dd>
              </div>
            </dl>
            <p className="mt-3 border-t pt-3 text-xs text-muted-foreground">
              Configure SNMP polling and network monitors from the{' '}
              <a href={`/discovery?asset=${asset.id}#assets`} className="text-primary hover:underline">
                Discovery asset view
              </a>
              .
            </p>
          </Section>

          <Section title="Discovery">
            <dl className="grid grid-cols-1 gap-y-3 text-sm">
              <Field
                label="Linked Device"
                value={
                  asset.linkedDeviceId ? (
                    <span className="inline-flex items-center gap-3">
                      <a
                        href={`/devices/${asset.linkedDeviceId}`}
                        data-testid="network-detail-linked-device"
                        className="text-primary hover:underline"
                      >
                        {asset.linkedDeviceName || 'View managed device'}
                      </a>
                      {isManualLink(asset.linkSource) && (
                        <button
                          type="button"
                          data-testid="network-detail-unlink"
                          onClick={handleUnlink}
                          disabled={unlinking}
                          className="text-xs text-destructive hover:underline disabled:opacity-50"
                        >
                          {unlinking ? 'Unlinking…' : 'Unlink'}
                        </button>
                      )}
                    </span>
                  ) : (
                    'Not linked'
                  )
                }
              />
              <Field
                label="Discovery Methods"
                value={discoveryMethods.length > 0 ? discoveryMethods.join(', ') : '—'}
              />
              <Field label="Discovery Profile" value={asset.profileName || '—'} />
            </dl>
          </Section>
        </div>
      )}
    </div>
  );
}
