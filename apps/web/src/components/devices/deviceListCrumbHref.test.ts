import { describe, expect, it } from 'vitest';
import { deviceListCrumbHref } from './deviceListCrumbHref';

describe('deviceListCrumbHref', () => {
  it('goes to the fleet list when no org is selected (fleet view)', () => {
    expect(deviceListCrumbHref(null, 'org-42')).toBe('/devices');
  });

  it('goes to the fleet list when the working org is the device org', () => {
    expect(deviceListCrumbHref('org-42', 'org-42')).toBe('/devices');
  });

  it("goes to the device org's Devices tab when the working org differs", () => {
    expect(deviceListCrumbHref('org-99', 'org-42')).toBe('/organizations/org-42#devices');
  });

  it('never builds an org URL from an empty device org id', () => {
    expect(deviceListCrumbHref('org-99', '')).toBe('/devices');
  });
});
