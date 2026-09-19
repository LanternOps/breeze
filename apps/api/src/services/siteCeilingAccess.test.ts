import { describe, expect, it } from 'vitest';
import {
  canMutateOrgWideGovernance,
  hasExactDeviceCeiling,
  hasSiteCeiling,
  SiteCeilingWriteDeniedError,
  SITE_CEILING_WRITE_DENIED_MESSAGE,
} from './siteCeilingAccess';

describe('siteCeilingAccess', () => {
  it.each([
    // [scope, allowedSiteIds, expectedHasCeiling]
    ['organization', undefined, false],
    ['organization', [], true],
    ['organization', ['s1'], true],
    ['organization', ['s1', 's2'], true],
    ['partner', undefined, false],
    ['partner', ['s1'], false], // partner scope never carries a ceiling, even if the field happens to be set
    ['partner', [], false],
    ['system', undefined, false],
    ['system', ['s1'], false],
  ] as const)('hasSiteCeiling(%s, %j) === %s', (scope, allowedSiteIds, expected) => {
    expect(hasSiteCeiling({ scope, allowedSiteIds: allowedSiteIds as string[] | undefined })).toBe(expected);
  });

  it.each([
    ['organization', undefined, true],
    ['organization', [], false],
    ['organization', ['s1'], false],
    ['partner', undefined, true],
    ['partner', ['s1'], true],
    ['system', undefined, true],
    ['system', ['s1'], true],
  ] as const)('canMutateOrgWideGovernance(%s, %j) === %s', (scope, allowedSiteIds, expected) => {
    expect(canMutateOrgWideGovernance({ scope, allowedSiteIds: allowedSiteIds as string[] | undefined })).toBe(
      expected
    );
  });

  it('canMutateOrgWideGovernance is exactly the negation of hasSiteCeiling', () => {
    const cases = [
      { scope: 'organization' as const, allowedSiteIds: undefined },
      { scope: 'organization' as const, allowedSiteIds: [] },
      { scope: 'organization' as const, allowedSiteIds: ['s1'] },
      { scope: 'partner' as const, allowedSiteIds: undefined },
      { scope: 'partner' as const, allowedSiteIds: ['s1'] },
      { scope: 'system' as const, allowedSiteIds: undefined },
    ];
    for (const c of cases) {
      expect(canMutateOrgWideGovernance(c)).toBe(!hasSiteCeiling(c));
    }
  });

  // contract-site-ceiling-gate §7B: ai_agent principals are governed by
  // exactly this helper, no special-casing. agentAuthContext.ts
  // (buildAgentAuthContext) sets allowedSiteIds only for device-bound runs —
  // these two shapes mirror what that function actually produces (see
  // services/aiAgents/agentAuthContext.test.ts for the end-to-end version
  // through buildAgentAuthContext itself).
  it('device-bound agent run shape (allowedSiteIds: [siteId]) cannot mutate org-wide governance', () => {
    const deviceBoundAgentAuth = { scope: 'organization' as const, allowedSiteIds: ['site-A'] };
    expect(hasSiteCeiling(deviceBoundAgentAuth)).toBe(true);
    expect(canMutateOrgWideGovernance(deviceBoundAgentAuth)).toBe(false);
  });

  it('device-bound agent run with no resolvable site (allowedSiteIds: []) also cannot mutate org-wide governance', () => {
    const deviceBoundAgentAuthNoSite = { scope: 'organization' as const, allowedSiteIds: [] };
    expect(hasSiteCeiling(deviceBoundAgentAuthNoSite)).toBe(true);
    expect(canMutateOrgWideGovernance(deviceBoundAgentAuthNoSite)).toBe(false);
  });

  it('org-wide (non-device-bound) agent run shape (allowedSiteIds undefined) has no ceiling here', () => {
    const orgWideAgentAuth = { scope: 'organization' as const, allowedSiteIds: undefined };
    expect(hasSiteCeiling(orgWideAgentAuth)).toBe(false);
    expect(canMutateOrgWideGovernance(orgWideAgentAuth)).toBe(true);
  });

  // #6096 residual 1 — the EXACT-DEVICE axis lives in this helper too.
  // A device-LESS analysis run carries `allowedDeviceIds` with NO
  // `allowedSiteIds`, so a site-only gate read it as unrestricted and let it
  // rewrite org-wide governance objects.
  describe('exact-device ceiling (#6096)', () => {
    it.each([
      // [allowedSiteIds, allowedDeviceIds, expectedCanMutate]
      [undefined, undefined, true],
      [undefined, ['dev-1'], false], // device-LESS analysis run: devices, no sites
      [undefined, [], false],
      [['site-A'], ['dev-1'], false],
      [[], ['dev-1'], false],
    ] as const)(
      'organization scope, sites %j, devices %j -> canMutateOrgWideGovernance %s',
      (allowedSiteIds, allowedDeviceIds, expected) => {
        expect(
          canMutateOrgWideGovernance({
            scope: 'organization',
            allowedSiteIds: allowedSiteIds as string[] | undefined,
            allowedDeviceIds: allowedDeviceIds as string[] | undefined,
          })
        ).toBe(expected);
      }
    );

    it('the device axis is not scope-gated — partner/system callers carrying it are denied too', () => {
      expect(canMutateOrgWideGovernance({ scope: 'partner', allowedDeviceIds: ['dev-1'] })).toBe(false);
      expect(canMutateOrgWideGovernance({ scope: 'system', allowedDeviceIds: ['dev-1'] })).toBe(false);
      expect(canMutateOrgWideGovernance({ scope: 'partner', allowedDeviceIds: undefined })).toBe(true);
    });

    it('hasSiteCeiling still speaks ONLY for the site axis', () => {
      expect(hasSiteCeiling({ scope: 'organization', allowedDeviceIds: ['dev-1'] })).toBe(false);
      expect(hasExactDeviceCeiling({ scope: 'organization', allowedDeviceIds: ['dev-1'] })).toBe(true);
      expect(hasExactDeviceCeiling({ scope: 'organization', allowedSiteIds: ['site-A'] })).toBe(false);
    });
  });

  it('exposes a stable denial message and error class', () => {
    expect(SITE_CEILING_WRITE_DENIED_MESSAGE).toMatch(/site-restricted/i);
    const err = new SiteCeilingWriteDeniedError();
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe(SITE_CEILING_WRITE_DENIED_MESSAGE);
    expect(err.name).toBe('SiteCeilingWriteDeniedError');
  });
});
