import { useEffect, useState, useCallback } from 'react';
import { Globe, ExternalLink } from 'lucide-react';
import type { DiscoveredAsset, OpenPortEntry } from './DiscoveredAssetList';
import { typeConfig, approvalStatusConfig } from './DiscoveredAssetList';
import AssetMonitoringSection from './AssetMonitoringSection';
import { Dialog } from '../shared/Dialog';
import { fetchWithAuth } from '../../stores/auth';

export type AssetDetail = DiscoveredAsset & {
  openPorts?: OpenPortEntry[];
  osFingerprint?: string;
  snmpData?: Record<string, string>;
  linkedDeviceId?: string | null;
  label?: string | null;
  notes?: string | null;
  tags?: string[];
};

type AssetDetailModalProps = {
  open: boolean;
  asset?: AssetDetail | null;
  devices?: { id: string; name: string }[];
  onClose: () => void;
  onLinked?: (assetId: string) => void;
  onDeleted?: (assetId: string) => void;
  onUpdated?: (assetId: string) => void;
};

export default function AssetDetailModal({
  open,
  asset,
  devices = [],
  onClose,
  onLinked,
  onDeleted,
  onUpdated
}: AssetDetailModalProps) {
  const [selectedDevice, setSelectedDevice] = useState(asset?.linkedDeviceId ?? '');
  const [linking, setLinking] = useState(false);
  const [linkError, setLinkError] = useState<string>();
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string>();
  const [editLabel, setEditLabel] = useState('');
  const [editNotes, setEditNotes] = useState('');
  const [editTags, setEditTags] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string>();
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [proxyEnabled, setProxyEnabled] = useState(false);
  const [enablingProxy, setEnablingProxy] = useState(false);
  const [proxyError, setProxyError] = useState<string>();
  const [connectingProxy, setConnectingProxy] = useState(false);
  const [selectedProxyPort, setSelectedProxyPort] = useState<number>(0);

  useEffect(() => {
    if (asset?.linkedDeviceId) {
      setSelectedDevice(asset.linkedDeviceId);
    } else if (asset) {
      setSelectedDevice('');
    }
    setLinkError(undefined);
    setDeleteError(undefined);
    setEditLabel(asset?.label ?? '');
    setEditNotes(asset?.notes ?? '');
    setEditTags(asset?.tags?.join(', ') ?? '');
    setSaveError(undefined);
    setSaveSuccess(false);
    setProxyEnabled((asset as any)?.proxyEnabled ?? false);
    setProxyError(undefined);
    setSelectedProxyPort(asset?.openPorts?.[0]?.port ?? 80);
  }, [asset]);

  const handleLink = async () => {
    if (!selectedDevice) {
      setLinkError('Select a device to link.');
      return;
    }

    try {
      setLinking(true);
      setLinkError(undefined);
      const response = await fetchWithAuth(`/discovery/assets/${asset.id}/link`, {
        method: 'POST',
        body: JSON.stringify({ deviceId: selectedDevice })
      });

      if (!response.ok) {
        throw new Error('Failed to link asset');
      }

      onLinked?.(asset.id);
    } catch (err) {
      setLinkError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLinking(false);
    }
  };

  const handleDelete = async () => {
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
          tags
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
        throw new Error('Failed to create allowlist entry');
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
    if (!asset || !asset.linkedDeviceId) return;
    try {
      setConnectingProxy(true);
      setProxyError(undefined);
      const port = selectedProxyPort || 80;
      const response = await fetchWithAuth('/tunnels', {
        method: 'POST',
        body: JSON.stringify({
          deviceId: asset.linkedDeviceId,
          type: 'proxy',
          targetHost: asset.ip,
          targetPort: port,
        }),
      });
      if (!response.ok) {
        const err = await response.json().catch(() => ({ error: 'Failed to create tunnel' }));
        throw new Error(err.error || 'Failed to create proxy tunnel');
      }
      const tunnel = await response.json();
      const ticketRes = await fetchWithAuth(`/tunnels/${tunnel.id}/ws-ticket`, { method: 'POST' });
      if (!ticketRes.ok) throw new Error('Failed to get tunnel ticket');
      const { ticket } = await ticketRes.json();

      const apiUrl = (import.meta as any).env?.PUBLIC_API_URL || window.location.origin;
      const wsProtocol = apiUrl.startsWith('https') ? 'wss' : 'ws';
      const wsHost = apiUrl.replace(/^https?:\/\//, '');
      const wsUrl = `${wsProtocol}://${wsHost}/api/v1/tunnel-ws/${tunnel.id}/ws?ticket=${ticket}`;

      // Open proxy info in a new tab
      const proxyUrl = `/remote/proxy/${tunnel.id}?target=${encodeURIComponent(`${asset.ip}:${port}`)}&ws=${encodeURIComponent(wsUrl)}`;
      window.open(proxyUrl, '_blank');
    } catch (err) {
      setProxyError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setConnectingProxy(false);
    }
  }, [asset, selectedProxyPort]);

  if (!asset) return null;

  const openPorts = asset.openPorts ?? [];
  const osFingerprint = asset.osFingerprint ?? '—';
  const snmpData = asset.snmpData ?? {};

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
              {asset.lastSeen && <> • Last seen {new Date(asset.lastSeen).toLocaleString()}</>}
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
                  <div className="text-xs text-muted-foreground">No SNMP data available.</div>
                ) : (
                  Object.entries(snmpData).map(([key, value]) => (
                    <div key={key} className="flex items-center justify-between">
                      <dt className="text-muted-foreground">{key}</dt>
                      <dd className="font-medium text-right">{value}</dd>
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
              <h3 className="text-sm font-semibold">Link to Device</h3>
              <div className="mt-3 flex items-center gap-3">
                <select
                  value={selectedDevice}
                  onChange={event => setSelectedDevice(event.target.value)}
                  className="h-9 flex-1 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                >
                  <option value="">Select device</option>
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
                  {linking ? 'Linking...' : 'Link'}
                </button>
              </div>
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
                    Enable proxy access to reach this device's web interface through a managed agent.
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
                  {asset.linkedDeviceId ? (
                    <div className="flex items-center gap-2">
                      <select
                        value={selectedProxyPort}
                        onChange={e => setSelectedProxyPort(Number(e.target.value))}
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
                      <button
                        type="button"
                        onClick={handleConnectProxy}
                        disabled={connectingProxy}
                        className="inline-flex h-8 items-center gap-1.5 rounded-md bg-blue-600 px-3 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-70"
                      >
                        <ExternalLink className="h-3 w-3" />
                        {connectingProxy ? 'Connecting...' : 'Connect'}
                      </button>
                    </div>
                  ) : (
                    <p className="text-xs text-amber-600 dark:text-amber-400">
                      Link this asset to a managed device first to use as the proxy agent.
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
