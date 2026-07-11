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
 * VM-host groups (#2308) are the ASYMMETRIC sibling of the above: one member
 * is the host server (`linkGroupRole === 'host'`), the rest are its guest VMs
 * (`'guest'`). Host + guests are concurrently online, so none of the multiboot
 * expected-offline treatment applies. Instead, guest rows are reordered to sit
 * directly beneath their host and marked (`vmRole`/`vmGroupId`) so DeviceList
 * can indent them and offer an expand/collapse affordance on the host row.
 * Guests stay FULL rows — selectable, bulk-op visible, every column rendered.
 * A non-null role implies the group kind is 'vm_host' (the list API sends the
 * role scalar precisely so no group-table join/fetch is needed here). When the
 * host is not on this page (pagination split / filtered out), its guests
 * render as normal ungrouped rows — same caveat as multiboot.
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
  /** vm_host (#2308): this row is the host server or a nested guest VM. */
  vmRole?: 'host' | 'guest';
  /** vm_host (#2308): the link group id — collapse state keys on this. */
  vmGroupId?: string;
  /** vm_host (#2308): host rows only — number of guests nested on this page. */
  vmGuestCount?: number;
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
  // vm_host (#2308): guests reordered beneath their host row.
  const guestsByHost = new Map<string, Device[]>();
  const nestedGuestIds = new Set<string>();
  const vmHostIds = new Set<string>();

  for (const [groupId, members] of membersByGroup) {
    // A lone member on this page (sibling filtered out or on another page)
    // renders as a normal ungrouped row.
    if (members.length < 2) continue;

    // vm_host (#2308): any member carrying a role marks the group asymmetric.
    // The multiboot online/offline heuristics below deliberately do NOT apply —
    // host + guests are concurrently online by design.
    if (members.some((m) => m.linkGroupRole === 'host' || m.linkGroupRole === 'guest')) {
      const host = members.find((m) => m.linkGroupRole === 'host');
      // Host off-page/filtered out → guests render as normal ungrouped rows
      // (no anchor to nest under), same caveat as a split multiboot group.
      if (!host) continue;
      const guests = members.filter((m) => m.id !== host.id && m.linkGroupRole === 'guest');
      if (guests.length === 0) continue;
      vmHostIds.add(host.id);
      guestsByHost.set(host.id, guests);
      for (const g of guests) nestedGuestIds.add(g.id);
      continue;
    }

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
    if (nestedGuestIds.has(device.id)) continue; // emitted right after its host below
    const row: DeviceListRow = {
      device,
      inactiveSiblings: stripsByAnchor.get(device.id) ?? [],
      offlineGroup: device.linkGroupId ? offlineGroupIds.has(device.linkGroupId) : false,
    };
    if (vmHostIds.has(device.id) && device.linkGroupId) {
      const guests = guestsByHost.get(device.id) ?? [];
      row.vmRole = 'host';
      row.vmGroupId = device.linkGroupId;
      row.vmGuestCount = guests.length;
      out.push(row);
      // Guests nest directly beneath their host, in page order.
      for (const guest of guests) {
        out.push({
          device: guest,
          inactiveSiblings: [],
          offlineGroup: false,
          vmRole: 'guest',
          vmGroupId: device.linkGroupId,
        });
      }
      continue;
    }
    out.push(row);
  }
  return out;
}
