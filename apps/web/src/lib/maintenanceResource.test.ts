import { describe, expect, it } from 'vitest';
import { canonicalMaintenanceResource } from './maintenanceResource';

/**
 * The step-up grant is bound to
 *   sha256("sha256:" + JSON.stringify({
 *     deviceIds: [...new Set(ids)].sort(), durationHours, reason: reason.trim(),
 *   }))
 * — `maintenanceResourceDigest` in apps/api/src/services/mfaStepUpGrant.ts.
 *
 * The client mints AND submits from one object produced here, so the two
 * digests cannot drift. A mismatch is a 403 that is deliberately
 * indistinguishable from a missing grant (the route conflates missing / stale /
 * mismatched so it is not a probing oracle), which means a drifted client is a
 * failure the technician cannot diagnose.
 */
describe('canonicalMaintenanceResource (RMM-QA-176 D10)', () => {
  it('dedupes and sorts deviceIds, exactly as the server digest does', () => {
    expect(
      canonicalMaintenanceResource({
        deviceIds: ['b2', 'a1', 'b2', 'c3'],
        reason: 'scheduled patching',
        durationHours: 2,
      }).deviceIds,
    ).toEqual(['a1', 'b2', 'c3']);
  });

  it('trims the reason, exactly as the server digest does', () => {
    expect(
      canonicalMaintenanceResource({
        deviceIds: ['a1'],
        reason: '  scheduled patching \n',
        durationHours: 2,
      }).reason,
    ).toBe('scheduled patching');
  });

  it('produces exactly the three fields the digest hashes, and nothing else', () => {
    // JSON.stringify is key-order sensitive on the SERVER side only because the
    // server rebuilds the object itself; what the client must not do is add or
    // drop a field, because the server digests { deviceIds, durationHours,
    // reason } from whatever it is handed.
    expect(
      canonicalMaintenanceResource({
        deviceIds: ['b2', 'a1'],
        reason: ' r r r ',
        durationHours: 168,
      }),
    ).toEqual({ deviceIds: ['a1', 'b2'], reason: 'r r r', durationHours: 168 });
  });
});
