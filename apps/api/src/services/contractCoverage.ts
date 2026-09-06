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

/** The three line types whose quantity is a device count. The SQL filter in
 *  deviceCoverage.ts and the pure predicate below are both defined from this,
 *  so they cannot drift when a later wave adds a type (#3205 W06). */
export const DEVICE_COUNTED_LINE_TYPES = ['per_device', 'per_device_role', 'per_device_group'] as const;
export type DeviceCountedLineType = typeof DEVICE_COUNTED_LINE_TYPES[number];

export function isDeviceLine(line: Pick<CoverageLine, 'lineType'>): boolean {
  return (DEVICE_COUNTED_LINE_TYPES as readonly string[]).includes(line.lineType);
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

/** WHY a line bills a device — the line's device-set SELECTOR, never a set.
 *  A site-scoped role line is 'role': the operator's answer to "why is this
 *  billed?" is "it is a server"; the site narrows that set rather than being a
 *  second reason, and the row carries the line's siteId verbatim anyway. */
export type CoverageMatchReason = 'org' | 'site' | 'role' | 'group';

/** The private core. No assert: quantityFor/uncoveredByRole pre-assert once per
 *  line, so asserting per row would be O(n) waste. */
function matchReason(line: CoverageLine, row: DeviceSnapshotRow, snapshot: OrgDeviceSnapshot): CoverageMatchReason | null {
  if (line.siteId !== null && line.siteId !== row.siteId) return null;
  switch (line.lineType) {
    case 'per_device': return line.siteId === null ? 'org' : 'site';
    case 'per_device_role': return line.deviceRoles?.includes(row.role) ? 'role' : null;
    case 'per_device_group': {
      const g = snapshot.groups.get(line.deviceGroupId!)!;   // assertResolvable proved both
      return g.memberIds.has(row.id) && (g.siteId === null || g.siteId === row.siteId) ? 'group' : null;
    }
    default: return null;
  }
}

/** Boolean view of coverageMatch for the two counting helpers. Routed through
 *  the exported predicate on purpose (one function, two consumers); the per-row
 *  assertResolvable it repeats is a Map lookup, not a query. */
function lineMatches(line: CoverageLine, row: DeviceSnapshotRow, snapshot: OrgDeviceSnapshot): boolean {
  return coverageMatch(line, row, snapshot) !== null;
}

/** The single predicate behind BOTH the contract page's uncovered warning and
 *  the device page's coverage panel (#3205 W06): quantityFor/uncoveredByRole ask
 *  only "does it match?", deviceCoverage.ts also asks "why?". They cannot
 *  disagree, because there is one function. */
export function coverageMatch(
  line: CoverageLine, row: DeviceSnapshotRow, snapshot: OrgDeviceSnapshot,
): CoverageMatchReason | null {
  assertResolvable(line, snapshot);
  return matchReason(line, row, snapshot);
}

/**
 * Every billable device this line bills. The plural transpose of W06's
 * `coverageMatch`, over the SAME `matchReason` core — `contractLinesCoveringDevice`
 * is one device × many lines, this is one line × many devices, and neither
 * re-implements matching.
 *
 * Generation calls this ONCE per device line and uses the one array for both the
 * quantity and the evidence rows, so the invoice can never say "12" beside
 * eleven rows. Snapshot order; call `orderDevicesForEvidence` for the canonical
 * order the evidence writer needs.
 */
export function matchingDevicesForLine(snapshot: OrgDeviceSnapshot, line: CoverageLine): DeviceSnapshotRow[] {
  assertResolvable(line, snapshot);
  if (!isDeviceLine(line)) throw new Error(`matchingDevicesForLine: ${line.lineType} is not a device-counted line type`);
  return snapshot.devices.filter((row) => matchReason(line, row, snapshot) !== null);
}

/** Quantity for a device-counted line. Throws for any other type: the caller's
 *  switch is exhaustive and must not route flat/seat/manual here. */
export function quantityFor(snapshot: OrgDeviceSnapshot, line: CoverageLine): number {
  return matchingDevicesForLine(snapshot, line).length;
}

/**
 * Canonical evidence order: UTF-16 code-unit comparison of hostname, then id.
 *
 * NOT localeCompare (#3205 W07 decision 6): collation is locale- and
 * ICU-version-dependent ('a' vs 'B' flips, and Node's ICU data changes between
 * releases), so it cannot underwrite a reproducibility promise. '<'/'>' on
 * strings is a fixed code-unit comparison with no environment input.
 *
 * The id tiebreak is load-bearing: hostnames are NOT unique in a fleet, and this
 * order decides which devices fall in the allowance and which in the overage
 * tail.
 */
export function compareEvidenceDevices(a: DeviceSnapshotRow, b: DeviceSnapshotRow): number {
  if (a.hostname < b.hostname) return -1;
  if (a.hostname > b.hostname) return 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Non-mutating canonical sort. */
export function orderDevicesForEvidence(rows: readonly DeviceSnapshotRow[]): DeviceSnapshotRow[] {
  return [...rows].sort(compareEvidenceDevices);
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
