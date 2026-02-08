import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Activity, CheckCircle2, HardDrive, Loader2, Play, Timer } from 'lucide-react';

import { fetchWithAuth } from '@/stores/auth';
import { friendlyFetchError } from '@/lib/utils';

type DeviceStatus = {
  deviceId: string;
  deviceName: string;
  os: 'windows' | 'macos' | 'linux';
  status: 'protected' | 'at_risk' | 'unprotected' | 'offline';
};

type ScanRecord = {
  id: string;
  deviceId: string;
  deviceName: string;
  scanType: 'quick' | 'full' | 'custom';
  status: 'queued' | 'running' | 'completed' | 'failed';
  startedAt: string | null;
  finishedAt: string | null;
  threatsFound: number;
  durationSeconds: number | null;
};

export default function SecurityScanManager() {
  const [selectionMode, setSelectionMode] = useState<'single' | 'multi'>('multi');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [scanType, setScanType] = useState<'quick' | 'full' | 'custom'>('quick');
  const [customPath, setCustomPath] = useState('');
  const [devices, setDevices] = useState<DeviceStatus[]>([]);
  const [scans, setScans] = useState<ScanRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [runningScan, setRunningScan] = useState(false);
  const [error, setError] = useState<string>();
  const abortRef = useRef<AbortController | null>(null);

  const selectedDevices = useMemo(
    () => devices.filter((device) => selectedIds.has(device.deviceId)),
    [devices, selectedIds]
  );

  const activeScans = useMemo(
    () => scans.filter((scan) => scan.status === 'queued' || scan.status === 'running').slice(0, 10),
    [scans]
  );

  const scanHistory = useMemo(
    () => scans.filter((scan) => scan.status === 'completed' || scan.status === 'failed').slice(0, 25),
    [scans]
  );

  const fetchScansForDevice = useCallback(async (deviceId: string, signal: AbortSignal): Promise<ScanRecord[]> => {
    const response = await fetchWithAuth(`/security/scans/${deviceId}?limit=10`, { signal });
    if (!response.ok) return [];
    const payload = await response.json();
    return Array.isArray(payload.data) ? payload.data : [];
  }, []);

  const fetchData = useCallback(async () => {
    setError(undefined);
    setLoading(true);

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const statusRes = await fetchWithAuth('/security/status?limit=100', { signal: controller.signal });
      if (!statusRes.ok) throw new Error(`${statusRes.status} ${statusRes.statusText}`);

      const statusPayload = await statusRes.json();
      const nextDevices: DeviceStatus[] = Array.isArray(statusPayload.data)
        ? statusPayload.data.map((item: any) => ({
            deviceId: item.deviceId,
            deviceName: item.deviceName,
            os: item.os,
            status: item.status
          }))
        : [];

      setDevices(nextDevices);

      const scanResults = await Promise.allSettled(
        nextDevices.slice(0, 25).map((device) => fetchScansForDevice(device.deviceId, controller.signal))
      );

      const nextScans = scanResults.flatMap((result) =>
        result.status === 'fulfilled' ? result.value : []
      );

      const deduped = new Map<string, ScanRecord>();
      nextScans.forEach((scan) => deduped.set(scan.id, scan));

      setScans(
        Array.from(deduped.values()).sort((a, b) => {
          const aTime = a.startedAt ? new Date(a.startedAt).getTime() : 0;
          const bTime = b.startedAt ? new Date(b.startedAt).getTime() : 0;
          return bTime - aTime;
        })
      );
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setError(friendlyFetchError(err));
    } finally {
      setLoading(false);
    }
  }, [fetchScansForDevice]);

  useEffect(() => {
    fetchData();
    return () => abortRef.current?.abort();
  }, [fetchData]);

  const handleSelectDevice = (id: string) => {
    setSelectedIds((prev) => {
      if (selectionMode === 'single') return new Set([id]);
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleSelectMode = (mode: 'single' | 'multi') => {
    setSelectionMode(mode);
    if (mode === 'single' && selectedIds.size > 1) {
      const first = selectedIds.values().next().value as string | undefined;
      setSelectedIds(first ? new Set([first]) : new Set());
    }
  };

  const startScan = async () => {
    if (selectedDevices.length === 0) return;
    setRunningScan(true);
    setError(undefined);

    try {
      const requests = selectedDevices.map((device) => {
        const body = {
          scanType,
          ...(scanType === 'custom' && customPath.trim() ? { paths: [customPath.trim()] } : {})
        };

        return fetchWithAuth(`/security/scan/${device.deviceId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
      });

      const results = await Promise.all(requests);
      const failed = results.find((result) => !result.ok);
      if (failed) {
        throw new Error(`${failed.status} ${failed.statusText}`);
      }

      await fetchData();
    } catch (err) {
      setError(friendlyFetchError(err));
    } finally {
      setRunningScan(false);
    }
  };

  const formatDuration = (durationSeconds: number | null): string => {
    if (!durationSeconds || durationSeconds <= 0) return '-';
    if (durationSeconds < 60) return `${durationSeconds}s`;
    const minutes = Math.floor(durationSeconds / 60);
    const seconds = durationSeconds % 60;
    return `${minutes}m ${seconds}s`;
  };

  const formatTimestamp = (value: string | null): string => {
    if (!value) return '-';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '-' : date.toLocaleString();
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold">Security Scan Manager</h2>
        <p className="text-sm text-muted-foreground">Start scans, watch progress, and review scan history across devices.</p>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="rounded-lg border bg-card p-6 shadow-sm">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="space-y-1">
            <h3 className="text-base font-semibold">Start a Scan</h3>
            <p className="text-sm text-muted-foreground">
              {selectedDevices.length} device{selectedDevices.length === 1 ? '' : 's'} selected
            </p>
          </div>
          <div className="inline-flex rounded-md border bg-muted/30 p-1 text-sm">
            <button
              type="button"
              onClick={() => handleSelectMode('single')}
              className={`rounded-md px-3 py-1 ${selectionMode === 'single' ? 'bg-background shadow-sm' : 'text-muted-foreground'}`}
            >
              Single select
            </button>
            <button
              type="button"
              onClick={() => handleSelectMode('multi')}
              className={`rounded-md px-3 py-1 ${selectionMode === 'multi' ? 'bg-background shadow-sm' : 'text-muted-foreground'}`}
            >
              Multi select
            </button>
          </div>
        </div>

        <div className="mt-4 grid gap-4 lg:grid-cols-3">
          <div className="rounded-md border bg-muted/20 p-4">
            <p className="text-xs uppercase text-muted-foreground">Devices</p>
            {loading ? (
              <div className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading devices...
              </div>
            ) : (
              <div className="mt-3 space-y-2">
                {devices.map((device) => (
                  <label key={device.deviceId} className="flex cursor-pointer items-center justify-between rounded-md border bg-background px-3 py-2 text-sm">
                    <div>
                      <p className="font-medium">{device.deviceName}</p>
                      <p className="text-xs capitalize text-muted-foreground">
                        {device.os} - {device.status.replace('_', ' ')}
                      </p>
                    </div>
                    <input
                      type="checkbox"
                      checked={selectedIds.has(device.deviceId)}
                      onChange={() => handleSelectDevice(device.deviceId)}
                      className="h-4 w-4 rounded border-gray-300"
                    />
                  </label>
                ))}
              </div>
            )}
          </div>

          <div className="rounded-md border bg-muted/20 p-4 lg:col-span-2">
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className="text-xs uppercase text-muted-foreground">Scan type</label>
                <select
                  value={scanType}
                  onChange={(event) => setScanType(event.target.value as 'quick' | 'full' | 'custom')}
                  className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                >
                  <option value="quick">Quick scan</option>
                  <option value="full">Full scan</option>
                  <option value="custom">Custom scan</option>
                </select>
              </div>
              {scanType === 'custom' && (
                <div>
                  <label className="text-xs uppercase text-muted-foreground">Custom path</label>
                  <input
                    type="text"
                    value={customPath}
                    onChange={(event) => setCustomPath(event.target.value)}
                    placeholder="C:\\Data\\"
                    className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                </div>
              )}
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={startScan}
                disabled={selectedDevices.length === 0 || runningScan}
                className="inline-flex items-center gap-2 rounded-md border bg-background px-4 py-2 text-sm font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
              >
                {runningScan ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                Start scan
              </button>
              <div className="text-sm text-muted-foreground">Scans are queued immediately on selected devices.</div>
            </div>
          </div>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="rounded-lg border bg-card p-6 shadow-sm">
          <div className="flex items-center justify-between">
            <h3 className="text-base font-semibold">Active scans</h3>
            <Activity className="h-5 w-5 text-muted-foreground" />
          </div>
          <div className="mt-4 space-y-4">
            {activeScans.length === 0 ? (
              <p className="text-sm text-muted-foreground">No active scans.</p>
            ) : (
              activeScans.map((scan) => (
                <div key={scan.id} className="rounded-md border bg-muted/30 p-4">
                  <div className="flex items-center justify-between text-sm font-medium">
                    <span>{scan.deviceName}</span>
                    <span className="capitalize">{scan.scanType} scan</span>
                  </div>
                  <div className="mt-2 text-xs text-muted-foreground">
                    Started {formatTimestamp(scan.startedAt)}
                  </div>
                  <div className="mt-2 text-xs text-muted-foreground capitalize">
                    Status: {scan.status}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="rounded-lg border bg-card p-6 shadow-sm">
          <div className="flex items-center justify-between">
            <h3 className="text-base font-semibold">Scan history</h3>
            <HardDrive className="h-5 w-5 text-muted-foreground" />
          </div>
          <div className="mt-4 overflow-hidden rounded-md border">
            <table className="min-w-full divide-y">
              <thead className="bg-muted/40">
                <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  <th className="px-4 py-3">Device</th>
                  <th className="px-4 py-3">Type</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Started</th>
                  <th className="px-4 py-3">Duration</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {scanHistory.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-4 py-6 text-center text-sm text-muted-foreground">No scan history yet.</td>
                  </tr>
                ) : (
                  scanHistory.map((scan) => (
                    <tr key={scan.id} className="text-sm">
                      <td className="px-4 py-3 font-medium">{scan.deviceName}</td>
                      <td className="px-4 py-3 capitalize text-muted-foreground">{scan.scanType}</td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-1 text-xs font-semibold ${scan.status === 'completed' ? 'bg-emerald-500/10 text-emerald-700' : 'bg-red-500/10 text-red-700'}`}>
                          <CheckCircle2 className="h-3 w-3" />
                          {scan.status === 'completed' ? `Clean${scan.threatsFound > 0 ? ` (${scan.threatsFound})` : ''}` : 'Failed'}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">{formatTimestamp(scan.startedAt)}</td>
                      <td className="px-4 py-3 text-muted-foreground">{formatDuration(scan.durationSeconds)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
            <Timer className="h-4 w-4" />
            History shows the latest completed and failed scans.
          </div>
        </div>
      </div>
    </div>
  );
}
