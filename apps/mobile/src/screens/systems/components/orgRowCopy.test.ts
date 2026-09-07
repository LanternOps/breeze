import { describe, it, expect } from 'vitest';

import { orgRowSubtitle } from './orgRowCopy';

describe('orgRowSubtitle', () => {
  it('reads "healthy" for a single healthy device with no issues', () => {
    expect(orgRowSubtitle({ deviceCount: 1, offlineCount: 0, issueCount: 0 })).toBe('1 device, healthy');
  });

  it('pluralizes devices when healthy', () => {
    expect(orgRowSubtitle({ deviceCount: 3, offlineCount: 0, issueCount: 0 })).toBe('3 devices, healthy');
  });

  it('shows the offline count instead of "healthy" once any device is offline', () => {
    expect(orgRowSubtitle({ deviceCount: 7, offlineCount: 2, issueCount: 0 })).toBe('7 devices · 2 offline');
  });

  it('singularizes "offline" is not a thing — the noun stays "offline", only the device count pluralizes', () => {
    expect(orgRowSubtitle({ deviceCount: 1, offlineCount: 1, issueCount: 0 })).toBe('1 device · 1 offline');
  });

  it('falls back to the issue count when nothing is offline but issues exist', () => {
    expect(orgRowSubtitle({ deviceCount: 5, offlineCount: 0, issueCount: 1 })).toBe('5 devices · 1 issue');
    expect(orgRowSubtitle({ deviceCount: 5, offlineCount: 0, issueCount: 2 })).toBe('5 devices · 2 issues');
  });

  it('prioritizes offline over issues when both are present', () => {
    expect(orgRowSubtitle({ deviceCount: 10, offlineCount: 3, issueCount: 4 })).toBe('10 devices · 3 offline');
  });
});
