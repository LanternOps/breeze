/**
 * Pure arithmetic over one org device snapshot (#3205). No DB, no I/O — the
 * service fetches the snapshot once (devices + the members of every group the
 * contract bills) and every device-counted line and the coverage warning are
 * computed here from that same snapshot.
 */
import type { ContractLineType } from '@breeze/shared';
import type { DeviceSnapshotRow } from './contractQuantities';

/** Members of one billed group. `siteId` is the GROUP's site (null = org-wide):
 *  billing counts a member only when its device is at that site. */
export interface GroupMembers {
  siteId: string | null;
  memberIds: ReadonlySet<string>;
}

export interface OrgDeviceSnapshot {
  devices: readonly DeviceSnapshotRow[];
  /** groupId -> members, for every group any line on the contract bills (matched ∪ pinned). */
  groups: ReadonlyMap<string, GroupMembers>;
}

/** The subset of a contract_lines row that coverage math needs. */
export interface CoverageLine {
  lineType: ContractLineType;
  siteId: string | null;
  deviceRoles: readonly string[] | null;
  deviceGroupId: string | null;
}

export interface UncoveredDevices {
  total: number;
  /** role -> count of billable devices no line on the contract bills. */
  byRole: Record<string, number>;
}

export function isDeviceLine(line: Pick<CoverageLine, 'lineType'>): boolean {
  return line.lineType === 'per_device' || line.lineType === 'per_device_role' || line.lineType === 'per_device_group';
}

function assertResolvable(line: CoverageLine, snapshot: OrgDeviceSnapshot): void {
  if (line.lineType === 'per_device_role' && (!line.deviceRoles || line.deviceRoles.length === 0)) {
    throw new Error('contractCoverage: per_device_role line without device roles');
  }
  if (line.lineType === 'per_device_group') {
    if (!line.deviceGroupId) throw new Error('contractCoverage: per_device_group line without a device group');
    if (!snapshot.groups.has(line.deviceGroupId)) throw new Error(`contractCoverage: group ${line.deviceGroupId} is not in the snapshot`);
  }
}

function lineMatches(line: CoverageLine, row: DeviceSnapshotRow, snapshot: OrgDeviceSnapshot): boolean {
  if (line.siteId !== null && line.siteId !== row.siteId) return false;
  switch (line.lineType) {
    case 'per_device': return true;
    case 'per_device_role': return !!line.deviceRoles && line.deviceRoles.includes(row.role);
    case 'per_device_group': {
      const g = snapshot.groups.get(line.deviceGroupId!)!;
      return g.memberIds.has(row.id) && (g.siteId === null || g.siteId === row.siteId);
    }
    default: return false;
  }
}

/** Quantity for a device-counted line. Throws for any other type: the caller's
 *  switch is exhaustive and must not route flat/seat/manual here. */
export function quantityFor(snapshot: OrgDeviceSnapshot, line: CoverageLine): number {
  assertResolvable(line, snapshot);
  if (!isDeviceLine(line)) throw new Error(`quantityFor: ${line.lineType} is not a device-counted line type`);
  let n = 0;
  for (const row of snapshot.devices) if (lineMatches(line, row, snapshot)) n += 1;
  return n;
}

/** Billable devices that NO device-counted line on the contract bills, by role.
 *  Site scoping is exact; a site-bound group covers only members at its site;
 *  'unknown' rows can only be covered by a per_device line or a group. */
export function uncoveredByRole(snapshot: OrgDeviceSnapshot, lines: readonly CoverageLine[]): UncoveredDevices {
  for (const line of lines) assertResolvable(line, snapshot);
  const deviceLines = lines.filter(isDeviceLine);
  const byRole: Record<string, number> = {};
  let total = 0;
  for (const row of snapshot.devices) {
    if (deviceLines.some((l) => lineMatches(l, row, snapshot))) continue;
    byRole[row.role] = (byRole[row.role] ?? 0) + 1;
    total += 1;
  }
  return { total, byRole };
}
