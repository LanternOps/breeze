import type { Device } from './DeviceList';

/**
 * Linked device profiles for multi-boot systems (#2138).
 *
 * A physical machine that dual/multi-boots runs one Breeze agent per OS, so the
 * same hardware appears as several device records — only one can be online at a
 * time. `collapseLinkedDevices` folds each linked group into a SINGLE primary
 * row for the device list so the offline boot profiles stop inflating
 * online/offline counts and cluttering the list.
 *
 * Primary-row selection:
 *   - If any profile is online, the primary is an online profile (the most
 *     recently seen one) — the "active OS".
 *   - If all profiles are offline, the primary is the most-recently-seen
 *     profile (so the group still surfaces its last-known identity).
 *
 * The collapsed primary carries its siblings (`linkedSiblings`) plus a
 * `linkConflict` flag set when MORE THAN ONE profile reports online at once —
 * which, for a machine that can only boot one OS at a time, signals the devices
 * were linked incorrectly or the hardware identity changed.
 */
export interface LinkGroupSummary {
  id: string;
  name: string | null;
  deviceIds: string[];
}

function lastSeenMs(d: Device): number {
  const t = d.lastSeen ? new Date(d.lastSeen).getTime() : NaN;
  return Number.isNaN(t) ? 0 : t;
}

/** Most-recently-seen wins; ties keep the first (stable). */
function mostRecent(devices: Device[]): Device {
  return devices.reduce((best, d) => (lastSeenMs(d) > lastSeenMs(best) ? d : best), devices[0]!);
}

export function collapseLinkedDevices(devices: Device[], groups: LinkGroupSummary[]): Device[] {
  if (groups.length === 0) return devices;

  const byId = new Map(devices.map((d) => [d.id, d]));
  const groupOf = new Map<string, LinkGroupSummary>();
  for (const g of groups) {
    for (const id of g.deviceIds) groupOf.set(id, g);
  }

  const processed = new Set<string>();
  const out: Device[] = [];

  for (const device of devices) {
    if (processed.has(device.id)) continue;

    const group = groupOf.get(device.id);
    // Only present members count — a sibling may be filtered out or on another
    // page's fetch. A group with a single present member renders as normal.
    const members = group
      ? group.deviceIds.map((id) => byId.get(id)).filter((d): d is Device => d !== undefined)
      : [];

    if (!group || members.length < 2) {
      out.push(device);
      processed.add(device.id);
      continue;
    }

    for (const m of members) processed.add(m.id);

    const online = members.filter((m) => m.status === 'online');
    const primary = online.length > 0 ? mostRecent(online) : mostRecent(members);
    const siblings = members.filter((m) => m.id !== primary.id);

    out.push({
      ...primary,
      linkGroupId: group.id,
      linkGroupName: group.name,
      linkedSiblings: siblings,
      linkConflict: online.length > 1,
    });
  }

  return out;
}
