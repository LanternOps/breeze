import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { canSeeEdrDetection, edrSitePredicate, type EdrSiteRestriction } from './readScope';

const DEV_A = 'dev-a';
const DEV_B = 'dev-b';
const SITE_A = 'site-a';
const SITE_B = 'site-b';
const restricted: EdrSiteRestriction = { allowedDeviceIds: [DEV_A], allowedSiteIds: [SITE_A] };
const unrestricted: EdrSiteRestriction = { allowedDeviceIds: null, allowedSiteIds: null };
const row = (breezeDeviceId: string | null, detached: boolean, lastSiteId: string | null) =>
  ({ breezeDeviceId, deviceDetachedAt: detached ? new Date() : null, lastSiteId });

describe('canSeeEdrDetection — D14 truth table (#8166)', () => {
  it.each([
    ['linked to an allowed-site device', row(DEV_A, false, null), true],
    ['linked to a foreign-site device', row(DEV_B, false, null), false],
    ['never linked', row(null, false, null), true],
    ['detached from an allowed site', row(null, true, SITE_A), true],
    ['detached from a foreign site', row(null, true, SITE_B), false],
    ['detached from a site-less device (last_site_id NULL)', row(null, true, null), false],
  ] as const)('restricted caller: %s → %s', (_n, r, expected) => {
    expect(canSeeEdrDetection(r, restricted)).toBe(expected);
  });

  it('a restricted caller with empty allowlists sees only never-linked rows', () => {
    const empty: EdrSiteRestriction = { allowedDeviceIds: [], allowedSiteIds: [] };
    expect(canSeeEdrDetection(row(DEV_A, false, null), empty)).toBe(false);
    expect(canSeeEdrDetection(row(null, true, SITE_A), empty)).toBe(false);
    expect(canSeeEdrDetection(row(null, false, null), empty)).toBe(true);
  });

  it('an unrestricted caller sees every row', () => {
    for (const r of [row(DEV_B, false, null), row(null, true, null), row(null, true, SITE_B)]) {
      expect(canSeeEdrDetection(r, unrestricted)).toBe(true);
    }
  });
});

describe('edrSitePredicate — SQL shape', () => {
  const render = (r: EdrSiteRestriction) => new PgDialect().sqlToQuery(edrSitePredicate(r)!);

  it('is undefined for an unrestricted caller', () => {
    expect(edrSitePredicate(unrestricted)).toBeUndefined();
  });

  it('is ONE parenthesized OR of the three branches, with the allowed ids bound', () => {
    const q = render(restricted);
    expect(q.sql).toBe(
      '("edr_detections"."breeze_device_id" in ($1) or '
      + '("edr_detections"."breeze_device_id" is null and "edr_detections"."device_detached_at" is null) or '
      + '("edr_detections"."breeze_device_id" is null and "edr_detections"."device_detached_at" is not null '
      + 'and "edr_detections"."last_site_id" in ($2)))',
    );
    expect(q.params).toEqual([DEV_A, SITE_A]);
  });

  it('empty allowlists reduce to the never-linked branch (no IN ())', () => {
    const q = render({ allowedDeviceIds: [], allowedSiteIds: [] });
    expect(q.sql).toBe('("edr_detections"."breeze_device_id" is null and "edr_detections"."device_detached_at" is null)');
    expect(q.params).toEqual([]);
  });
});
