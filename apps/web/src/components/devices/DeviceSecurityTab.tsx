import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  RefreshCw,
  ScanSearch,
  ShieldAlert,
  ShieldCheck,
  ShieldOff
} from 'lucide-react';

import { ENABLE_ENDPOINT_AV_FEATURES } from '../../lib/featureFlags';
import { friendlyFetchError } from '../../lib/utils';
import { fetchWithAuth } from '../../stores/auth';
import DeviceSecurityStatus from '../security/DeviceSecurityStatus';

type ThreatSeverity = 'low' | 'medium' | 'high' | 'critical';
type ThreatStatus = 'active' | 'quarantined' | 'removed';
type ScanStatus = 'queued' | 'running' | 'completed' | 'failed';

type ThreatRecord = {
  id: string;
  name: string;
  severity: ThreatSeverity;
  status: ThreatStatus;
  detectedAt: string;
  filePath: string;
};

type ScanRecord = {
  id: string;
  scanType: 'quick' | 'full' | 'custom';
  status: ScanStatus;
  startedAt: string | null;
  finishedAt: string | null;
  threatsFound: number;
};

type DeviceSecurityTabProps = {
  deviceId: string;
  timezone?: string;
};

const severityBadge: Record<ThreatSeverity, string> = {
  low: 'bg-blue-500/20 text-blue-700 border-blue-500/30',
  medium: 'bg-yellow-500/20 text-yellow-800 border-yellow-500/40',
  high: 'bg-orange-500/20 text-orange-700 border-orange-500/40',
  critical: 'bg-red-500/20 text-red-700 border-red-500/40'
};

const statusBadge: Record<ThreatStatus, string> = {
  active: 'bg-red-500/15 text-red-700 border-red-500/30',
  quarantined: 'bg-amber-500/20 text-amber-800 border-amber-500/40',
  removed: 'bg-emerald-500/20 text-emerald-700 border-emerald-500/40'
};

const scanStatusBadge: Record<ScanStatus, string> = {
  queued: 'bg-blue-500/15 text-blue-700 border-blue-500/30',
  running: 'bg-amber-500/20 text-amber-800 border-amber-500/40',
  completed: 'bg-emerald-500/20 text-emerald-700 border-emerald-500/40',
  failed: 'bg-red-500/15 text-red-700 border-red-500/30'
};

function formatDateTime(value: string | null, timezone?: string): string {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleString([], timezone ? { timeZone: timezone } : undefined);
}

function compactPath(value: string): string {
  if (!value) return '-';
  if (value.length <= 48) return value;
  return `...${value.slice(-45)}`;
}

export default function DeviceSecurityTab({ deviceId, timezone }: DeviceSecurityTabProps) {
  const [threats, setThreats] = useState<ThreatRecord[]>([]);
  const [scans, setScans] = useState<ScanRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [runningFullScan, setRunningFullScan] = useState(false);
  const [actingThreatId, setActingThreatId] = useState<string | null>(null);

  const fetchSecurityData = useCallback(async () => {
    if (!ENABLE_ENDPOINT_AV_FEATURES) {
      setThreats([]);
      setScans([]);
      setLoading(false);
      setError(undefined);
      return;
    }

    setLoading(true);
    setError(undefined);

    try {
      const [threatRes, scanRes] = await Promise.all([
        fetchWithAuth(`/security/threats/${deviceId}?limit=10`),
        fetchWithAuth(`/security/scans/${deviceId}?limit=10`)
      ]);

      if (!threatRes.ok) {
        throw new Error(`${threatRes.status} ${threatRes.statusText}`);
      }

      if (!scanRes.ok) {
        throw new Error(`${scanRes.status} ${scanRes.statusText}`);
      }

      const threatPayload = await threatRes.json();
      const scanPayload = await scanRes.json();

      setThreats(Array.isArray(threatPayload.data) ? threatPayload.data : []);
      setScans(Array.isArray(scanPayload.data) ? scanPayload.data : []);
    } catch (err) {
      setError(friendlyFetchError(err));
    } finally {
      setLoading(false);
    }
  }, [deviceId]);

  useEffect(() => {
    fetchSecurityData();
  }, [fetchSecurityData]);

  const runFullScan = async () => {
    if (!ENABLE_ENDPOINT_AV_FEATURES) return;

    setRunningFullScan(true);
    setError(undefined);

    try {
      const response = await fetchWithAuth(`/security/scan/${deviceId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scanType: 'full' })
      });

      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}`);
      }

      await fetchSecurityData();
    } catch (err) {
      setError(friendlyFetchError(err));
    } finally {
      setRunningFullScan(false);
    }
  };

  const runThreatAction = async (threatId: string, action: 'quarantine' | 'remove' | 'restore') => {
    if (!ENABLE_ENDPOINT_AV_FEATURES) return;

    setActingThreatId(threatId);
    setError(undefined);

    try {
      const response = await fetchWithAuth(`/security/threats/${threatId}/${action}`, { method: 'POST' });
      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}`);
      }
      await fetchSecurityData();
    } catch (err) {
      setError(friendlyFetchError(err));
    } finally {
      setActingThreatId(null);
    }
  };

  if (!ENABLE_ENDPOINT_AV_FEATURES) {
    return (
      <div className="space-y-6">
        <DeviceSecurityStatus deviceId={deviceId} showAvActions={false} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <DeviceSecurityStatus deviceId={deviceId} showAvActions />

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="rounded-lg border bg-card p-6 shadow-sm">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h3 className="text-lg font-semibold">Security Operations</h3>
            <p className="text-sm text-muted-foreground">Run scans and review the latest detection activity for this device.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={fetchSecurityData}
              disabled={loading}
              className="inline-flex items-center gap-2 rounded-md border bg-background px-3 py-2 text-sm font-medium hover:bg-muted disabled:opacity-60"
            >
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              Refresh
            </button>
            <button
              type="button"
              onClick={runFullScan}
              disabled={runningFullScan}
              className="inline-flex items-center gap-2 rounded-md border bg-background px-3 py-2 text-sm font-medium hover:bg-muted disabled:opacity-60"
            >
              {runningFullScan ? <Loader2 className="h-4 w-4 animate-spin" /> : <ScanSearch className="h-4 w-4" />}
              Run full scan
            </button>
          </div>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="rounded-lg border bg-card p-6 shadow-sm">
          <div className="mb-4 flex items-center gap-2">
            <ShieldAlert className="h-4 w-4 text-red-500" />
            <h3 className="font-semibold">Recent Threats</h3>
          </div>

          {loading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading threats...
            </div>
          ) : threats.length === 0 ? (
            <p className="text-sm text-muted-foreground">No recent threats for this device.</p>
          ) : (
            <div className="space-y-3">
              {threats.map((threat) => (
                <div key={threat.id} className="rounded-md border bg-background p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm font-medium">{threat.name}</p>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-semibold ${severityBadge[threat.severity]}`}>
                        {threat.severity}
                      </span>
                      <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-semibold ${statusBadge[threat.status]}`}>
                        {threat.status}
                      </span>
                    </div>
                  </div>

                  <p className="mt-1 text-xs text-muted-foreground" title={threat.filePath}>
                    {compactPath(threat.filePath)}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Detected: {formatDateTime(threat.detectedAt, timezone)}
                  </p>

                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    {threat.status === 'active' && (
                      <>
                        <button
                          type="button"
                          onClick={() => runThreatAction(threat.id, 'quarantine')}
                          disabled={actingThreatId === threat.id}
                          className="inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-xs font-medium hover:bg-muted disabled:opacity-60"
                        >
                          {actingThreatId === threat.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldOff className="h-3.5 w-3.5" />}
                          Quarantine
                        </button>
                        <button
                          type="button"
                          onClick={() => runThreatAction(threat.id, 'remove')}
                          disabled={actingThreatId === threat.id}
                          className="inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-xs font-medium hover:bg-muted disabled:opacity-60"
                        >
                          <AlertTriangle className="h-3.5 w-3.5" />
                          Remove
                        </button>
                      </>
                    )}

                    {threat.status === 'quarantined' && (
                      <button
                        type="button"
                        onClick={() => runThreatAction(threat.id, 'restore')}
                        disabled={actingThreatId === threat.id}
                        className="inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-xs font-medium hover:bg-muted disabled:opacity-60"
                      >
                        {actingThreatId === threat.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />}
                        Restore
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="rounded-lg border bg-card p-6 shadow-sm">
          <div className="mb-4 flex items-center gap-2">
            <ScanSearch className="h-4 w-4 text-primary" />
            <h3 className="font-semibold">Recent Scans</h3>
          </div>

          {loading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading scans...
            </div>
          ) : scans.length === 0 ? (
            <p className="text-sm text-muted-foreground">No scan history for this device yet.</p>
          ) : (
            <div className="space-y-3">
              {scans.map((scan) => (
                <div key={scan.id} className="rounded-md border bg-background p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm font-medium capitalize">{scan.scanType} scan</p>
                    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-semibold ${scanStatusBadge[scan.status]}`}>
                      {scan.status}
                    </span>
                  </div>

                  <div className="mt-2 grid gap-1 text-xs text-muted-foreground sm:grid-cols-2">
                    <p>Started: {formatDateTime(scan.startedAt, timezone)}</p>
                    <p>Finished: {formatDateTime(scan.finishedAt, timezone)}</p>
                    <p className="sm:col-span-2 flex items-center gap-1">
                      <CheckCircle2 className="h-3.5 w-3.5" />
                      Threats found: {scan.threatsFound}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
