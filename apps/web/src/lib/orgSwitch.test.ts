import { describe, it, expect, beforeEach } from 'vitest';
import { stashSwitchToast, consumeSwitchToast, getOrgSwitchRedirect } from './orgSwitch';

describe('orgSwitch toast round-trip', () => {
  beforeEach(() => sessionStorage.clear());

  it('stashes a confirmation and consumes it exactly once (no re-toast on reload)', () => {
    stashSwitchToast('Switched to Acme');
    expect(consumeSwitchToast()).toBe('Switched to Acme');
    expect(consumeSwitchToast()).toBeNull();
  });

  it('returns null when nothing was stashed', () => {
    expect(consumeSwitchToast()).toBeNull();
  });
});

describe('getOrgSwitchRedirect', () => {
  it('redirects a device detail route up to its list so the new org does not 404', () => {
    expect(getOrgSwitchRedirect('/devices/dev-1')).toBe('/devices');
  });

  it('leaves the list and sibling routes in place (plain reload)', () => {
    expect(getOrgSwitchRedirect('/devices')).toBeNull();
    expect(getOrgSwitchRedirect('/devices/compare')).toBeNull();
    expect(getOrgSwitchRedirect('/devices/groups')).toBeNull();
  });

  it('does not redirect detail routes it has no rule for (they reload in place)', () => {
    expect(getOrgSwitchRedirect('/alerts/abc123')).toBeNull();
    expect(getOrgSwitchRedirect('/settings/organizations/abc123')).toBeNull();
  });
});
