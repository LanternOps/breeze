import { describe, it, expect } from 'vitest';
import { isDeviceLine, quantityFor, uncoveredByRole, type CoverageLine } from './contractCoverage';
import type { DeviceSnapshotRow } from './contractQuantities';

const A = 'site-a';
const B = 'site-b';
// One org: 2 workstations at A, 1 at B; 1 server at A; 1 switch at B; 1 unknown at A.
const snapshot: DeviceSnapshotRow[] = [
  { role: 'workstation', siteId: A, n: 2 },
  { role: 'workstation', siteId: B, n: 1 },
  { role: 'server', siteId: A, n: 1 },
  { role: 'switch', siteId: B, n: 1 },
  { role: 'unknown', siteId: A, n: 1 },
];
const line = (p: Partial<CoverageLine> & Pick<CoverageLine, 'lineType'>): CoverageLine =>
  ({ siteId: null, deviceRoles: null, ...p });

describe('isDeviceLine', () => {
  it('is true only for the two device-counted types', () => {
    expect(isDeviceLine({ lineType: 'per_device' })).toBe(true);
    expect(isDeviceLine({ lineType: 'per_device_role' })).toBe(true);
    for (const lineType of ['flat', 'per_seat', 'manual'] as const) expect(isDeviceLine({ lineType })).toBe(false);
  });
});

describe('quantityFor', () => {
  it.each<[string, CoverageLine, number]>([
    ['per_device org-wide counts every row', line({ lineType: 'per_device' }), 6],
    ['per_device scoped to a site', line({ lineType: 'per_device', siteId: A }), 4],
    ['per_device_role single role', line({ lineType: 'per_device_role', deviceRoles: ['server'] }), 1],
    ['per_device_role role set', line({ lineType: 'per_device_role', deviceRoles: ['workstation', 'server'] }), 4],
    ['per_device_role scoped to a site', line({ lineType: 'per_device_role', siteId: B, deviceRoles: ['workstation', 'switch'] }), 2],
    ['per_device_role with no matching devices', line({ lineType: 'per_device_role', deviceRoles: ['printer'] }), 0],
  ])('%s', (_name, l, expected) => {
    expect(quantityFor(snapshot, l)).toBe(expected);
  });

  it('throws for a non-device line type', () => {
    expect(() => quantityFor(snapshot, line({ lineType: 'flat' }))).toThrow(/not a device-counted/);
  });

  it('resolves each line quantity independently for mixed site and role coverage', () => {
    const perDeviceAtA = line({ lineType: 'per_device', siteId: A });
    const switches = line({ lineType: 'per_device_role', deviceRoles: ['switch'] });
    expect(quantityFor(snapshot, perDeviceAtA)).toBe(4);
    expect(quantityFor(snapshot, switches)).toBe(1);
  });

  it('returns zero for a server role line against unknown-only inventory', () => {
    const unknownOnly: DeviceSnapshotRow[] = [{ role: 'unknown', siteId: null, n: 3 }];
    expect(quantityFor(unknownOnly, line({ lineType: 'per_device_role', deviceRoles: ['server'] }))).toBe(0);
  });

  it.each([
    ['null', null],
    ['empty', []],
  ] as const)('throws when a per_device_role line has %s device roles', (_name, deviceRoles) => {
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
    expect(uncoveredByRole(snapshot, [line({ lineType: 'per_device', siteId: A })])).toEqual({
      total: 2, byRole: { workstation: 1, switch: 1 },
    });
  });

  it('role lines cover only their roles; unknown is always uncovered', () => {
    const lines = [
      line({ lineType: 'per_device_role', deviceRoles: ['workstation', 'server'] }),
      line({ lineType: 'per_device_role', deviceRoles: ['switch'] }),
    ];
    expect(uncoveredByRole(snapshot, lines)).toEqual({ total: 1, byRole: { unknown: 1 } });
  });

  it('a site-scoped role line does not cover the same role at another site', () => {
    const lines = [line({ lineType: 'per_device_role', siteId: A, deviceRoles: ['workstation'] })];
    expect(uncoveredByRole(snapshot, lines)).toEqual({
      total: 4, byRole: { workstation: 1, server: 1, switch: 1, unknown: 1 },
    });
  });

  it('overlapping role lines report a device as covered once', () => {
    const lines = [
      line({ lineType: 'per_device_role', deviceRoles: ['server'] }),
      line({ lineType: 'per_device_role', deviceRoles: ['server', 'workstation', 'switch'] }),
    ];
    expect(uncoveredByRole(snapshot, lines)).toEqual({ total: 1, byRole: { unknown: 1 } });
  });

  it('combines a site-scoped device line with an unscoped role line', () => {
    const lines = [
      line({ lineType: 'per_device', siteId: A }),
      line({ lineType: 'per_device_role', deviceRoles: ['switch'] }),
    ];
    expect(uncoveredByRole(snapshot, lines)).toEqual({ total: 1, byRole: { workstation: 1 } });
  });

  it('reports all unknown-only inventory as uncovered by a server role line', () => {
    const unknownOnly: DeviceSnapshotRow[] = [{ role: 'unknown', siteId: null, n: 3 }];
    expect(uncoveredByRole(unknownOnly, [line({ lineType: 'per_device_role', deviceRoles: ['server'] })])).toEqual({
      total: 3, byRole: { unknown: 3 },
    });
  });

  it('empty inventory is zero, not an error', () => {
    expect(uncoveredByRole([], [line({ lineType: 'per_device_role', deviceRoles: ['server'] })])).toEqual({ total: 0, byRole: {} });
  });

  it.each([
    ['null', null],
    ['empty', []],
  ] as const)('throws for %s device roles even when inventory is empty', (_name, deviceRoles) => {
    expect(() => uncoveredByRole([], [line({ lineType: 'per_device_role', deviceRoles })])).toThrow(/without device roles/);
  });
});
