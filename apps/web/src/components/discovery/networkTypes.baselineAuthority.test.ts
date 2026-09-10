/**
 * SEC-2026-09-05-146 — the API's schedule-blocked reason must survive mapping,
 * or the operator never learns that their recurring scan is being held and
 * never re-approves it.
 */
import { describe, expect, it } from 'vitest';
import { mapNetworkBaseline } from './networkTypes';

const RAW = {
  id: '11111111-1111-4111-8111-111111111111',
  orgId: '22222222-2222-4222-8222-222222222222',
  siteId: '33333333-3333-4333-8333-333333333333',
  subnet: '10.0.0.0/24',
  knownDevices: [],
  scanSchedule: { enabled: true, intervalHours: 4, nextScanAt: null },
  alertSettings: { newDevice: true, disappeared: true, changed: true, rogueDevice: false },
  createdAt: '2026-10-15T00:00:00.000Z',
  updatedAt: '2026-10-15T00:00:00.000Z',
};

describe('mapNetworkBaseline scheduleBlockedReason', () => {
  it('carries the blocked reason through', () => {
    const mapped = mapNetworkBaseline({ ...RAW, scheduleBlockedReason: 'reapproval_required' });
    expect(mapped?.scheduleBlockedReason).toBe('reapproval_required');
  });

  it('is null for a healthy baseline', () => {
    expect(mapNetworkBaseline({ ...RAW, scheduleBlockedReason: null })?.scheduleBlockedReason).toBeNull();
  });

  it('is null when the field is absent (older API)', () => {
    expect(mapNetworkBaseline(RAW)?.scheduleBlockedReason).toBeNull();
  });
});
