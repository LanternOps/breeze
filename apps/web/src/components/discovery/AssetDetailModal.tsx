import { useEffect, useState, useCallback } from 'react';
import { Globe, ExternalLink } from 'lucide-react';
import type { DiscoveredAsset, OpenPortEntry, DiscoveredAssetType } from './DiscoveredAssetList';
import { typeConfig, approvalStatusConfig } from './DiscoveredAssetList';
import AssetMonitoringSection from './AssetMonitoringSection';
import { Dialog } from '../shared/Dialog';
import { fetchWithAuth } from '../../stores/auth';
import { extractApiError } from '../../lib/apiError';
import { formatDateTime } from '@/lib/dateTimeFormat';
import { buildRemoteProxyPageUrl } from '@/lib/remoteTunnelUrls';
import { isManualLink, type DiscoveredAssetLinkSource } from './networkTypes';

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
const SNMP_FIELD_LABELS: Record<string, string> = {
  sysName: 'System Name',
  sysDescr: 'Description',
  sysObjectId: 'Object ID'
};

function snmpFieldLabel(key: string): string {
  return SNMP_FIELD_LABELS[key] ?? key;
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
      setLinkError('Select a device to link.');
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
        throw new Error('Failed to link asset');
      }

      const deviceName = devices.find(d => d.id === selectedDevice)?.name;
      setLinkSuccess(
        deviceName
          ? `Asset linked to ${deviceName}. It is now marked approved.`
          : 'Asset linked. It is now marked approved.'
      );
      onLinked?.(asset.id, selectedDevice);
    } catch (err) {
      setLinkError(err instanceof Error ? err.message : 'An error occurred');
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
    if (typeof window !== 'undefined' && !window.confirm('Unlink this device?')) {
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
        throw new Error(extractApiError(body, 'Failed to unlink asset'));
      }

      setSelectedDevice('');
      setLinkSuccess('Device unlinked.');
      onUnlinked?.(asset.id);
    } catch (err) {
      setLinkError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLinking(false);
    }
  };

  const handleDelete = async () => {
    if (!asset) return;
    const name = asset.hostname || asset.ip;
    if (!confirm(`Delete discovered asset "${name}"?`)) {
      return;
    }

    try {
      setDeleting(true);
      setDeleteError(undefined);
      const response = await fetchWithAuth(`/discovery/assets/${asset.id}`, {
        method: 'DELETE'
      });

      if (!response.ok) {
        throw new Error('Failed to delete asset');
      }

      onDeleted?.(asset.id);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'An error occurred');
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
        throw new Error('Failed to save asset info');
      }
      setSaveSuccess(true);
      onUpdated?.(asset.id);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'An error occurred');
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
      if (!response.ok) throw new Error('Failed to reset type');
      setSaveSuccess(true);
      onUpdated?.(asset.id);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'An error occurred');
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
        throw new Error(detail?.error || 'Failed to create allowlist entry');
      }
      setProxyEnabled(true);
      onUpdated?.(asset.id);
    } catch (err) {
      setProxyError(err instanceof Error ? err.message : 'An error occurred');
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
        const err = await response.json().catch(() => ({ error: 'Failed to create tunnel' }));
        throw new Error(err.error || 'Failed to create proxy tunnel');
      }
      const tunnel = await response.json();

      // Open proxy info in a new tab
      window.open(buildRemoteProxyPageUrl(tunnel.id, `${asset.ip}:${port}`), '_blank');
    } catch (err) {
      setProxyError(err instanceof Error ? err.message : 'An error occurred');
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
      <Dialog open={open} onClose={onClose} title="Device details" maxWidth="md">
        <div className="flex flex-col items-center justify-center gap-3 px-6 py-12 text-center">
          {loading ? (
            <>
              <div className="h-7 w-7 animate-spin rounded-full border-[3px] border-primary border-t-transparent" />
              <p className="text-sm text-muted-foreground">Loading device details…</p>
            </>
          ) : (
            <>
              <Globe className="h-7 w-7 text-muted-foreground/60" aria-hidden />
              <div className="space-y-1">
                <p className="text-sm font-medium text-foreground">Details unavailable</p>
                <p className="text-sm text-muted-foreground">
                  We couldn’t load this device’s record. It may have been removed or you may not
                  have access to it.
                </p>
              </div>
              <button
                type="button"
                onClick={onClose}
                className="mt-1 rounded-md border px-3 py-1.5 text-sm font-medium text-foreground transition hover:bg-muted"
              >
                Close
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
                {typeConfig[asset.type].label}
              </span>
              <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${approvalStatusConfig[asset.approvalStatus].color}`}>
                {approvalStatusConfig[asset.approvalStatus].label}
              </span>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              {asset.ip}{asset.mac !== '—' && <> • {asset.mac}</>}
              {asset.manufacturer !== '—' && <> • {asset.manufacturer}</>}
              {asset.lastSeen && <> • Last seen {formatDateTime(asset.lastSeen)}</>}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border px-2 py-1 text-xs font-medium text-muted-foreground hover:text-foreground"
          >
            Close
          </button>
        </div>

        <div className="overflow-y-auto px-6 py-5">
        <div className="grid gap-5 lg:grid-cols-2">
          {/* Left column — Network & Discovery */}
          <div className="space-y-4">
            <div className="rounded-md border bg-muted/30 p-4">
              <h3 className="text-sm font-semibold">Network Details</h3>
              <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                <div>
                  <dt className="text-xs text-muted-foreground">Ping</dt>
                  <dd className="font-mono font-medium">
                    {asset.responseTimeMs != null
                      ? asset.responseTimeMs < 1
                        ? '<1 ms'
                        : `${asset.responseTimeMs.toFixed(1)} ms`
                      : '—'}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">OS Fingerprint</dt>
                  <dd className="font-medium truncate">{osFingerprint}</dd>
                </div>
              </dl>
              {openPorts.length > 0 && (
                <div className="mt-3 border-t pt-3">
                  <p className="text-xs font-medium text-muted-foreground">Open Ports</p>
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
                <p className="mt-3 text-xs text-muted-foreground">No open ports detected.</p>
              )}
            </div>

            <div className="rounded-md border bg-muted/30 p-4">
              <h3 className="text-sm font-semibold">SNMP Data</h3>
              <dl className="mt-3 space-y-2 text-sm">
                {Object.keys(snmpData).length === 0 ? (
                  <div className="text-xs text-muted-foreground">
                    No SNMP data was collected — the device may not have responded, or
                    SNMP was not probed. Check that the SNMP method is enabled and the
                    community string is set on the discovery profile.
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
            </div>

            <AssetMonitoringSection assetId={asset.id} ipAddress={asset.ip} open={open} />
          </div>

          {/* Right column — Asset Management */}
          <div className="space-y-4">
            <div className="rounded-md border bg-muted/30 p-4">
              <h3 className="text-sm font-semibold">Asset Info</h3>
              <div className="mt-3 space-y-3">
                <div>
                  <label className="text-xs font-medium text-muted-foreground">Display Name</label>
                  <input
                    type="text"
                    value={editLabel}
                    onChange={e => setEditLabel(e.target.value)}
                    placeholder="e.g. Main Switch"
                    maxLength={255}
                    className="mt-1 h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground">Asset Type</label>
                  <div className="mt-1 flex items-center gap-2">
                    <select
                      data-testid="asset-modal-type-select"
                      className="rounded-md border bg-background px-2 py-1 text-sm"
                      value={editType}
                      onChange={(e) => setEditType(e.target.value as DiscoveredAssetType)}
                    >
                      {(Object.keys(typeConfig) as DiscoveredAssetType[]).map((t) => (
                        <option key={t} value={t}>{typeConfig[t].label}</option>
                      ))}
                    </select>
                    {asset.typeSource === 'manual' && (
                      <button
                        type="button"
                        data-testid="asset-modal-type-reset"
                        className="text-xs text-muted-foreground underline hover:text-foreground"
                        onClick={() => void handleResetType()}
                      >
                        Reset to auto-detected
                      </button>
                    )}
                  </div>
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground">Notes / Description</label>
                  <textarea
                    value={editNotes}
                    onChange={e => setEditNotes(e.target.value)}
                    placeholder="e.g. Located in Closet A, 2nd floor"
                    rows={2}
                    className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-none"
                  />
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground">Tags (comma-separated)</label>
                  <input
                    type="text"
                    value={editTags}
                    onChange={e => setEditTags(e.target.value)}
                    placeholder="e.g. critical, floor-2, networking"
                    className="mt-1 h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={handleSaveInfo}
                    disabled={saving}
                    className="h-8 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-70"
                  >
                    {saving ? 'Saving...' : 'Save'}
                  </button>
                  {saveSuccess && (
                    <span className="text-xs text-success">Saved</span>
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
              <h3 className="text-sm font-semibold">Link to managed device</h3>
              <p className="mt-1 text-xs text-muted-foreground">
                Associate this discovered asset with an existing agent-managed device so Breeze
                treats them as the same machine. This does not install an agent or create a new
                device. The asset will be marked as approved.
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Identity / asset-tracking only — this does <strong>not</strong> control proxy access
                or choose the proxy agent (set those under Proxy Access below).
              </p>
              <div className="mt-3 flex items-center gap-3">
                <select
                  data-testid="asset-modal-link-select"
                  value={selectedDevice}
                  onChange={event => setSelectedDevice(event.target.value)}
                  className="h-9 flex-1 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                >
                  <option value="">Select a managed device</option>
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
                  {linking ? 'Linking...' : 'Link asset'}
                </button>
                {asset.linkedDeviceId && isManualLink(asset.linkSource) && (
                  <button
                    type="button"
                    data-testid="asset-modal-unlink"
                    onClick={handleUnlink}
                    disabled={linking}
                    className="h-9 rounded-md border border-destructive/40 px-4 text-sm font-medium text-destructive hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-70"
                  >
                    {linking ? 'Working...' : 'Unlink'}
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
                Proxy Access
              </h3>
              {!proxyEnabled ? (
                <div className="mt-3">
                  <p className="text-xs text-muted-foreground">
                    Reach this device's web interface in your browser, tunnelled through an
                    online agent on its network. Enabling whitelists this device's IP so an
                    agent is permitted to proxy to it.
                  </p>
                  <button
                    type="button"
                    onClick={handleEnableProxy}
                    disabled={enablingProxy}
                    className="mt-2 h-8 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-70"
                  >
                    {enablingProxy ? 'Enabling...' : 'Enable Proxy Access'}
                  </button>
                </div>
              ) : (
                <div className="mt-3 space-y-3">
                  <div className="flex items-center gap-1.5">
                    <span className="inline-flex items-center rounded-full bg-green-50 px-2 py-0.5 text-xs font-medium text-green-700 dark:bg-green-950 dark:text-green-400">
                      Proxy enabled
                    </span>
                  </div>
                  {onlineDevices.length > 0 ? (
                    <>
                      <div>
                        <label className="text-xs font-medium text-muted-foreground">
                          Proxy through agent
                        </label>
                        <p className="mt-0.5 text-[11px] text-muted-foreground">
                          Pick an online agent that can reach {asset.ip} on its network (usually the
                          one that discovered it). This is separate from the identity link above.
                        </p>
                        <select
                          value={selectedBridgeDeviceId}
                          onChange={e => setSelectedBridgeDeviceId(e.target.value)}
                          data-testid="proxy-bridge-select"
                          className="mt-1 h-8 w-full rounded-md border bg-background px-2 text-xs focus:outline-none focus:ring-2 focus:ring-ring"
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
                          className="h-8 rounded-md border bg-background px-2 text-xs focus:outline-none focus:ring-2 focus:ring-ring"
                        >
                          {openPorts.length > 0 ? (
                            openPorts.map(p => (
                              <option key={p.port} value={p.port}>
                                Port {p.port}{p.service ? ` (${p.service})` : ''}
                              </option>
                            ))
                          ) : (
                            <>
                              <option value={80}>Port 80 (HTTP)</option>
                              <option value={443}>Port 443 (HTTPS)</option>
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
                          className="h-8 rounded-md border bg-background px-2 text-xs focus:outline-none focus:ring-2 focus:ring-ring"
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
                          {connectingProxy ? 'Connecting...' : 'Connect'}
                        </button>
                      </div>
                      {selectedScheme === 'https' && (
                        <label className="flex items-center gap-2 text-[11px] text-muted-foreground">
                          <input
                            type="checkbox"
                            checked={allowSelfSigned}
                            onChange={e => setAllowSelfSigned(e.target.checked)}
                            data-testid="proxy-allow-self-signed"
                          />
                          Allow self-signed certificate (common for printers, iLO/IPMI, switches)
                        </label>
                      )}
                    </>
                  ) : (
                    <p className="text-xs text-amber-600 dark:text-amber-400">
                      No online agent available to proxy to this device. An agent must be online and
                      on the same network as {asset.ip} to bridge the connection.
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
              <p className="text-xs text-muted-foreground">Remove this asset from discovery results.</p>
              <button
                type="button"
                onClick={handleDelete}
                disabled={deleting}
                className="h-8 rounded-md border border-destructive/40 px-3 text-xs font-medium text-destructive hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {deleting ? 'Deleting...' : 'Delete Asset'}
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
