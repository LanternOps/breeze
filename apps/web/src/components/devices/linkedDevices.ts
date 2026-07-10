import type { Device } from './DeviceList';

/**
 * Linked device profiles for multi-boot systems (#2138) — v2 presentation.
 *
 * A physical machine that dual/multi-boots runs one Breeze agent per OS, so the
 * same hardware appears as several device records — only one can be online at a
 * time. Every record is a fully managed endpoint, so NOTHING is collapsed away
 * or hidden (that was v1's mistake, PR #2186). Instead, `groupLinkedDevices`
 * computes a per-page display plan:
 *
 * - Exactly ONE member of a link group online on this page → the online member
 *   renders as a normal full row and each offline sibling attaches beneath it
 *   as a thin muted "expected offline" strip (still clickable through to that
 *   device's detail page, still visible, just de-emphasized).
 * - ALL members offline → all render as normal full rows, each marked with a
 *   subtle left-edge group bar (`offlineGroup`). No primary election.
 * - TWO OR MORE members online → all render as normal full rows (no conflict
 *   state; deliberately designed out).
 *
 * Grouping is computed CLIENT-SIDE within the given page slice. Accepted
 * caveat: siblings split across a pagination boundary render ungrouped on that
 * page (a group needs 2+ members present to group at all).
 */
export interface DeviceListRow {
  device: Device;
  /**
   * Offline siblings rendered as thin muted strips beneath this row — only set
   * on the single online member of a link group. Strips are not selectable.
   */
  inactiveSiblings: Device[];
  /** True when this row belongs to an all-offline link group (left-edge bar). */
  offlineGroup: boolean;
}

function toRow(device: Device): DeviceListRow {
  return { device, inactiveSiblings: [], offlineGroup: false };
}

export function groupLinkedDevices(pageDevices: Device[], enabled: boolean): DeviceListRow[] {
  if (!enabled) return pageDevices.map(toRow);

  // Members of each link group present on THIS page, in page order.
  const membersByGroup = new Map<string, Device[]>();
  for (const d of pageDevices) {
    if (!d.linkGroupId) continue;
    const list = membersByGroup.get(d.linkGroupId) ?? [];
    list.push(d);
    membersByGroup.set(d.linkGroupId, list);
  }

  // Devices that render as strips under their online sibling instead of as
  // their own row.
  const stripDeviceIds = new Set<string>();
  const stripsByAnchor = new Map<string, Device[]>();
  const offlineGroupIds = new Set<string>();

  for (const [groupId, members] of membersByGroup) {
    // A lone member on this page (sibling filtered out or on another page)
    // renders as a normal ungrouped row.
    if (members.length < 2) continue;

    const online = members.filter((m) => m.status === 'online');
    if (online.length === 1) {
      const anchor = online[0]!;
      // Only truly-offline siblings become "expected offline" strips. A
      // sibling in another state (maintenance, quarantined, …) is NOT
      // expected-offline — it stays a normal full row.
      const siblings = members.filter((m) => m.id !== anchor.id && m.status === 'offline');
      if (siblings.length > 0) {
        stripsByAnchor.set(anchor.id, siblings);
        for (const s of siblings) stripDeviceIds.add(s.id);
      }
    } else if (online.length === 0) {
      offlineGroupIds.add(groupId);
    }
    // online.length >= 2 → all full rows, no markers.
  }

  const out: DeviceListRow[] = [];
  for (const device of pageDevices) {
    if (stripDeviceIds.has(device.id)) continue; // renders as a strip, not a row
    out.push({
      device,
      inactiveSiblings: stripsByAnchor.get(device.id) ?? [],
      offlineGroup: device.linkGroupId ? offlineGroupIds.has(device.linkGroupId) : false,
    });
  }
  return out;
}
