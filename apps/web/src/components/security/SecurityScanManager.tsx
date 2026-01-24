import { useState } from 'react';
import { Activity, CheckCircle2, HardDrive, Play, Timer } from 'lucide-react';

type Device = {
  id: string;
  name: string;
  site: string;
  status: string;
};

type ActiveScan = {
  id: string;
  device: string;
  type: string;
  progress: number;
  eta: string;
};

type ScanHistory = {
  id: string;
  device: string;
  type: string;
  status: string;
  startedAt: string;
  duration: string;
};

const devices: Device[] = [
  { id: 'device-1', name: 'FIN-WS-014', site: 'Finance', status: 'Online' },
  { id: 'device-2', name: 'ENG-MBP-201', site: 'Engineering', status: 'Online' },
  { id: 'device-3', name: 'HR-LTP-033', site: 'HR', status: 'Offline' },
  { id: 'device-4', name: 'OPS-WS-041', site: 'Ops', status: 'Online' },
  { id: 'device-5', name: 'HQ-SRV-07', site: 'HQ', status: 'Online' }
];

const activeScans: ActiveScan[] = [
  { id: 'scan-1', device: 'FIN-WS-014', type: 'Full scan', progress: 68, eta: '12 min' },
  { id: 'scan-2', device: 'ENG-MBP-201', type: 'Quick scan', progress: 42, eta: '6 min' },
  { id: 'scan-3', device: 'OPS-WS-041', type: 'Custom scan', progress: 18, eta: '21 min' }
];

const scanHistory: ScanHistory[] = [
  { id: 'history-1', device: 'FIN-WS-020', type: 'Full scan', status: 'Clean', startedAt: '2024-02-25 18:14', duration: '42 min' },
  { id: 'history-2', device: 'ENG-LTP-071', type: 'Quick scan', status: '1 threat', startedAt: '2024-02-25 14:02', duration: '8 min' },
  { id: 'history-3', device: 'HR-LTP-033', type: 'Custom scan', status: 'Clean', startedAt: '2024-02-25 10:44', duration: '21 min' },
  { id: 'history-4', device: 'OPS-WS-041', type: 'Full scan', status: 'Clean', startedAt: '2024-02-24 22:36', duration: '38 min' }
];

export default function SecurityScanManager() {
  const [selectionMode, setSelectionMode] = useState<'single' | 'multi'>('multi');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [scanType, setScanType] = useState('quick');
  const [customPath, setCustomPath] = useState('');

  const selectedDevices = devices.filter(device => selectedIds.has(device.id));

  const handleSelectDevice = (id: string) => {
    setSelectedIds(prev => {
      if (selectionMode === 'single') {
        return new Set([id]);
      }
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
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

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold">Security Scan Manager</h2>
        <p className="text-sm text-muted-foreground">
          Start scans, watch progress, and review scan history across devices.
        </p>
      </div>

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
            <div className="mt-3 space-y-2">
              {devices.map(device => (
                <label key={device.id} className="flex cursor-pointer items-center justify-between rounded-md border bg-background px-3 py-2 text-sm">
                  <div>
                    <p className="font-medium">{device.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {device.site} - {device.status}
                    </p>
                  </div>
                  <input
                    type="checkbox"
                    checked={selectedIds.has(device.id)}
                    onChange={() => handleSelectDevice(device.id)}
                    className="h-4 w-4 rounded border-gray-300"
                  />
                </label>
              ))}
            </div>
          </div>

          <div className="rounded-md border bg-muted/20 p-4 lg:col-span-2">
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className="text-xs uppercase text-muted-foreground">Scan type</label>
                <select
                  value={scanType}
                  onChange={event => setScanType(event.target.value)}
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
                    onChange={event => setCustomPath(event.target.value)}
                    placeholder="C:\\\\Data\\\\"
                    className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                </div>
              )}
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-3">
              <button
                type="button"
                disabled={selectedDevices.length === 0}
                className="inline-flex items-center gap-2 rounded-md border bg-background px-4 py-2 text-sm font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
              >
                <Play className="h-4 w-4" />
                Start scan
              </button>
              <div className="text-sm text-muted-foreground">
                Scans run immediately and notify the device owner.
              </div>
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
            {activeScans.map(scan => (
              <div key={scan.id} className="rounded-md border bg-muted/30 p-4">
                <div className="flex items-center justify-between text-sm font-medium">
                  <span>{scan.device}</span>
                  <span>{scan.type}</span>
                </div>
                <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-muted">
                  <div className="h-full rounded-full bg-emerald-500" style={{ width: `${scan.progress}%` }} />
                </div>
                <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
                  <span>{scan.progress}% complete</span>
                  <span>ETA {scan.eta}</span>
                </div>
              </div>
            ))}
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
                {scanHistory.map(history => (
                  <tr key={history.id} className="text-sm">
                    <td className="px-4 py-3 font-medium">{history.device}</td>
                    <td className="px-4 py-3 text-muted-foreground">{history.type}</td>
                    <td className="px-4 py-3">
                      <span className="inline-flex items-center gap-1 rounded-full border bg-emerald-500/10 px-2 py-1 text-xs font-semibold text-emerald-700">
                        <CheckCircle2 className="h-3 w-3" />
                        {history.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{history.startedAt}</td>
                    <td className="px-4 py-3 text-muted-foreground">{history.duration}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
            <Timer className="h-4 w-4" />
            History stores the last 30 days of completed scans.
          </div>
        </div>
      </div>
    </div>
  );
}
