import { widthPercentClass } from '@/lib/utils';
import { formatNumber } from '@/lib/i18n/format';

export interface DeviceDiskUsage {
  mountPoint: string;
  totalGb: number;
  usedGb: number;
  freeGb: number;
  usedPercent: number;
}

export type DiskUsageScope = 'all' | 'os';
export const DISK_USAGE_SCOPE_KEY = 'breeze.devices.diskUsageScope';

export function readDiskUsageScope(): DiskUsageScope {
  try {
    return window.localStorage.getItem(DISK_USAGE_SCOPE_KEY) === 'os' ? 'os' : 'all';
  } catch {
    return 'all';
  }
}

export function writeDiskUsageScope(scope: DiskUsageScope): void {
  try {
    window.localStorage.setItem(DISK_USAGE_SCOPE_KEY, scope);
  } catch {
    // The selection still applies when browser storage is unavailable.
  }
}

export function displayedDisks(disks: DeviceDiskUsage[] | undefined, scope: DiskUsageScope): DeviceDiskUsage[] {
  return (disks ?? []).filter((disk) => {
    if (!Number.isFinite(disk.usedPercent) || !Number.isFinite(disk.totalGb) || disk.totalGb <= 0) return false;
    // Match the OS mounts used by the hardware inventory. Do not guess an OS
    // volume when it is absent from the inventory.
    const mount = disk.mountPoint.replace(/\\/g, '/').toLowerCase();
    return scope === 'all' || mount === '/' || /^c:\/?$/.test(mount);
  });
}

export function diskUsageSortValue(disks: DeviceDiskUsage[] | undefined, scope: DiskUsageScope): number | null {
  const shown = displayedDisks(disks, scope);
  return shown.length ? Math.max(...shown.map((disk) => disk.usedPercent)) : null;
}

export function DiskUsageBars({ disks }: { disks: DeviceDiskUsage[] }) {
  return <div className="space-y-2">
    {disks.map((disk) => {
      const percent = Math.min(100, Math.max(0, disk.usedPercent));
      const formatGb = (value: number) => formatNumber(value, { maximumFractionDigits: 1 });
      return <div key={disk.mountPoint} className="min-w-40" title={`${disk.mountPoint}: ${formatGb(disk.usedGb)} / ${formatGb(disk.totalGb)} GB`}>
        <div className="mb-1 flex items-center justify-between gap-3 text-xs tabular-nums">
          <span className="max-w-48 truncate">{disk.mountPoint}</span>
          <span>{formatNumber(percent, { maximumFractionDigits: 1 })}%</span>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-muted">
          <div className={`h-full rounded-full ${percent >= 90 ? 'bg-destructive' : percent >= 75 ? 'bg-warning' : 'bg-primary/70'} ${widthPercentClass(percent)}`} />
        </div>
      </div>;
    })}
  </div>;
}
