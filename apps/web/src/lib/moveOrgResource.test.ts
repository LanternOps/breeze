import { describe, expect, it } from 'vitest';
import { canonicalMoveOrgResource, moveOrgRequestBody } from './moveOrgResource';

/**
 * The step-up grant for device_move_org is bound to
 *   sha256(JSON.stringify({ acceptCurrencyMismatch, deviceId, targetOrgId, targetSiteId }))
 * — `moveOrgResourceDigest` in apps/api/src/services/mfaStepUpGrant.ts (W01).
 * The client mints AND submits from ONE object produced here, so the two
 * digests cannot drift. A mismatch is a 403 that is deliberately
 * indistinguishable from a missing grant.
 */
describe('canonicalMoveOrgResource (move-org step-up D5)', () => {
  it('defaults acceptCurrencyMismatch to an explicit false, exactly as the server canonicalises undefined', () => {
    expect(
      canonicalMoveOrgResource({ deviceId: 'd1', targetOrgId: 'o2', targetSiteId: 's2' }),
    ).toEqual({ deviceId: 'd1', targetOrgId: 'o2', targetSiteId: 's2', acceptCurrencyMismatch: false });
  });

  it('keeps an explicit true', () => {
    expect(
      canonicalMoveOrgResource({ deviceId: 'd1', targetOrgId: 'o2', targetSiteId: 's2', acceptCurrencyMismatch: true })
        .acceptCurrencyMismatch,
    ).toBe(true);
  });

  it('produces exactly the four fields the digest hashes, and nothing else', () => {
    const out = canonicalMoveOrgResource({
      deviceId: 'd1', targetOrgId: 'o2', targetSiteId: 's2', acceptCurrencyMismatch: false,
      // @ts-expect-error — an extra field must be dropped, never forwarded into the digest
      extra: 'x',
    });
    expect(Object.keys(out).sort()).toEqual(['acceptCurrencyMismatch', 'deviceId', 'targetOrgId', 'targetSiteId']);
  });
});

describe('moveOrgRequestBody', () => {
  it('maps the canonical resource onto the route body and omits stepUpGrant when absent', () => {
    const resource = canonicalMoveOrgResource({ deviceId: 'd1', targetOrgId: 'o2', targetSiteId: 's2' });
    expect(moveOrgRequestBody(resource)).toEqual({ orgId: 'o2', siteId: 's2', acceptCurrencyMismatch: false });
  });

  it('carries stepUpGrant when given', () => {
    const resource = canonicalMoveOrgResource({ deviceId: 'd1', targetOrgId: 'o2', targetSiteId: 's2', acceptCurrencyMismatch: true });
    expect(moveOrgRequestBody(resource, 'grant-1')).toEqual({
      orgId: 'o2', siteId: 's2', acceptCurrencyMismatch: true, stepUpGrant: 'grant-1',
    });
  });
});
