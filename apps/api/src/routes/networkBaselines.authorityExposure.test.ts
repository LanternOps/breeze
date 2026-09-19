/**
 * SEC-2026-09-05-146 review F4 — the authority envelope is an internal
 * enforcement record, not baseline data. `devices:read` is granted to every
 * device-viewing role, so spreading the whole row would hand every such caller
 * the arming user's permission/MFA epochs and the effect fingerprint. The UI
 * needs only enough to render the re-approval banner.
 */
import { describe, expect, it } from 'vitest';
import { mapBaselineRow } from './networkBaselines';

const RAW_ROW = {
  id: '11111111-1111-4111-8111-111111111111',
  orgId: '22222222-2222-4222-8222-222222222222',
  siteId: '33333333-3333-4333-8333-333333333333',
  subnet: '10.0.0.0/24',
  lastScanAt: null,
  lastScanJobId: null,
  knownDevices: [],
  scanSchedule: { enabled: true, intervalHours: 4, nextScanAt: '2026-10-15T00:00:00.000Z' },
  alertSettings: { newDevice: true, disappeared: true, changed: true, rogueDevice: false },
  authorityUserId: '44444444-4444-4444-8444-444444444444',
  authoritySiteIds: ['33333333-3333-4333-8333-333333333333'],
  authorityPermissionsEpoch: 12,
  authorityMfaEpoch: 5,
  authorityFingerprint: 'deadbeef'.repeat(8),
  authorityGeneration: 3,
  authorityArmedAt: new Date('2026-10-15T00:00:00.000Z'),
  scheduleBlockedReason: 'reapproval_required',
  createdAt: new Date('2026-10-14T00:00:00.000Z'),
  updatedAt: new Date('2026-10-15T00:00:00.000Z'),
};

const ROW = RAW_ROW as never;

describe('mapBaselineRow authority exposure', () => {
  it('never leaks the epochs, the fingerprint or the armed site ceiling', () => {
    const mapped = mapBaselineRow(ROW) as Record<string, unknown>;
    for (const secret of [
      'authorityPermissionsEpoch',
      'authorityMfaEpoch',
      'authorityFingerprint',
      'authoritySiteIds',
    ]) {
      expect(mapped).not.toHaveProperty(secret);
    }
  });

  it('exposes exactly what the re-approval banner needs', () => {
    const mapped = mapBaselineRow(ROW) as Record<string, unknown>;
    expect(mapped.scheduleBlockedReason).toBe('reapproval_required');
    expect(mapped.authorityUserId).toBe('44444444-4444-4444-8444-444444444444');
    expect(mapped.authorityArmedAt).toBe('2026-10-15T00:00:00.000Z');
    expect(mapped.authorityGeneration).toBe(3);
  });

  it('still returns the baseline fields the list and detail views render', () => {
    const mapped = mapBaselineRow(ROW) as Record<string, unknown>;
    expect(mapped.id).toBe(RAW_ROW.id);
    expect(mapped.subnet).toBe('10.0.0.0/24');
    expect(mapped.scanSchedule).toEqual(RAW_ROW.scanSchedule);
    expect(mapped.alertSettings).toEqual(RAW_ROW.alertSettings);
    expect(mapped.knownDevices).toEqual([]);
    expect(mapped.createdAt).toBe('2026-10-14T00:00:00.000Z');
    expect(mapped.updatedAt).toBe('2026-10-15T00:00:00.000Z');
    expect(mapped.lastScanAt).toBeNull();
  });
});
