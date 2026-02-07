import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, Loader2, Shield, ShieldAlert, XCircle, Zap } from 'lucide-react';

import { fetchWithAuth } from '@/stores/auth';
import { friendlyFetchError } from '@/lib/utils';

type DeviceSecurity = {
  deviceId: string;
  deviceName: string;
  provider: { name: string; vendor: string } | null;
  providerVersion: string | null;
  definitionsVersion: string | null;
  definitionsUpdatedAt: string | null;
  lastScanAt: string | null;
  lastScanType: string | null;
  realTimeProtection: boolean;
  firewallEnabled: boolean;
  encryptionStatus: 'encrypted' | 'partial' | 'unencrypted';
  gatekeeperEnabled?: boolean | null;
  status: 'protected' | 'at_risk' | 'unprotected' | 'offline';
  threatsDetected: number;
};

type DeviceSecurityStatusProps = {
  deviceId?: string;
  showAvActions?: boolean;
};

export default function DeviceSecurityStatus({ deviceId, showAvActions = false }: DeviceSecurityStatusProps) {
  const [data, setData] = useState<DeviceSecurity | null>(null);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string>();

  const fetchStatus = useCallback(async () => {
    setLoading(true);
    setError(undefined);

    try {
      let resolvedDeviceId = deviceId;

      if (!resolvedDeviceId) {
        const listRes = await fetchWithAuth('/security/status?limit=1');
        if (!listRes.ok) throw new Error(`${listRes.status} ${listRes.statusText}`);
        const listJson = await listRes.json();
        resolvedDeviceId = listJson.data?.[0]?.deviceId;
      }

      if (!resolvedDeviceId) {
        setData(null);
        return;
      }

      const statusRes = await fetchWithAuth(`/security/status/${resolvedDeviceId}`);
      if (!statusRes.ok) throw new Error(`${statusRes.status} ${statusRes.statusText}`);
      const statusJson = await statusRes.json();

      setData(statusJson.data ?? null);
    } catch (err) {
      setError(friendlyFetchError(err));
    } finally {
      setLoading(false);
    }
  }, [deviceId]);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  const runQuickScan = async () => {
    if (!data) return;
    setScanning(true);
    setError(undefined);

    try {
      const response = await fetchWithAuth(`/security/scan/${data.deviceId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scanType: 'quick' })
      });

      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      await fetchStatus();
    } catch (err) {
      setError(friendlyFetchError(err));
    } finally {
      setScanning(false);
    }
  };

  const formatDate = (value: string | null): string => {
    if (!value) return '-';
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? '-' : parsed.toLocaleString();
  };

  if (loading) {
    return (
      <div className="rounded-lg border bg-card p-6 shadow-sm">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading security status...
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="rounded-lg border bg-card p-6 shadow-sm">
        <p className="text-sm text-muted-foreground">No device security data available.</p>
      </div>
    );
  }

  const baseProtectionItems = [
    { id: 'realtime', label: 'Real-time Protection', enabled: data.realTimeProtection, detail: data.realTimeProtection ? 'Running' : 'Disabled' },
    { id: 'firewall', label: 'Firewall', enabled: data.firewallEnabled, detail: data.firewallEnabled ? 'Policy enforced' : 'Disabled' },
    { id: 'encryption', label: 'Disk Encryption', enabled: data.encryptionStatus !== 'unencrypted', detail: data.encryptionStatus }
  ];
  const hasGatekeeper = typeof data.gatekeeperEnabled === 'boolean';
  const protectionItems = hasGatekeeper
    ? [
      ...baseProtectionItems,
      { id: 'gatekeeper', label: 'Guardian (Gatekeeper)', enabled: data.gatekeeperEnabled === true, detail: data.gatekeeperEnabled ? 'Enabled' : 'Disabled' }
    ]
    : baseProtectionItems;

  if (!showAvActions) {
    return (
      <div className="rounded-lg border bg-card p-6 shadow-sm">
        {error && (
          <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            {error}
          </div>
        )}

        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-full border bg-muted/40">
            <Shield className="h-5 w-5 text-emerald-600" />
          </div>
          <div>
            <h2 className="text-lg font-semibold">Device Security Status</h2>
            <p className="text-sm text-muted-foreground">{data.deviceName}</p>
          </div>
        </div>

        <div className={`mt-6 grid gap-4 ${hasGatekeeper ? 'sm:grid-cols-4' : 'sm:grid-cols-3'}`}>
          <div className="rounded-md border bg-muted/30 p-4">
            <p className="text-xs uppercase text-muted-foreground">Detected AV</p>
            <p className="mt-2 text-sm font-medium">{data.provider?.name ?? 'Unknown Provider'}</p>
            <p className="mt-1 text-xs text-muted-foreground">{data.provider?.vendor ?? 'Unknown vendor'}</p>
          </div>
          <div className="rounded-md border bg-muted/30 p-4">
            <p className="text-xs uppercase text-muted-foreground">Firewall</p>
            <p className="mt-2 text-sm font-medium">{data.firewallEnabled ? 'Enabled' : 'Disabled'}</p>
          </div>
          <div className="rounded-md border bg-muted/30 p-4">
            <p className="text-xs uppercase text-muted-foreground">Disk Encryption</p>
            <p className="mt-2 text-sm font-medium capitalize">{data.encryptionStatus}</p>
          </div>
          {hasGatekeeper && (
            <div className="rounded-md border bg-muted/30 p-4">
              <p className="text-xs uppercase text-muted-foreground">Guardian (Gatekeeper)</p>
              <p className="mt-2 text-sm font-medium">{data.gatekeeperEnabled ? 'Enabled' : 'Disabled'}</p>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border bg-card p-6 shadow-sm">
      {error && (
        <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-full border bg-muted/40">
            <Shield className="h-5 w-5 text-emerald-600" />
          </div>
          <div>
            <h2 className="text-lg font-semibold">Device Security Status</h2>
            <p className="text-sm text-muted-foreground">{data.deviceName} - {data.provider?.name ?? 'Unknown Provider'}</p>
          </div>
        </div>
        <span className={`inline-flex items-center rounded-full border px-3 py-1 text-xs font-semibold ${data.threatsDetected > 0 ? 'bg-red-500/10 text-red-700' : 'bg-emerald-500/10 text-emerald-700'}`}>
          {data.threatsDetected} threats
        </span>
      </div>

      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        <div className="rounded-md border bg-muted/30 p-4">
          <p className="text-xs uppercase text-muted-foreground">Agent/Definitions</p>
          <p className="mt-2 text-sm font-medium">{data.providerVersion ?? data.definitionsVersion ?? '-'}</p>
          <p className="mt-1 text-xs text-muted-foreground">Definitions updated {formatDate(data.definitionsUpdatedAt)}</p>
        </div>
        <div className="rounded-md border bg-muted/30 p-4">
          <p className="text-xs uppercase text-muted-foreground">Last Scan</p>
          <p className="mt-2 text-sm font-medium capitalize">{data.lastScanType ?? '-'}</p>
          <p className="mt-1 text-xs text-muted-foreground">{formatDate(data.lastScanAt)}</p>
        </div>
      </div>

      <div className="mt-6 space-y-3">
        {protectionItems.map((item) => (
          <div key={item.id} className="flex items-center justify-between rounded-md border bg-background px-4 py-3">
            <div>
              <p className="text-sm font-medium">{item.label}</p>
              <p className="text-xs capitalize text-muted-foreground">{item.detail}</p>
            </div>
            {item.enabled ? (
              <CheckCircle2 className="h-5 w-5 text-emerald-600" />
            ) : (
              <XCircle className="h-5 w-5 text-red-500" />
            )}
          </div>
        ))}
      </div>

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={runQuickScan}
          disabled={scanning}
          className="inline-flex items-center gap-2 rounded-md border bg-background px-4 py-2 text-sm font-medium hover:bg-muted disabled:opacity-60"
        >
          {scanning ? <Loader2 className="h-4 w-4 animate-spin" /> : <Zap className="h-4 w-4" />}
          Quick scan
        </button>
        <button
          type="button"
          className="inline-flex items-center gap-2 rounded-md border bg-background px-4 py-2 text-sm font-medium hover:bg-muted"
        >
          <ShieldAlert className="h-4 w-4" />
          Review threats
        </button>
      </div>
    </div>
  );
}
