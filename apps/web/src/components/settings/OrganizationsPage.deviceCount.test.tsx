import { describe, it, expect } from 'vitest';
import { shouldShowDeviceCount } from './OrganizationsPage';

// #3699 — the org card renders `{{count}} devices`. The list endpoint returned
// no count at all, so it interpolated to a bare " devices" (note the leading
// space): it read as a loading bug or an empty tenant on the one screen where
// the number is the point.
//
// The API now supplies it; this covers the renderer's half of the contract.
// The count stays optional because the organization-scoped branch of the
// endpoint returns a deliberately minimal projection without it.
//
// Asserted against the guard directly rather than through a rendered tree: an
// earlier version of this file rendered OrganizationList and checked for the
// absent label, which passed with or without the fix — that component shows a
// bare number under a "Devices" column and never renders the string at all.
describe('shouldShowDeviceCount', () => {
  it('shows a real count', () => {
    expect(shouldShowDeviceCount(12)).toBe(true);
  });

  // The bug this guards is the blank label, so 0 must still render — a
  // truthiness check here would hide the count for every new tenant.
  it('shows a real zero', () => {
    expect(shouldShowDeviceCount(0)).toBe(true);
  });

  it('renders nothing when the endpoint omitted the count', () => {
    expect(shouldShowDeviceCount(undefined)).toBe(false);
  });

  it('renders nothing for a non-finite value', () => {
    expect(shouldShowDeviceCount(Number.NaN)).toBe(false);
  });
});
