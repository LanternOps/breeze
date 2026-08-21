import type { Device } from '../../services/api';

export type DeviceStatusFilter = 'all' | 'online' | 'offline';

/**
 * Client-side list shaping for the devices browser.
 *
 * The fleet arrives as one page from `/mobile/devices` (50 by default), so
 * filtering and sorting happen here rather than round-tripping. Kept pure so
 * the ordering contract is testable without a renderer.
 */

/** Offline-first: the machines that need attention sort to the top. */
const STATUS_WEIGHT: Record<Device['status'], number> = {
  offline: 0,
  warning: 1,
  online: 2,
};

export function matchesStatus(device: Device, filter: DeviceStatusFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'online') return device.status === 'online';
  // 'offline' deliberately includes 'warning': from a phone the question is
  // "is this machine healthy", and a warning device is not.
  return device.status !== 'online';
}

export function matchesQuery(device: Device, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    device.name.toLowerCase().includes(q)
    || (device.hostname?.toLowerCase().includes(q) ?? false)
    || (device.siteName?.toLowerCase().includes(q) ?? false)
    || (device.os?.toLowerCase().includes(q) ?? false)
  );
}

export interface DeviceListOptions {
  status: DeviceStatusFilter;
  query: string;
  /** When set, restrict to one organization. */
  orgId?: string | null;
}

export function shapeDeviceList(devices: Device[], options: DeviceListOptions): Device[] {
  const filtered = devices.filter(
    (d) =>
      matchesStatus(d, options.status)
      && matchesQuery(d, options.query)
      && (!options.orgId || d.organizationId === options.orgId)
  );

  return [...filtered].sort((a, b) => {
    const weight = STATUS_WEIGHT[a.status] - STATUS_WEIGHT[b.status];
    if (weight !== 0) return weight;
    return a.name.localeCompare(b.name);
  });
}

/** Counts for the filter chips, computed off the unfiltered fleet. */
export function statusCounts(devices: Device[]): {
  all: number;
  online: number;
  offline: number;
} {
  let online = 0;
  for (const d of devices) if (d.status === 'online') online += 1;
  return { all: devices.length, online, offline: devices.length - online };
}
