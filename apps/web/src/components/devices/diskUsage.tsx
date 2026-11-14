import { widthPercentClass } from '@/lib/utils';
import { resolvedFormattingLocale } from '@/lib/i18n/format';
import type { OSType } from './DeviceList';

export interface DeviceDiskUsage {
  id?: string;
  mountPoint: string;
  totalGb: number;
  usedGb: number;
  freeGb: number;
  usedPercent: number;
  isOsVolume?: boolean | null;
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

function isDisplayableDisk(disk: DeviceDiskUsage): boolean {
  return typeof disk?.mountPoint === 'string'
    && disk.mountPoint.length > 0
    && Number.isFinite(disk.totalGb)
    && disk.totalGb > 0
    && Number.isFinite(disk.usedGb)
    && Number.isFinite(disk.usedPercent);
}

export function displayedDisks(
  disks: DeviceDiskUsage[] | undefined,
  scope: DiskUsageScope,
  os: OSType,
): DeviceDiskUsage[] {
  if (!disks) return [];
  if (scope === 'all') return disks.filter(isDisplayableDisk);

  const findVolume = (mountPoint: string) =>
    disks.find((disk) => isDisplayableDisk(disk) && disk.mountPoint === mountPoint);
  const volume = os === 'windows'
    ? disks.find((disk) => isDisplayableDisk(disk) && disk.isOsVolume === true)
    : (os === 'macos' ? findVolume('/System/Volumes/Data') : undefined) ?? findVolume('/');
  return volume ? [volume] : [];
}

export function displayedDiskPercent(disk: DeviceDiskUsage): number {
  const percent = Math.min(100, Math.max(0, disk.usedPercent));
  return Math.round(percent * 10) / 10;
}

export function diskUsageSortValue(
  disks: DeviceDiskUsage[] | undefined,
  scope: DiskUsageScope,
  os: OSType,
): number | null {
  let max: number | null = null;
  for (const disk of displayedDisks(disks, scope, os)) {
    const percent = displayedDiskPercent(disk);
    if (max === null || percent > max) max = percent;
  }
  return max;
}

export function DiskUsageBars({ disks }: { disks: DeviceDiskUsage[] }) {
  const locale = resolvedFormattingLocale();
  const capacity = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
  const percentage = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 });
  return <div className="space-y-2">
    {disks.map((disk) => {
      const percent = displayedDiskPercent(disk);
      return <div key={disk.id ?? disk.mountPoint} className="min-w-40" title={`${disk.mountPoint}: ${capacity.format(disk.usedGb)} / ${capacity.format(disk.totalGb)} GB`}>
        <div className="mb-1 flex items-center justify-between gap-3 text-xs tabular-nums">
          <span className="max-w-48 truncate">{disk.mountPoint}</span>
          <span>{percentage.format(percent / 100)}</span>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-muted">
          <div className={`h-full rounded-full ${percent >= 90 ? 'bg-destructive' : percent >= 75 ? 'bg-warning' : 'bg-primary/70'} ${widthPercentClass(percent)}`} />
        </div>
      </div>;
    })}
  </div>;
}
