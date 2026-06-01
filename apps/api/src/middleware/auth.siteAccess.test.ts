import { describe, it, expect } from 'vitest';
import { siteAccessCheck } from './auth';

/**
 * `siteAccessCheck` is the single source of truth for the AuthContext site-axis
 * closure, reused by the request path (authMiddleware) and the MCP API-key path
 * (buildAuthFromApiKey) so the two never drift. Semantics mirror
 * `permissions.canAccessSite`: undefined allowlist = unrestricted.
 */
describe('siteAccessCheck — AuthContext site-axis closure', () => {
  it('is unrestricted when the allowlist is undefined', () => {
    const can = siteAccessCheck(undefined);
    expect(can('site-A')).toBe(true);
    expect(can(null)).toBe(true);
    expect(can(undefined)).toBe(true);
  });

  it('allows only sites in the allowlist when restricted', () => {
    const can = siteAccessCheck(['site-A', 'site-B']);
    expect(can('site-A')).toBe(true);
    expect(can('site-B')).toBe(true);
    expect(can('site-C')).toBe(false);
  });

  it('denies a null/undefined site for a restricted caller (device with no site)', () => {
    const can = siteAccessCheck(['site-A']);
    expect(can(null)).toBe(false);
    expect(can(undefined)).toBe(false);
  });

  it('denies everything when the allowlist is empty (matches permissions.canAccessSite)', () => {
    const can = siteAccessCheck([]);
    expect(can('site-A')).toBe(false);
    expect(can(null)).toBe(false);
  });
});
