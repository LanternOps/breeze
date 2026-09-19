import { describe, expect, it } from 'vitest';
import { portalLandingPath, resolveAuthenticatedLanding } from './landing';

describe('portalLandingPath', () => {
  it('uses dashboard only when explicitly enabled', () => {
    expect(portalLandingPath({
      enableDashboard: true,
    })).toBe('/dashboard');
    expect(portalLandingPath({
      enableDashboard: false,
    })).toBe('/quotes');
    expect(portalLandingPath({})).toBe('/quotes');
  });
});

describe('resolveAuthenticatedLanding (sweep 2026-09-08 G5-6)', () => {
  it('sends a disabled account to the account-disabled page regardless of branding', () => {
    expect(resolveAuthenticatedLanding({
      accountDisabled: true,
      branding: { enableDashboard: true },
    })).toBe('/account-disabled');
    expect(resolveAuthenticatedLanding({
      accountDisabled: true,
      branding: {},
    })).toBe('/account-disabled');
  });

  it('falls through to the normal branding-based landing when the account is active', () => {
    expect(resolveAuthenticatedLanding({
      accountDisabled: false,
      branding: { enableDashboard: true },
    })).toBe('/dashboard');
    expect(resolveAuthenticatedLanding({
      accountDisabled: false,
      branding: {},
    })).toBe('/quotes');
  });
});
