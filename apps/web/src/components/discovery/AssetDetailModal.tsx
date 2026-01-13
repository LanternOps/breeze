import { useEffect, useState } from 'react';
import type { DiscoveredAsset } from './DiscoveredAssetList';

export type AssetDetail = DiscoveredAsset & {
  ip: string;
  mac: string;
  hostname: string;
  manufacturer: string;
  openPorts: number[];
  osFingerprint: string;
  snmpData: Record<string, string>;
  linkedDeviceId?: string;
};

type AssetDetailModalProps = {
  open: boolean;
  asset?: AssetDetail | null;
  devices?: { id: string; name: string }[];
  onClose: () => void;
  onLink?: (assetId: string, deviceId: string | undefined) => void;
};

export default function AssetDetailModal({
  open,
  asset,
  devices = [],
  onClose,
  onLink
}: AssetDetailModalProps) {
  const [selectedDevice, setSelectedDevice] = useState(asset?.linkedDeviceId ?? '');

  useEffect(() => {
    if (asset?.linkedDeviceId) {
      setSelectedDevice(asset.linkedDeviceId);
    } else if (asset) {
      setSelectedDevice('');
    }
  }, [asset]);

  if (!open || !asset) return null;

  const handleLink = () => {
    onLink?.(asset.id, selectedDevice || undefined);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-8">
      <div className="w-full max-w-3xl rounded-lg border bg-card p-6 shadow-sm">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold">Asset Details</h2>
            <p className="mt-1 text-sm text-muted-foreground">{asset.ip} • {asset.hostname || 'Unknown host'}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border px-2 py-1 text-xs font-medium text-muted-foreground hover:text-foreground"
          >
            Close
          </button>
        </div>

        <div className="mt-6 grid gap-6 lg:grid-cols-2">
          <div className="space-y-4">
            <div className="rounded-md border bg-muted/30 p-4">
              <h3 className="text-sm font-semibold">Overview</h3>
              <dl className="mt-3 space-y-2 text-sm">
                <div className="flex items-center justify-between">
                  <dt className="text-muted-foreground">IP Address</dt>
                  <dd className="font-medium">{asset.ip}</dd>
                </div>
                <div className="flex items-center justify-between">
                  <dt className="text-muted-foreground">MAC Address</dt>
                  <dd className="font-medium">{asset.mac}</dd>
                </div>
                <div className="flex items-center justify-between">
                  <dt className="text-muted-foreground">Manufacturer</dt>
                  <dd className="font-medium">{asset.manufacturer}</dd>
                </div>
                <div className="flex items-center justify-between">
                  <dt className="text-muted-foreground">OS Fingerprint</dt>
                  <dd className="font-medium">{asset.osFingerprint}</dd>
                </div>
              </dl>
            </div>

            <div className="rounded-md border bg-muted/30 p-4">
              <h3 className="text-sm font-semibold">Open Ports</h3>
              <div className="mt-3 flex flex-wrap gap-2">
                {asset.openPorts.length === 0 ? (
                  <span className="text-xs text-muted-foreground">No ports detected.</span>
                ) : (
                  asset.openPorts.map(port => (
                    <span
                      key={port}
                      className="rounded-full border border-muted bg-background px-2 py-1 text-xs"
                    >
                      {port}
                    </span>
                  ))
                )}
              </div>
            </div>
          </div>

          <div className="space-y-4">
            <div className="rounded-md border bg-muted/30 p-4">
              <h3 className="text-sm font-semibold">SNMP Data</h3>
              <dl className="mt-3 space-y-2 text-sm">
                {Object.keys(asset.snmpData).length === 0 ? (
                  <div className="text-xs text-muted-foreground">No SNMP data available.</div>
                ) : (
                  Object.entries(asset.snmpData).map(([key, value]) => (
                    <div key={key} className="flex items-center justify-between">
                      <dt className="text-muted-foreground">{key}</dt>
                      <dd className="font-medium text-right">{value}</dd>
                    </div>
                  ))
                )}
              </dl>
            </div>

            <div className="rounded-md border bg-muted/30 p-4">
              <h3 className="text-sm font-semibold">Link to Device</h3>
              <div className="mt-3 flex items-center gap-3">
                <select
                  value={selectedDevice}
                  onChange={event => setSelectedDevice(event.target.value)}
                  className="h-10 flex-1 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
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
                  className="h-10 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90"
                >
                  Link
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
