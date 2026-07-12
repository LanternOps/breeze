import { useEffect, useState, useCallback } from 'react';
import { Globe, ExternalLink } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { DiscoveredAsset, OpenPortEntry, DiscoveredAssetType } from './DiscoveredAssetList';
import { typeConfig, approvalStatusConfig } from './DiscoveredAssetList';
import AssetMonitoringSection from './AssetMonitoringSection';
import { Dialog } from '../shared/Dialog';
import { fetchWithAuth } from '../../stores/auth';
import { extractApiError } from '../../lib/apiError';
import { formatDateTime } from '@/lib/dateTimeFormat';
import { buildRemoteProxyPageUrl } from '@/lib/remoteTunnelUrls';
import { isManualLink, type DiscoveredAssetLinkSource } from './networkTypes';
import { formatNumber } from '@/lib/i18n/format';

export type AssetDetail = DiscoveredAsset & {
  openPorts?: OpenPortEntry[];
  osFingerprint?: string;
  snmpData?: Record<string, string>;
  linkedDeviceId?: string | null;
  linkSource?: DiscoveredAssetLinkSource | null;
  label?: string | null;
  notes?: string | null;
  tags?: string[];
};

// Friendly labels for the scalar SNMP system OIDs the discovery scan collects.
const SNMP_FIELD_LABEL_KEYS: Record<string, string> = {
  sysName: 'assetDetailModal.snmpFields.systemName',
  sysDescr: 'common:labels.description',
  sysObjectId: 'assetDetailModal.snmpFields.objectId'
};

function snmpFieldLabel(key: string, t: (key: string) => string): string {
  return SNMP_FIELD_LABEL_KEYS[key] ? t(/* i18n-dynamic */ SNMP_FIELD_LABEL_KEYS[key]) : key;
}

type AssetDetailModalProps = {
  open: boolean;
  asset?: AssetDetail | null;
  /** While the detail is being fetched (topology click / deep link). */
  loading?: boolean;
  devices?: { id: string; name: string; online?: boolean }[];
  onClose: () => void;
  onLinked?: (assetId: string, deviceId: string) => void;
  onUnlinked?: (assetId: string) => void;
  onDeleted?: (assetId: string) => void;
  onUpdated?: (assetId: string) => void;
};

export default function AssetDetailModal({
  open,
  asset,
  loading = false,
  devices = [],
  onClose,
  onLinked,
  onUnlinked,
  onDeleted,
  onUpdated
}: AssetDetailModalProps) {
  const { t } = useTranslation('discovery');
  const [selectedDevice, setSelectedDevice] = useState(asset?.linkedDeviceId ?? '');
  const [linking, setLinking] = useState(false);
  const [linkError, setLinkError] = useState<string>();
  const [linkSuccess, setLinkSuccess] = useState<string>();
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string>();
  const [editLabel, setEditLabel] = useState('');
  const [editNotes, setEditNotes] = useState('');
  const [editTags, setEditTags] = useState('');
  const [editType, setEditType] = useState<DiscoveredAssetType>(asset?.type ?? 'unknown');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string>();
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [proxyEnabled, setProxyEnabled] = useState(false);
  const [enablingProxy, setEnablingProxy] = useState(false);
  const [proxyError, setProxyError] = useState<string>();
  const [connectingProxy, setConnectingProxy] = useState(false);
  const [selectedProxyPort, setSelectedProxyPort] = useState<number>(0);
  const [selectedScheme, setSelectedScheme] = useState<'http' | 'https'>('http');
  const [allowSelfSigned, setAllowSelfSigned] = useState(false);
  // The bridge agent = which managed device's agent dials the target. This is
  // independent of the identity link below — the right bridge is an online agent
  // that can reach this device on the LAN, which may differ from the device you
  // link for asset-tracking.
  const [selectedBridgeDeviceId, setSelectedBridgeDeviceId] = useState('');

  useEffect(() => {
    if (asset?.linkedDeviceId) {
      setSelectedDevice(asset.linkedDeviceId);
    } else if (asset) {
      setSelectedDevice('');
    }
    setLinkError(undefined);
    setLinkSuccess(undefined);
    setDeleteError(undefined);
    setEditLabel(asset?.label ?? '');
    setEditNotes(asset?.notes ?? '');
    setEditTags(asset?.tags?.join(', ') ?? '');
    setEditType(asset?.type ?? 'unknown');
    setSaveError(undefined);
    setSaveSuccess(false);
    setProxyEnabled((asset as any)?.proxyEnabled ?? false);
    setProxyError(undefined);
    const initialPort = asset?.openPorts?.[0]?.port ?? 80;
    setSelectedProxyPort(initialPort);
    const initialScheme = initialPort === 443 ? 'https' : 'http';
    setSelectedScheme(initialScheme);
    setAllowSelfSigned(false);
  }, [asset]);

  // Default the proxy bridge agent: prefer the linked device when it's online,
  // otherwise the first online device. Kept separate from the reset effect above
  // so a device-list refresh doesn't clobber in-progress edits.
  useEffect(() => {
    const onlineIds = new Set((devices ?? []).filter(d => d.online).map(d => d.id));
    if (asset?.linkedDeviceId && onlineIds.has(asset.linkedDeviceId)) {
      setSelectedBridgeDeviceId(asset.linkedDeviceId);
      return;
    }
    setSelectedBridgeDeviceId((devices ?? []).find(d => d.online)?.id ?? '');
  }, [asset, devices]);

  const handleLink = async () => {
    if (!asset) return;
    if (!selectedDevice) {
      setLinkSuccess(undefined);
      setLinkError(t('assetDetailModal.errors.selectDeviceToLink'));
      return;
    }

    try {
      setLinking(true);
      setLinkError(undefined);
      setLinkSuccess(undefined);
      const response = await fetchWithAuth(`/discovery/assets/${asset.id}/link`, {
        method: 'POST',
        body: JSON.stringify({ deviceId: selectedDevice })
      });

      if (!response.ok) {
        throw new Error(t('assetDetailModal.errors.link'));
      }

      const deviceName = devices.find(d => d.id === selectedDevice)?.name;
      setLinkSuccess(
        deviceName
          ? t('assetDetailModal.messages.linkedToDevice', { device: deviceName })
          : t('assetDetailModal.messages.linked')
      );
      onLinked?.(asset.id, selectedDevice);
    } catch (err) {
      setLinkError(err instanceof Error ? err.message : t('assetDetailModal.errors.generic'));
    } finally {
      setLinking(false);
    }
  };

  // The Unlink button only renders for manual links (see render guard below) and
  // the server independently rejects non-manual unlinks; this handler guards only
  // that a link exists. Mirrors handleLink's inline success/error messaging, but
  // surfaces the server's actual error text (e.g. a stale modal hitting 403/404).
  const handleUnlink = async () => {
    if (!asset?.linkedDeviceId) return;
    if (typeof window !== 'undefined' && !window.confirm(t('assetDetailModal.confirmUnlink'))) {
      return;
    }

    try {
      setLinking(true);
      setLinkError(undefined);
      setLinkSuccess(undefined);
      const response = await fetchWithAuth(`/discovery/assets/${asset.id}/link`, {
        method: 'DELETE'
      });

      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(extractApiError(body, t('assetDetailModal.errors.unlink')));
      }

      setSelectedDevice('');
      setLinkSuccess(t('assetDetailModal.messages.unlinked'));
      onUnlinked?.(asset.id);
    } catch (err) {
      setLinkError(err instanceof Error ? err.message : t('assetDetailModal.errors.generic'));
    } finally {
      setLinking(false);
    }
  };

  const handleDelete = async () => {
    if (!asset) return;
    const name = asset.hostname || asset.ip;
    if (!confirm(t('assetDetailModal.confirmDelete', { name }))) {
      return;
    }

    try {
      setDeleting(true);
      setDeleteError(undefined);
      const response = await fetchWithAuth(`/discovery/assets/${asset.id}`, {
        method: 'DELETE'
      });

      if (!response.ok) {
        throw new Error(t('assetDetailModal.errors.delete'));
      }

      onDeleted?.(asset.id);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : t('assetDetailModal.errors.generic'));
    } finally {
      setDeleting(false);
    }
  };

  const handleSaveInfo = async () => {
    if (!asset) return;
    try {
      setSaving(true);
      setSaveError(undefined);
      setSaveSuccess(false);
      const tags = editTags
        .split(',')
        .map(t => t.trim())
        .filter(Boolean);
      const response = await fetchWithAuth(`/discovery/assets/${asset.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          label: editLabel || null,
          notes: editNotes || null,
          tags,
          ...(editType !== asset.type ? { assetType: editType } : {})
        })
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(extractApiError(body, t('assetDetailModal.errors.saveInfo')));
      }
      setSaveSuccess(true);
      onUpdated?.(asset.id);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : t('assetDetailModal.errors.generic'));
    } finally {
      setSaving(false);
    }
  };

  const handleResetType = async () => {
    if (!asset) return;
    try {
      setSaving(true);
      setSaveError(undefined);
      setSaveSuccess(false);
      const response = await fetchWithAuth(`/discovery/assets/${asset.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ resetTypeToAuto: true })
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(extractApiError(body, t('assetDetailModal.errors.resetType')));
      }
      setSaveSuccess(true);
      onUpdated?.(asset.id);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : t('assetDetailModal.errors.generic'));
    } finally {
      setSaving(false);
    }
  };

  const handleEnableProxy = useCallback(async () => {
    if (!asset) return;
    try {
      setEnablingProxy(true);
      setProxyError(undefined);
      const ports = (asset.openPorts ?? []).map(p => p.port);
      const portRange = ports.length > 0
        ? (ports.length === 1 ? `${ports[0]}` : `${Math.min(...ports)}-${Math.max(...ports)}`)
        : '80-443';
      const response = await fetchWithAuth('/tunnels/allowlist', {
        method: 'POST',
        body: JSON.stringify({
          direction: 'destination',
          pattern: `${asset.ip}/32:${portRange}`,
          description: `Auto-created for ${asset.label || asset.hostname || asset.ip}`,
          source: 'discovery',
          discoveredAssetId: asset.id,
        }),
      });
      if (!response.ok) {
        const detail = await response.json().catch(() => null);
        throw new Error(detail?.error || t('assetDetailModal.errors.createAllowlist'));
      }
      setProxyEnabled(true);
      onUpdated?.(asset.id);
    } catch (err) {
      setProxyError(err instanceof Error ? err.message : t('assetDetailModal.errors.generic'));
    } finally {
      setEnablingProxy(false);
    }
  }, [asset, onUpdated]);

  const handleConnectProxy = useCallback(async () => {
    if (!asset || !selectedBridgeDeviceId) return;
    try {
      setConnectingProxy(true);
      setProxyError(undefined);
      const port = selectedProxyPort || 80;
      const response = await fetchWithAuth('/tunnels', {
        method: 'POST',
        body: JSON.stringify({
          deviceId: selectedBridgeDeviceId,
          type: 'proxy',
          targetHost: asset.ip,
          targetPort: port,
          scheme: selectedScheme,
          skipTlsVerify: selectedScheme === 'https' ? allowSelfSigned : false,
        }),
      });
      if (!response.ok) {
        const err = await response.json().catch(() => ({ error: t('assetDetailModal.errors.createTunnel') }));
        throw new Error(err.error || t('assetDetailModal.errors.createProxyTunnel'));
      }
      const tunnel = await response.json();

      // Open proxy info in a new tab
      window.open(buildRemoteProxyPageUrl(tunnel.id, `${asset.ip}:${port}`), '_blank');
    } catch (err) {
      setProxyError(err instanceof Error ? err.message : t('assetDetailModal.errors.generic'));
    } finally {
      setConnectingProxy(false);
    }
  }, [asset, selectedProxyPort, selectedScheme, allowSelfSigned, selectedBridgeDeviceId]);

  // No asset record yet: never render nothing while open, or a node click looks
  // like it did nothing. Show a loading state, then a graceful not-found state
  // with a retry path (#1728).
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
                <p className="text-sm text-muted-foreground">
                  {t('assetDetailModal.detailsUnavailableDescription')}
                </p>
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
  // Only online agents can bridge a proxy, so the bridge picker hides offline ones.
  const onlineDevices = devices.filter(d => d.online);

  return (
    <Dialog open={open} onClose={onClose} title={asset.label || asset.hostname || asset.ip} maxWidth="5xl" alignTop className="flex flex-col max-h-[calc(100vh-4rem)]">
        <div className="flex items-start justify-between gap-4 border-b px-6 py-4">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-semibold">{asset.label || asset.hostname || asset.ip}</h2>
              <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${typeConfig[asset.type].color}`}>
                {t(/* i18n-dynamic */ typeConfig[asset.type].labelKey)}
              </span>
              <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${approvalStatusConfig[asset.approvalStatus].color}`}>
                {t(/* i18n-dynamic */ approvalStatusConfig[asset.approvalStatus].labelKey)}
              </span>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              {asset.ip}{asset.mac !== '—' && <> • {asset.mac}</>}
              {asset.manufacturer !== '—' && <> • {asset.manufacturer}</>}
              {asset.lastSeen && <> • {t('assetDetailModal.lastSeen', { time: formatDateTime(asset.lastSeen) })}</>}
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
          {/* Left column — Network & Discovery */}
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
                  <dd className="font-medium truncate">{osFingerprint}</dd>
                </div>
              </dl>
              {openPorts.length > 0 && (
                <div className="mt-3 border-t pt-3">
                  <p className="text-xs font-medium text-muted-foreground">{t('assetDetailModal.openPorts')}</p>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {openPorts.map((p) => (
                      <span
                        key={p.port}
                        className="rounded-full border border-muted bg-background px-2 py-0.5 text-xs"
                      >
                        {p.port}{p.service ? ` (${p.service})` : ''}
                      </span>
                    ))}
                  </div>
                </div>
              )}
              {openPorts.length === 0 && (
                <p className="mt-3 text-xs text-muted-foreground">{t('assetDetailModal.noOpenPorts')}</p>
              )}
            </div>

            <div className="rounded-md border bg-muted/30 p-4">
              <h3 className="text-sm font-semibold">{t('assetDetailModal.snmpDataTitle')}</h3>
              <dl className="mt-3 space-y-2 text-sm">
                {Object.keys(snmpData).length === 0 ? (
                  <div className="text-xs text-muted-foreground">
                    {t('assetDetailModal.noSnmpData')}
                  </div>
                ) : (
                  Object.entries(snmpData).map(([key, value]) => (
                    <div key={key} className="flex items-center justify-between gap-4">
                      <dt className="text-muted-foreground">{snmpFieldLabel(key, t)}</dt>
                      <dd className="font-medium text-right break-all">{value}</dd>
                    </div>
                  ))
                )}
              </dl>
            </div>

            <AssetMonitoringSection assetId={asset.id} ipAddress={asset.ip} open={open} />
          </div>

          {/* Right column — Asset Management */}
          <div className="space-y-4">
            <div className="rounded-md border bg-muted/30 p-4">
              <h3 className="text-sm font-semibold">{t('assetDetailModal.assetInfoTitle')}</h3>
              <div className="mt-3 space-y-3">
                <div>
                  <label className="text-xs font-medium text-muted-foreground">{t('assetDetailModal.fields.displayName')}</label>
                  <input
                    type="text"
                    value={editLabel}
                    onChange={e => setEditLabel(e.target.value)}
                    placeholder={t('assetDetailModal.placeholders.displayName')}
                    maxLength={255}
                    className="mt-1 h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                  />
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground">{t('assetDetailModal.fields.assetType')}</label>
                  <div className="mt-1 flex items-center gap-2">
                    <select
                      data-testid="asset-modal-type-select"
                      className="rounded-md border bg-background px-2 py-1 text-sm"
                      value={editType}
                      onChange={(e) => setEditType(e.target.value as DiscoveredAssetType)}
                    >
                      {(Object.keys(typeConfig) as DiscoveredAssetType[]).map((assetType) => (
                        <option key={assetType} value={assetType}>{t(/* i18n-dynamic */ typeConfig[assetType].labelKey)}</option>
                      ))}
                    </select>
                    {asset.typeSource === 'manual' && (
                      <button
                        type="button"
                        data-testid="asset-modal-type-reset"
                        className="text-xs text-muted-foreground underline hover:text-foreground"
                        onClick={() => void handleResetType()}
                      >
                        {t('assetDetailModal.actions.resetType')}
                      </button>
                    )}
                  </div>
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground">{t('assetDetailModal.fields.notesDescription')}</label>
                  <textarea
                    value={editNotes}
                    onChange={e => setEditNotes(e.target.value)}
                    placeholder={t('assetDetailModal.placeholders.notes')}
                    rows={2}
                    className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring resize-none"
                  />
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground">{t('assetDetailModal.fields.tags')}</label>
                  <input
                    type="text"
                    value={editTags}
                    onChange={e => setEditTags(e.target.value)}
                    placeholder={t('assetDetailModal.placeholders.tags')}
                    className="mt-1 h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                  />
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={handleSaveInfo}
                    disabled={saving}
                    className="h-8 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-70"
                  >
                    {saving ? t('common:states.saving') : t('common:actions.save')}
                  </button>
                  {saveSuccess && (
                    <span className="text-xs text-success">{t('common:states.saved')}</span>
                  )}
                </div>
                {saveError && (
                  <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                    {saveError}
                  </div>
                )}
              </div>
            </div>

            <div className="rounded-md border bg-muted/30 p-4">
              <h3 className="text-sm font-semibold">{t('assetDetailModal.linkManagedDeviceTitle')}</h3>
              <p className="mt-1 text-xs text-muted-foreground">
                {t('assetDetailModal.linkManagedDeviceDescription')}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {t('assetDetailModal.identityOnlyBefore')} <strong>{t('assetDetailModal.notText')}</strong>{' '}
                {t('assetDetailModal.identityOnlyAfter')}
              </p>
              <div className="mt-3 flex items-center gap-3">
                <select
                  data-testid="asset-modal-link-select"
                  value={selectedDevice}
                  onChange={event => setSelectedDevice(event.target.value)}
                  className="h-9 flex-1 rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                >
                  <option value="">{t('assetDetailModal.options.selectManagedDevice')}</option>
                  {devices.map(device => (
                    <option key={device.id} value={device.id}>
                      {device.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={handleLink}
                  disabled={linking}
                  className="h-9 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-70"
                >
                  {linking ? t('assetDetailModal.actions.linking') : t('assetDetailModal.actions.linkAsset')}
                </button>
                {asset.linkedDeviceId && isManualLink(asset.linkSource) && (
                  <button
                    type="button"
                    data-testid="asset-modal-unlink"
                    onClick={handleUnlink}
                    disabled={linking}
                    className="h-9 rounded-md border border-destructive/40 px-4 text-sm font-medium text-destructive hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-70"
                  >
                    {linking ? t('assetDetailModal.actions.working') : t('assetDetailModal.actions.unlink')}
                  </button>
                )}
              </div>
              {linkSuccess && (
                <div className="mt-3 rounded-md border border-success/40 bg-success/10 px-3 py-2 text-xs text-success">
                  {linkSuccess}
                </div>
              )}
              {linkError && (
                <div className="mt-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                  {linkError}
                </div>
              )}
            </div>

            <div className="rounded-md border bg-muted/30 p-4">
              <h3 className="text-sm font-semibold flex items-center gap-2">
                <Globe className="h-4 w-4" />
                {t('assetDetailModal.proxy.title')}
              </h3>
              {!proxyEnabled ? (
                <div className="mt-3">
                  <p className="text-xs text-muted-foreground">
                    {t('assetDetailModal.proxy.description')}
                  </p>
                  <button
                    type="button"
                    onClick={handleEnableProxy}
                    disabled={enablingProxy}
                    className="mt-2 h-8 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-70"
                  >
                    {enablingProxy ? t('assetDetailModal.actions.enabling') : t('assetDetailModal.proxy.enable')}
                  </button>
                </div>
              ) : (
                <div className="mt-3 space-y-3">
                  <div className="flex items-center gap-1.5">
                    <span className="inline-flex items-center rounded-full bg-green-50 px-2 py-0.5 text-xs font-medium text-green-700 dark:bg-green-950 dark:text-green-400">
                      {t('assetDetailModal.proxy.enabled')}
                    </span>
                  </div>
                  {onlineDevices.length > 0 ? (
                    <>
                      <div>
                        <label className="text-xs font-medium text-muted-foreground">
                          {t('assetDetailModal.proxy.throughAgent')}
                        </label>
                        <p className="mt-0.5 chart-legend-xs text-muted-foreground">
                          {t('assetDetailModal.proxy.throughAgentHelp', { ip: asset.ip })}
                        </p>
                        <select
                          value={selectedBridgeDeviceId}
                          onChange={e => setSelectedBridgeDeviceId(e.target.value)}
                          data-testid="proxy-bridge-select"
                          className="mt-1 h-8 w-full rounded-md border bg-background px-2 text-xs focus:outline-hidden focus:ring-2 focus:ring-ring"
                        >
                          {onlineDevices.map(d => (
                            <option key={d.id} value={d.id}>
                              {d.name}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="flex items-center gap-2">
                        <select
                          value={selectedProxyPort}
                          onChange={e => {
                            const port = Number(e.target.value);
                            setSelectedProxyPort(port);
                            const newScheme = port === 443 ? 'https' : 'http';
                            setSelectedScheme(newScheme);
                            if (newScheme !== 'https') setAllowSelfSigned(false);
                          }}
                          className="h-8 rounded-md border bg-background px-2 text-xs focus:outline-hidden focus:ring-2 focus:ring-ring"
                        >
                          {openPorts.length > 0 ? (
                            openPorts.map(p => (
                              <option key={p.port} value={p.port}>
                                {t('assetDetailModal.proxy.port', { port: p.port })}{p.service ? ` (${p.service})` : ''}
                              </option>
                            ))
                          ) : (
                            <>
                              <option value={80}>{t('assetDetailModal.proxy.portWithService', { port: 80, service: 'HTTP' })}</option>
                              <option value={443}>{t('assetDetailModal.proxy.portWithService', { port: 443, service: 'HTTPS' })}</option>
                            </>
                          )}
                        </select>
                        <select
                          value={selectedScheme}
                          onChange={e => {
                            const scheme = e.target.value as 'http' | 'https';
                            setSelectedScheme(scheme);
                            if (scheme !== 'https') setAllowSelfSigned(false);
                          }}
                          data-testid="proxy-scheme-select"
                          className="h-8 rounded-md border bg-background px-2 text-xs focus:outline-hidden focus:ring-2 focus:ring-ring"
                        >
                          <option value="http">HTTP</option>
                          <option value="https">HTTPS</option>
                        </select>
                        <button
                          type="button"
                          onClick={handleConnectProxy}
                          disabled={connectingProxy || !selectedBridgeDeviceId}
                          data-testid="proxy-connect-btn"
                          className="inline-flex h-8 items-center gap-1.5 rounded-md bg-blue-600 px-3 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-70"
                        >
                          <ExternalLink className="h-3 w-3" />
                          {connectingProxy ? t('assetDetailModal.actions.connecting') : t('assetDetailModal.actions.connect')}
                        </button>
                      </div>
                      {selectedScheme === 'https' && (
                        <label className="flex items-center gap-2 chart-legend-xs text-muted-foreground">
                          <input
                            type="checkbox"
                            checked={allowSelfSigned}
                            onChange={e => setAllowSelfSigned(e.target.checked)}
                            data-testid="proxy-allow-self-signed"
                          />
                          {t('assetDetailModal.proxy.allowSelfSigned')}
                        </label>
                      )}
                    </>
                  ) : (
                    <p className="text-xs text-amber-600 dark:text-amber-400">
                      {t('assetDetailModal.proxy.noOnlineAgent', { ip: asset.ip })}
                    </p>
                  )}
                </div>
              )}
              {proxyError && (
                <div className="mt-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                  {proxyError}
                </div>
              )}
            </div>

            <div className="flex items-center justify-between rounded-md border bg-muted/30 px-4 py-3">
              <p className="text-xs text-muted-foreground">{t('assetDetailModal.deleteDescription')}</p>
              <button
                type="button"
                onClick={handleDelete}
                disabled={deleting}
                className="h-8 rounded-md border border-destructive/40 px-3 text-xs font-medium text-destructive hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {deleting ? t('assetDetailModal.actions.deleting') : t('assetDetailModal.actions.deleteAsset')}
              </button>
              {deleteError && (
                <div className="mt-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                  {deleteError}
                </div>
              )}
            </div>
          </div>
        </div>
        </div>
    </Dialog>
  );
}
