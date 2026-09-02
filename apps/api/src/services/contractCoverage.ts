/**
 * Pure arithmetic over one org device snapshot (#3205). No DB, no I/O — the
 * service fetches `snapshotContractDevices(orgId)` once and every device-counted
 * line and the coverage warning are computed here from that same snapshot.
 */
import type { DeviceSnapshotRow } from './contractQuantities';

/** The subset of a contract_lines row that coverage math needs. */
export interface CoverageLine {
  lineType: 'flat' | 'per_device' | 'per_device_role' | 'per_seat' | 'manual';
  siteId: string | null;
  deviceRoles: readonly string[] | null;
}

export interface UncoveredDevices {
  total: number;
  /** role -> count of billable devices no line on the contract bills. */
  byRole: Record<string, number>;
}

export function isDeviceLine(line: Pick<CoverageLine, 'lineType'>): boolean {
  return line.lineType === 'per_device' || line.lineType === 'per_device_role';
}

function assertValidDeviceRoleLine(line: CoverageLine): void {
  if (line.lineType === 'per_device_role' && (!line.deviceRoles || line.deviceRoles.length === 0)) {
    throw new Error('contractCoverage: per_device_role line without device roles');
  }
}

function lineMatches(line: CoverageLine, row: DeviceSnapshotRow): boolean {
  if (line.siteId !== null && line.siteId !== row.siteId) return false;
  if (line.lineType === 'per_device') return true;
  if (line.lineType === 'per_device_role') return line.deviceRoles!.includes(row.role);
  return false;
}

/** Quantity for a per_device / per_device_role line. Throws for any other type:
 *  the caller's switch is exhaustive and must not route flat/seat/manual here. */
export function quantityFor(snapshot: readonly DeviceSnapshotRow[], line: CoverageLine): number {
  assertValidDeviceRoleLine(line);
  if (!isDeviceLine(line)) {
    throw new Error(`quantityFor: ${line.lineType} is not a device-counted line type`);
  }
  let n = 0;
  for (const row of snapshot) if (lineMatches(line, row)) n += row.n;
  return n;
}

/** Billable devices that NO device-counted line on the contract bills, by role.
 *  Site scoping is exact: a role line scoped to site A does not cover that role
 *  at site B. 'unknown' rows can only be covered by a per_device line. */
export function uncoveredByRole(
  snapshot: readonly DeviceSnapshotRow[],
  lines: readonly CoverageLine[],
): UncoveredDevices {
  for (const line of lines) assertValidDeviceRoleLine(line);
  const deviceLines = lines.filter(isDeviceLine);
  const byRole: Record<string, number> = {};
  let total = 0;
  for (const row of snapshot) {
    if (deviceLines.some((l) => lineMatches(l, row))) continue;
    byRole[row.role] = (byRole[row.role] ?? 0) + row.n;
    total += row.n;
  }
  return { total, byRole };
}
