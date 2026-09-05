import { describe, it, expect } from 'vitest';
import {
  buildDeviceResolutionSnapshot,
  resolveDeviceRow,
  type DeviceResolutionRecord,
} from './resolveDevice';
import type { DeviceCustomFieldImportRow } from './types';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const FOREIGN_ORG = '99999999-9999-4999-8999-999999999999';

const D1 = 'aaaaaaa1-0000-4000-8000-000000000001';
const D2 = 'aaaaaaa1-0000-4000-8000-000000000002';
const ONLINE_NEWER = 'bbbbbbb1-0000-4000-8000-000000000001';
const OFFLINE_OLDER = 'bbbbbbb1-0000-4000-8000-000000000002';
const DECOMMISSIONED = 'bbbbbbb1-0000-4000-8000-000000000003';
const JUNK_1 = 'ccccccc1-0000-4000-8000-000000000001';
const JUNK_2 = 'ccccccc1-0000-4000-8000-000000000002';
const IN_ORG_B = 'ddddddd1-0000-4000-8000-000000000001';

function device(over: Partial<DeviceResolutionRecord> & { deviceId: string }): DeviceResolutionRecord {
  return {
    orgId: ORG_A,
    hostname: null,
    displayName: null,
    serialNumber: null,
    osType: 'windows',
    status: 'offline',
    enrolledAt: '2024-01-01T00:00:00.000Z',
    lastSeenAt: '2024-06-01T00:00:00.000Z',
    siteId: null,
    ...over,
  };
}

const RECORDS: DeviceResolutionRecord[] = [
  device({ deviceId: D1, hostname: 'wkstn-d1', serialNumber: 'S-D1', status: 'online' }),
  device({ deviceId: D2, hostname: 'wkstn-d2', serialNumber: 'S-D2' }),
  // A three-way hostname collision, deliberately supplied out of ranking order.
  device({
    deviceId: DECOMMISSIONED, hostname: 'shared-name', serialNumber: 'S-DEC',
    status: 'decommissioned', enrolledAt: '2022-01-01T00:00:00.000Z',
  }),
  device({
    deviceId: OFFLINE_OLDER, hostname: 'shared-name', serialNumber: 'S-OFF',
    status: 'offline', enrolledAt: '2023-01-01T00:00:00.000Z',
  }),
  device({
    deviceId: ONLINE_NEWER, hostname: 'shared-name', serialNumber: 'S-ON',
    status: 'online', enrolledAt: '2025-01-01T00:00:00.000Z',
  }),
  // Two machines that both report the SAME BIOS filler string.
  device({ deviceId: JUNK_1, hostname: 'wkstn-junk-1', serialNumber: 'To Be Filled By O.E.M.' }),
  device({ deviceId: JUNK_2, hostname: 'wkstn-junk-2', serialNumber: 'To Be Filled By O.E.M.' }),
  device({ deviceId: IN_ORG_B, orgId: ORG_B, hostname: 'wkstn-in-org-b', serialNumber: 'S-ORGB' }),
];

const snapshot = buildDeviceResolutionSnapshot({
  reachableOrgIds: [ORG_A, ORG_B],
  devices: RECORDS,
  links: [
    { deviceId: D1, system: 'datto_rmm', externalId: 'uid-1', sourceInstance: null },
    { deviceId: D2, system: 'ninjaone', externalId: 'uid-1', sourceInstance: null },
  ],
});

function row(over: Partial<DeviceCustomFieldImportRow>): DeviceCustomFieldImportRow {
  return { values: [], ...over };
}

describe('resolveDeviceRow', () => {
  it('an explicit deviceId wins over every other identifier that agrees with it', () => {
    // DEVIATION from the plan's illustrative test, which passed a deviceId
    // alongside a serial and a hostname belonging to OTHER devices and still
    // expected a match. That contradicts the wave's own identity-conflict rule
    // (and the test's own trailing comment, "…but only when they AGREE"), so
    // precedence is proven with agreeing identifiers and disagreement is proven
    // separately below.
    const r = resolveDeviceRow(
      row({ deviceId: D1, serialNumber: 'S-D1', hostname: 'wkstn-d1' }),
      snapshot,
    );
    expect(r).toMatchObject({ outcome: 'matched', deviceId: D1, method: 'id' });
  });

  it('a link beats a serial', () => {
    const r = resolveDeviceRow(
      row({ externalSystem: 'datto_rmm', externalId: 'uid-1', serialNumber: 'S-D1' }),
      snapshot,
    );
    expect(r).toMatchObject({ outcome: 'link-match', deviceId: D1, method: 'link' });
  });

  it('keys the link on the SYSTEM as well as the id', () => {
    const r = resolveDeviceRow(row({ externalSystem: 'ninjaone', externalId: 'uid-1' }), snapshot);
    expect(r).toMatchObject({ outcome: 'link-match', deviceId: D2, method: 'link' });
  });

  it('falls back to the default system when a row supplies an external id with no system', () => {
    // No 'csv' link exists, so the row resolves to nothing rather than silently
    // matching some other system's row with the same id.
    const r = resolveDeviceRow(row({ externalId: 'uid-1' }), snapshot);
    expect(r.outcome).toBe('not-found');
  });

  it('a serial beats an AMBIGUOUS hostname', () => {
    const r = resolveDeviceRow(row({ serialNumber: 'S-D1', hostname: 'shared-name' }), snapshot);
    expect(r).toMatchObject({ outcome: 'matched', deviceId: D1, method: 'serial' });
  });

  it('matches a serial case-insensitively and ignoring surrounding whitespace', () => {
    const r = resolveDeviceRow(row({ serialNumber: '  s-d1 ' }), snapshot);
    expect(r).toMatchObject({ outcome: 'matched', deviceId: D1, method: 'serial' });
  });

  it('matches a hostname case-insensitively', () => {
    const r = resolveDeviceRow(row({ hostname: ' WKSTN-D2 ' }), snapshot);
    expect(r).toMatchObject({ outcome: 'matched', deviceId: D2, method: 'hostname' });
  });

  it('refuses a row whose serial and hostname resolve to DIFFERENT devices', () => {
    const r = resolveDeviceRow(row({ serialNumber: 'S-D1', hostname: 'wkstn-d2' }), snapshot);
    expect(r.outcome).toBe('identity-conflict');
    expect(r.conflictingMethods).toEqual(['serial', 'hostname']);
    expect(r.deviceId).toBeNull();
    expect(r.method).toBeNull();
    // The disagreeing devices are surfaced so the operator can see WHAT disagreed.
    expect(r.candidates.map((c) => c.deviceId).sort()).toEqual([D1, D2].sort());
  });

  it('refuses a row whose explicit deviceId disagrees with its serial', () => {
    // "First hit wins" would silently pick D1 here and discard the evidence
    // that the row is wrong.
    const r = resolveDeviceRow(row({ deviceId: D1, serialNumber: 'S-D2' }), snapshot);
    expect(r.outcome).toBe('identity-conflict');
    expect(r.conflictingMethods).toEqual(['id', 'serial']);
    expect(r.deviceId).toBeNull();
  });

  it('refuses a row whose link disagrees with its hostname', () => {
    const r = resolveDeviceRow(
      row({ externalSystem: 'datto_rmm', externalId: 'uid-1', hostname: 'wkstn-d2' }),
      snapshot,
    );
    expect(r.outcome).toBe('identity-conflict');
    expect(r.conflictingMethods).toEqual(['link', 'hostname']);
  });

  it('returns ranked candidates for a hostname collision and never auto-picks', () => {
    const r = resolveDeviceRow(row({ hostname: 'shared-name' }), snapshot);
    expect(r.outcome).toBe('ambiguous');
    expect(r.deviceId).toBeNull();
    expect(r.method).toBeNull();
    expect(r.candidates.map((c) => c.deviceId)).toEqual([ONLINE_NEWER, OFFLINE_OLDER, DECOMMISSIONED]);
    expect(r.candidates[0]).toMatchObject({
      method: 'hostname',
      serialNumber: 'S-ON',
      osType: 'windows',
      lastSeenAt: '2024-06-01T00:00:00.000Z',
      enrolledAt: '2025-01-01T00:00:00.000Z',
    });
  });

  it('ranks by enrolment age within a status tier, oldest first', () => {
    const tied = buildDeviceResolutionSnapshot({
      reachableOrgIds: [ORG_A],
      devices: [
        device({ deviceId: D2, hostname: 'tie', status: 'offline', enrolledAt: '2025-01-01T00:00:00.000Z' }),
        device({ deviceId: D1, hostname: 'tie', status: 'offline', enrolledAt: '2020-01-01T00:00:00.000Z' }),
      ],
      links: [],
    });
    const r = resolveDeviceRow(row({ hostname: 'tie' }), tied);
    expect(r.candidates.map((c) => c.deviceId)).toEqual([D1, D2]);
  });

  it('ignores a junk serial on the ROW side', () => {
    const r = resolveDeviceRow(row({ serialNumber: 'Default string', hostname: 'wkstn-d1' }), snapshot);
    expect(r).toMatchObject({ outcome: 'matched', deviceId: D1, method: 'hostname' });
  });

  it('ignores a junk serial on the DATABASE side', () => {
    // Two devices both store "To Be Filled By O.E.M." — they must not group.
    const r = resolveDeviceRow(row({ serialNumber: 'To Be Filled By O.E.M.' }), snapshot);
    expect(r.outcome).toBe('not-found');
    expect(r.candidates).toEqual([]);
  });

  it('never resolves a hostname that is not in the snapshot', () => {
    const r = resolveDeviceRow(row({ hostname: 'wkstn-in-other-org' }), snapshot);
    expect(r.outcome).toBe('not-found');
  });

  it('reports org-not-found for an org outside the caller reach, without disclosing existence', () => {
    const r = resolveDeviceRow(row({ organizationId: FOREIGN_ORG, hostname: 'wkstn-d1' }), snapshot);
    expect(r).toMatchObject({ outcome: 'org-not-found', deviceId: null, method: null });
    expect(r.candidates).toEqual([]);
  });

  it('gives an unknown org the SAME answer as an out-of-reach one (no existence oracle)', () => {
    const unknown = resolveDeviceRow(
      row({ organizationId: '00000000-0000-4000-8000-000000000000', hostname: 'wkstn-d1' }),
      snapshot,
    );
    expect(unknown.outcome).toBe('org-not-found');
  });

  it('confines resolution to the row organization when one is named', () => {
    // wkstn-in-org-b exists and ORG_B is reachable, but the row named ORG_A.
    const r = resolveDeviceRow(row({ organizationId: ORG_A, hostname: 'wkstn-in-org-b' }), snapshot);
    expect(r.outcome).toBe('not-found');
  });

  it('resolves within the named organization when it matches', () => {
    const r = resolveDeviceRow(row({ organizationId: ORG_B, hostname: 'wkstn-in-org-b' }), snapshot);
    expect(r).toMatchObject({ outcome: 'matched', deviceId: IN_ORG_B, method: 'hostname' });
  });

  it('returns not-found for an unknown deviceId rather than trusting the caller', () => {
    const r = resolveDeviceRow(row({ deviceId: '00000000-0000-4000-8000-0000000000ff' }), snapshot);
    expect(r.outcome).toBe('not-found');
  });

  it('returns not-found for a row that supplies no usable identifier at all', () => {
    const r = resolveDeviceRow(row({ hostname: '   ', serialNumber: '  ' }), snapshot);
    expect(r.outcome).toBe('not-found');
  });
});

describe('buildDeviceResolutionSnapshot', () => {
  it('does not index a junk serial, so junk never groups devices', () => {
    const snap = buildDeviceResolutionSnapshot({
      reachableOrgIds: [ORG_A],
      devices: [device({ deviceId: D1, serialNumber: 'unknown' })],
      links: [],
    });
    expect(resolveDeviceRow(row({ serialNumber: 'unknown' }), snap).outcome).toBe('not-found');
  });

  it('indexes a device under only the identifiers it actually has', () => {
    const snap = buildDeviceResolutionSnapshot({
      reachableOrgIds: [ORG_A],
      devices: [device({ deviceId: D1, hostname: null, serialNumber: null })],
      links: [],
    });
    expect(resolveDeviceRow(row({ deviceId: D1 }), snap)).toMatchObject({
      outcome: 'matched', deviceId: D1, method: 'id',
    });
  });

  it('treats a link whose device is not in the snapshot as unresolved', () => {
    // The device queries carry the org and site predicates; a link row that
    // survives them but whose device did not must never become a match.
    const snap = buildDeviceResolutionSnapshot({
      reachableOrgIds: [ORG_A],
      devices: [],
      links: [{ deviceId: D1, system: 'datto_rmm', externalId: 'uid-1', sourceInstance: null }],
    });
    expect(resolveDeviceRow(row({ externalSystem: 'datto_rmm', externalId: 'uid-1' }), snap).outcome)
      .toBe('not-found');
  });
});
