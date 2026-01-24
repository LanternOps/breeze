import { useCallback, useEffect, useMemo, useState } from 'react';
import { Cpu, HardDrive, MemoryStick, Network } from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';

type DiskDrive = {
  id?: string;
  name?: string;
  model?: string;
  sizeGb?: number | string;
  sizeGB?: number | string;
  capacityGb?: number | string;
  usedGb?: number | string;
  usedGB?: number | string;
  used?: number | string;
  percentUsed?: number | string;
  usagePercent?: number | string;
  health?: string;
  status?: string;
};

type NetworkAdapter = {
  id?: string;
  name?: string;
  interfaceName?: string;
  ipAddress?: string;
  ip?: string;
  macAddress?: string;
  mac?: string;
  isPrimary?: boolean;
  speedMbps?: number | string;
  status?: string;
};

type HardwareInventory = {
  cpuModel?: string | null;
  cpuCores?: number | null;
  cpuThreads?: number | null;
  ramTotalMb?: number | null;
  diskTotalGb?: number | null;
};

type HardwareInventoryResponse = HardwareInventory & {
  hardware?: HardwareInventory;
  disks?: DiskDrive[];
  diskDrives?: DiskDrive[];
  drives?: DiskDrive[];
  networkAdapters?: NetworkAdapter[];
  networkInterfaces?: NetworkAdapter[];
  adapters?: NetworkAdapter[];
};

type DeviceHardwareInventoryProps = {
  deviceId: string;
};

function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function formatGb(value: number | null | undefined): string {
  if (value === null || value === undefined) return 'Not reported';
  if (value >= 1024) return `${(value / 1024).toFixed(1)} TB`;
  return `${value.toFixed(1)} GB`;
}

function formatRam(valueMb: number | null | undefined): string {
  if (valueMb === null || valueMb === undefined) return 'Not reported';
  const gb = valueMb / 1024;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${valueMb} MB`;
}

function getHealthBadge(health?: string, status?: string) {
  const normalized = (health || status || '').toLowerCase();
  if (['healthy', 'ok', 'good', 'normal'].includes(normalized)) {
    return { label: health || status || 'Healthy', className: 'bg-green-500/20 text-green-700 border-green-500/40' };
  }
  if (['warning', 'degraded'].includes(normalized)) {
    return { label: health || status || 'Warning', className: 'bg-yellow-500/20 text-yellow-700 border-yellow-500/40' };
  }
  if (['critical', 'failed', 'error'].includes(normalized)) {
    return { label: health || status || 'Critical', className: 'bg-red-500/20 text-red-700 border-red-500/40' };
  }
  return { label: health || status || 'Unknown', className: 'bg-muted/40 text-muted-foreground border-muted' };
}

export default function DeviceHardwareInventory({ deviceId }: DeviceHardwareInventoryProps) {
  const [hardware, setHardware] = useState<HardwareInventory | null>(null);
  const [disks, setDisks] = useState<DiskDrive[]>([]);
  const [adapters, setAdapters] = useState<NetworkAdapter[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  const fetchHardware = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const response = await fetchWithAuth(`/devices/${deviceId}/hardware`);
      if (!response.ok) throw new Error('Failed to fetch hardware inventory');
      const json: HardwareInventoryResponse & { data?: HardwareInventoryResponse } = await response.json();
      const payload = json?.data ?? json;
      const normalizedHardware = payload.hardware ?? payload;
      const diskList = payload.disks ?? payload.diskDrives ?? payload.drives ?? [];
      const adapterList = payload.networkAdapters ?? payload.networkInterfaces ?? payload.adapters ?? [];

      setHardware(normalizedHardware);
      setDisks(Array.isArray(diskList) ? diskList : []);
      setAdapters(Array.isArray(adapterList) ? adapterList : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch hardware inventory');
    } finally {
      setLoading(false);
    }
  }, [deviceId]);

  useEffect(() => {
    fetchHardware();
  }, [fetchHardware]);

  const diskRows = useMemo(() => {
    return disks.map((disk, index) => {
      const sizeGb = toNumber(disk.sizeGb ?? disk.sizeGB ?? disk.capacityGb ?? null);
      const usedGb = toNumber(disk.usedGb ?? disk.usedGB ?? disk.used ?? null);
      const percentValue = toNumber(disk.percentUsed ?? disk.usagePercent ?? null);
      const computedPercent = percentValue ?? (sizeGb && usedGb ? Math.min(100, Math.round((usedGb / sizeGb) * 100)) : null);

      return {
        key: disk.id ?? `${disk.name ?? disk.model ?? 'disk'}-${index}`,
        name: disk.name ?? disk.model ?? `Disk ${index + 1}`,
        sizeLabel: formatGb(sizeGb),
        usedLabel: usedGb !== null ? formatGb(usedGb) : 'Not reported',
        percentLabel: computedPercent !== null ? `${computedPercent}%` : 'Not reported',
        health: getHealthBadge(disk.health, disk.status)
      };
    });
  }, [disks]);

  if (loading) {
    return (
      <div className="flex items-center justify-center rounded-lg border bg-card py-12 shadow-sm">
        <div className="text-center">
          <div className="mx-auto h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          <p className="mt-3 text-sm text-muted-foreground">Loading hardware inventory...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
        <p className="text-sm text-destructive">{error}</p>
        <button
          type="button"
          onClick={fetchHardware}
          className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="rounded-lg border bg-card p-6 shadow-sm">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Cpu className="h-4 w-4" />
            CPU
          </div>
          <p className="mt-3 text-lg font-semibold">{hardware?.cpuModel || 'Not reported'}</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {hardware?.cpuCores ? `${hardware.cpuCores} cores` : 'Cores not reported'}
            {hardware?.cpuThreads ? ` • ${hardware.cpuThreads} threads` : ''}
          </p>
        </div>

        <div className="rounded-lg border bg-card p-6 shadow-sm">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <MemoryStick className="h-4 w-4" />
            Memory
          </div>
          <p className="mt-3 text-lg font-semibold">{formatRam(hardware?.ramTotalMb)}</p>
          <p className="mt-1 text-sm text-muted-foreground">Total installed RAM</p>
        </div>

        <div className="rounded-lg border bg-card p-6 shadow-sm">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <HardDrive className="h-4 w-4" />
            Storage
          </div>
          <p className="mt-3 text-lg font-semibold">{formatGb(hardware?.diskTotalGb)}</p>
          <p className="mt-1 text-sm text-muted-foreground">Total disk capacity</p>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="rounded-lg border bg-card p-6 shadow-sm">
          <h3 className="font-semibold">Disk Drives</h3>
          <div className="mt-4 overflow-hidden rounded-md border">
            <table className="min-w-full divide-y">
              <thead className="bg-muted/40">
                <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  <th className="px-4 py-3">Drive</th>
                  <th className="px-4 py-3">Size</th>
                  <th className="px-4 py-3">Used</th>
                  <th className="px-4 py-3">Health</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {diskRows.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="px-4 py-6 text-center text-sm text-muted-foreground">
                      No disk inventory reported.
                    </td>
                  </tr>
                ) : (
                  diskRows.map(disk => (
                    <tr key={disk.key} className="text-sm">
                      <td className="px-4 py-3 font-medium">{disk.name}</td>
                      <td className="px-4 py-3 text-muted-foreground">{disk.sizeLabel}</td>
                      <td className="px-4 py-3 text-muted-foreground">{disk.usedLabel}</td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium ${disk.health.className}`}>
                          {disk.health.label}
                        </span>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="rounded-lg border bg-card p-6 shadow-sm">
          <h3 className="font-semibold">Network Adapters</h3>
          <div className="mt-4 space-y-3">
            {adapters.length === 0 ? (
              <p className="text-sm text-muted-foreground">No network adapters reported.</p>
            ) : (
              adapters.map((adapter, index) => {
                const name = adapter.name ?? adapter.interfaceName ?? `Adapter ${index + 1}`;
                const ip = adapter.ipAddress ?? adapter.ip ?? 'Not reported';
                const mac = adapter.macAddress ?? adapter.mac ?? 'Not reported';
                const speed = adapter.speedMbps ? `${adapter.speedMbps} Mbps` : 'Speed not reported';
                return (
                  <div key={adapter.id ?? `${name}-${index}`} className="rounded-md border p-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2 text-sm font-medium">
                        <Network className="h-4 w-4 text-muted-foreground" />
                        {name}
                      </div>
                      {adapter.isPrimary && (
                        <span className="rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                          Primary
                        </span>
                      )}
                    </div>
                    <dl className="mt-3 space-y-1 text-xs text-muted-foreground">
                      <div className="flex justify-between">
                        <dt>IP Address</dt>
                        <dd className="font-mono">{ip}</dd>
                      </div>
                      <div className="flex justify-between">
                        <dt>MAC Address</dt>
                        <dd className="font-mono">{mac}</dd>
                      </div>
                      <div className="flex justify-between">
                        <dt>Link Speed</dt>
                        <dd>{speed}</dd>
                      </div>
                    </dl>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
