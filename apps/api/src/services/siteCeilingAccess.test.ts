import { describe, expect, it } from 'vitest';
import {
  canMutateOrgWideGovernance,
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

  it('exposes a stable denial message and error class', () => {
    expect(SITE_CEILING_WRITE_DENIED_MESSAGE).toMatch(/site-restricted/i);
    const err = new SiteCeilingWriteDeniedError();
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe(SITE_CEILING_WRITE_DENIED_MESSAGE);
    expect(err.name).toBe('SiteCeilingWriteDeniedError');
  });
});
