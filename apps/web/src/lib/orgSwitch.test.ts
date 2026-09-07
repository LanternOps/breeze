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

describe('getOrgSwitchRedirect — organization record (#5075)', () => {
  it('redirects the record up to the organizations list (the record pins ITS org, not the switcher)', () => {
    // Reloading /organizations/<other-org> after a switch would leave the user
    // staring at the customer they just navigated away from: the record's org
    // comes from the URL, so a context switch has to leave the record entirely.
    expect(getOrgSwitchRedirect('/organizations/abc123')).toBe('/settings/organizations');
    expect(getOrgSwitchRedirect('/organizations/abc123/')).toBe('/settings/organizations');
  });

  it('leaves deeper record sub-routes and the bare prefix alone', () => {
    expect(getOrgSwitchRedirect('/organizations/abc123/anything')).toBeNull();
    expect(getOrgSwitchRedirect('/organizations')).toBeNull();
  });
});
