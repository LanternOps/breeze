import { describe, it, expect } from 'vitest';
import { coverageMatch, DEVICE_COUNTED_LINE_TYPES, isDeviceLine, quantityFor, uncoveredByRole, type CoverageLine, type CoverageMatchReason, type OrgDeviceSnapshot } from './contractCoverage';
import { CONTRACT_LINE_TYPES } from '@breeze/shared';
import type { DeviceSnapshotRow } from './contractQuantities';

const A = 'site-a';
const B = 'site-b';
// One org: 2 workstations at A, 1 at B; 1 server at A; 1 switch at B; 1 unknown at A.
const devices: DeviceSnapshotRow[] = [
  { id: 'ws1', role: 'workstation', siteId: A },
  { id: 'ws2', role: 'workstation', siteId: A },
  { id: 'ws3', role: 'workstation', siteId: B },
  { id: 'srv1', role: 'server', siteId: A },
  { id: 'sw1', role: 'switch', siteId: B },
  { id: 'unk1', role: 'unknown', siteId: A },
];
const G_VIP = 'group-vip';       // ws1, srv1, and a decommissioned device not in the snapshot
const G_SITE_B = 'group-site-b'; // site-bound to B; members ws3 and (off-site) ws1
const snapshot: OrgDeviceSnapshot = {
  devices,
  groups: new Map([
    [G_VIP, { siteId: null, memberIds: new Set(['ws1', 'srv1', 'decommissioned-x']) }],
    [G_SITE_B, { siteId: B, memberIds: new Set(['ws3', 'ws1']) }],
  ]),
};
const line = (p: Partial<CoverageLine> & Pick<CoverageLine, 'lineType'>): CoverageLine =>
  ({ siteId: null, deviceRoles: null, deviceGroupId: null, ...p });

describe('isDeviceLine', () => {
  it('is true only for the three device-counted types', () => {
    for (const lineType of ['per_device', 'per_device_role', 'per_device_group'] as const) expect(isDeviceLine({ lineType })).toBe(true);
    for (const lineType of ['flat', 'per_seat', 'manual'] as const) expect(isDeviceLine({ lineType })).toBe(false);
  });
});

describe('quantityFor', () => {
  it.each<[string, CoverageLine, number]>([
    ['per_device org-wide counts every device', line({ lineType: 'per_device' }), 6],
    ['per_device scoped to a site', line({ lineType: 'per_device', siteId: A }), 4],
    ['per_device_role single role', line({ lineType: 'per_device_role', deviceRoles: ['server'] }), 1],
    ['per_device_role role set', line({ lineType: 'per_device_role', deviceRoles: ['workstation', 'server'] }), 4],
    ['per_device_role scoped to a site', line({ lineType: 'per_device_role', siteId: B, deviceRoles: ['workstation', 'switch'] }), 2],
    ['per_device_role with no matching devices', line({ lineType: 'per_device_role', deviceRoles: ['printer'] }), 0],
    ['per_device_group counts members present in the billable snapshot only', line({ lineType: 'per_device_group', deviceGroupId: G_VIP }), 2],
    ['per_device_group site-bound group ignores an off-site member', line({ lineType: 'per_device_group', deviceGroupId: G_SITE_B }), 1],
  ])('%s', (_name, l, expected) => {
    expect(quantityFor(snapshot, l)).toBe(expected);
  });

  it('throws for a non-device line type', () => {
    expect(() => quantityFor(snapshot, line({ lineType: 'flat' }))).toThrow(/not a device-counted/);
  });

  it('throws when a group line names a group missing from the snapshot, or no group at all', () => {
    expect(() => quantityFor(snapshot, line({ lineType: 'per_device_group', deviceGroupId: 'nope' }))).toThrow(/group nope is not in the snapshot/);
    expect(() => quantityFor(snapshot, line({ lineType: 'per_device_group' }))).toThrow(/without a device group/);
  });

  it('an empty group counts zero', () => {
    const s: OrgDeviceSnapshot = { devices, groups: new Map([['empty', { siteId: null, memberIds: new Set() }]]) };
    expect(quantityFor(s, line({ lineType: 'per_device_group', deviceGroupId: 'empty' }))).toBe(0);
  });

  it.each([['null', null], ['empty', []]] as const)('throws when a per_device_role line has %s device roles', (_n, deviceRoles) => {
    expect(() => quantityFor(snapshot, line({ lineType: 'per_device_role', deviceRoles }))).toThrow(/without device roles/);
  });
});

describe('uncoveredByRole', () => {
  it('reports every device when only non-device lines exist', () => {
    expect(uncoveredByRole(snapshot, [line({ lineType: 'flat' })])).toEqual({
      total: 6, byRole: { workstation: 3, server: 1, switch: 1, unknown: 1 },
    });
  });

  it('reports nothing when an unscoped per_device line exists', () => {
    expect(uncoveredByRole(snapshot, [line({ lineType: 'per_device' })])).toEqual({ total: 0, byRole: {} });
  });

  it('a site-scoped per_device line leaves the other site uncovered', () => {
    expect(uncoveredByRole(snapshot, [line({ lineType: 'per_device', siteId: A })])).toEqual({ total: 2, byRole: { workstation: 1, switch: 1 } });
  });

  it('role lines cover only their roles; unknown is always uncovered', () => {
    const lines = [
      line({ lineType: 'per_device_role', deviceRoles: ['workstation', 'server'] }),
      line({ lineType: 'per_device_role', deviceRoles: ['switch'] }),
    ];
    expect(uncoveredByRole(snapshot, lines)).toEqual({ total: 1, byRole: { unknown: 1 } });
  });

  it('a group line covers its billable members; a device on a group line and a role line is covered once', () => {
    const lines = [
      line({ lineType: 'per_device_group', deviceGroupId: G_VIP }),          // ws1, srv1
      line({ lineType: 'per_device_role', deviceRoles: ['server'] }),         // srv1 again
    ];
    expect(quantityFor(snapshot, lines[0]!) + quantityFor(snapshot, lines[1]!)).toBe(3); // billed on both
    expect(uncoveredByRole(snapshot, lines)).toEqual({ total: 4, byRole: { workstation: 2, switch: 1, unknown: 1 } });
  });

  it('a site-bound group does not cover its off-site member', () => {
    expect(uncoveredByRole(snapshot, [line({ lineType: 'per_device_group', deviceGroupId: G_SITE_B })])).toEqual({
      total: 5, byRole: { workstation: 2, server: 1, switch: 1, unknown: 1 },
    });
  });

  it('an empty group leaves everything uncovered', () => {
    const s: OrgDeviceSnapshot = { devices, groups: new Map([['empty', { siteId: null, memberIds: new Set() }]]) };
    expect(uncoveredByRole(s, [line({ lineType: 'per_device_group', deviceGroupId: 'empty' })]).total).toBe(6);
  });

  it('empty inventory is zero, not an error', () => {
    const s: OrgDeviceSnapshot = { devices: [], groups: new Map() };
    expect(uncoveredByRole(s, [line({ lineType: 'per_device_role', deviceRoles: ['server'] })])).toEqual({ total: 0, byRole: {} });
  });

  it.each([['null', null], ['empty', []]] as const)('throws for %s device roles even when inventory is empty', (_n, deviceRoles) => {
    const s: OrgDeviceSnapshot = { devices: [], groups: new Map() };
    expect(() => uncoveredByRole(s, [line({ lineType: 'per_device_role', deviceRoles })])).toThrow(/without device roles/);
  });
});

// #3205 W06: coverageMatch is the SAME predicate as the private lineMatches,
// with the reason attached. The parity block at the bottom is the anti-drift
// assertion: every quantity W02 computes must equal the number of devices
// coverageMatch calls covered, over W02's own truth-table fixtures.
describe('coverageMatch (#3205 W06)', () => {
  const rowOf = (id: string) => devices.find((d) => d.id === id)!;
  const why = (l: CoverageLine, id: string): CoverageMatchReason | null => coverageMatch(l, rowOf(id), snapshot);

  it('per_device names the selector: org-wide vs one site', () => {
    expect(why(line({ lineType: 'per_device' }), 'ws1')).toBe('org');
    expect(why(line({ lineType: 'per_device', siteId: A }), 'ws1')).toBe('site');
    expect(why(line({ lineType: 'per_device', siteId: B }), 'ws1')).toBeNull();
  });

  it('a site-scoped role line is role, not site (Decision 3)', () => {
    expect(why(line({ lineType: 'per_device_role', deviceRoles: ['server'] }), 'srv1')).toBe('role');
    expect(why(line({ lineType: 'per_device_role', siteId: A, deviceRoles: ['server'] }), 'srv1')).toBe('role');
    expect(why(line({ lineType: 'per_device_role', siteId: B, deviceRoles: ['server'] }), 'srv1')).toBeNull();
    expect(why(line({ lineType: 'per_device_role', deviceRoles: ['printer'] }), 'srv1')).toBeNull();
  });

  it('a group covers its members, and a site-bound group does not reach off-site', () => {
    expect(why(line({ lineType: 'per_device_group', deviceGroupId: G_VIP }), 'ws1')).toBe('group');
    expect(why(line({ lineType: 'per_device_group', deviceGroupId: G_VIP }), 'ws2')).toBeNull();
    expect(why(line({ lineType: 'per_device_group', deviceGroupId: G_SITE_B }), 'ws3')).toBe('group');
    expect(why(line({ lineType: 'per_device_group', deviceGroupId: G_SITE_B }), 'ws1')).toBeNull(); // member, wrong site
  });

  it('an unknown-role device is billable by non-role lines (roadmap correction)', () => {
    expect(why(line({ lineType: 'per_device' }), 'unk1')).toBe('org');
    expect(why(line({ lineType: 'per_device_role', deviceRoles: ['workstation', 'server'] }), 'unk1')).toBeNull();
    const s: OrgDeviceSnapshot = {
      devices,
      groups: new Map([['g-unk', { siteId: null, memberIds: new Set(['unk1']) }]]),
    };
    expect(coverageMatch(line({ lineType: 'per_device_group', deviceGroupId: 'g-unk' }), rowOf('unk1'), s)).toBe('group');
  });

  it('throws on an unresolvable line, exactly like quantityFor', () => {
    expect(() => why(line({ lineType: 'per_device_role', deviceRoles: null }), 'srv1')).toThrow(/without device roles/);
    expect(() => why(line({ lineType: 'per_device_group' }), 'srv1')).toThrow(/without a device group/);
    expect(() => why(line({ lineType: 'per_device_group', deviceGroupId: 'nope' }), 'srv1')).toThrow(/group nope is not in the snapshot/);
  });

  it('returns null for every non-device-counted line type', () => {
    for (const lineType of ['flat', 'per_seat', 'manual'] as const) {
      expect(why(line({ lineType }), 'srv1')).toBeNull();
    }
  });

  it('DEVICE_COUNTED_LINE_TYPES and isDeviceLine agree over every contract line type', () => {
    for (const lineType of CONTRACT_LINE_TYPES) {
      expect(isDeviceLine({ lineType })).toBe((DEVICE_COUNTED_LINE_TYPES as readonly string[]).includes(lineType));
    }
    expect([...DEVICE_COUNTED_LINE_TYPES].sort()).toEqual(['per_device', 'per_device_group', 'per_device_role']);
  });

  it('PARITY: quantityFor counts exactly the devices coverageMatch calls covered', () => {
    const lines: CoverageLine[] = [
      line({ lineType: 'per_device' }),
      line({ lineType: 'per_device', siteId: A }),
      line({ lineType: 'per_device_role', deviceRoles: ['server'] }),
      line({ lineType: 'per_device_role', deviceRoles: ['workstation', 'server'] }),
      line({ lineType: 'per_device_role', siteId: B, deviceRoles: ['workstation', 'switch'] }),
      line({ lineType: 'per_device_group', deviceGroupId: G_VIP }),
      line({ lineType: 'per_device_group', deviceGroupId: G_SITE_B }),
    ];
    for (const l of lines) {
      expect(quantityFor(snapshot, l)).toBe(devices.filter((r) => coverageMatch(l, r, snapshot) !== null).length);
    }
    // …and the uncovered tally is exactly the complement, which is what makes
    // the contract page's warning and the device page's panel one answer.
    expect(uncoveredByRole(snapshot, lines).total)
      .toBe(devices.filter((r) => !lines.some((l) => coverageMatch(l, r, snapshot) !== null)).length);
  });
});
