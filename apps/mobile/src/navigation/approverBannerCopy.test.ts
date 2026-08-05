import { describe, it, expect } from 'vitest';

import { approverBannerCopy, describeApproverReason } from './approverBannerCopy';

describe('describeApproverReason', () => {
  it('returns null when there is no reason', () => {
    expect(describeApproverReason(null)).toBeNull();
  });

  it('returns null for no_reauth_grant, which the deferred body already explains', () => {
    expect(describeApproverReason('no_reauth_grant')).toBeNull();
  });

  it('explains a rejected grant for 401/403 rather than showing a bare code', () => {
    for (const code of ['http_401', 'http_403']) {
      const out = describeApproverReason(code);
      expect(out).toMatch(/grant/i);
      expect(out).not.toContain(code);
    }
  });

  it('collapses any 5xx to a server-unavailable message', () => {
    expect(describeApproverReason('http_500')).toMatch(/unavailable/i);
    expect(describeApproverReason('http_503')).toMatch(/unavailable/i);
  });

  it('surfaces the status number for other http failures', () => {
    expect(describeApproverReason('http_418')).toContain('418');
  });

  it('surfaces the exception name for client-side failures', () => {
    expect(describeApproverReason('exception:TypeError')).toContain('TypeError');
  });

  it('passes an unrecognised code through instead of swallowing it', () => {
    expect(describeApproverReason('something_new')).toBe('something_new');
  });
});

describe('approverBannerCopy', () => {
  // The whole point of this module: the old copy said "isn't set up for
  // biometric approval", which sent users to iOS Settings to enable Face ID —
  // an action that cannot fix a server-side registration failure.
  it('never tells the user to enable biometrics', () => {
    for (const severity of ['failed', 'deferred'] as const) {
      const copy = approverBannerCopy(severity, 'http_403');
      const text = `${copy.title} ${copy.body}`.toLowerCase();
      expect(text).not.toMatch(/enable (face id|touch id|biometric)/);
      expect(text).not.toMatch(/turn on (face id|touch id|biometric)/);
      expect(text).not.toMatch(/isn.t set up for biometric/);
    }
  });

  it('points at signing in again, the only remedy that re-issues a grant', () => {
    for (const severity of ['failed', 'deferred'] as const) {
      expect(approverBannerCopy(severity, null).actionLabel).toMatch(/sign out and back in/i);
    }
  });

  it('explains the L1 downgrade so the consequence is not invisible', () => {
    for (const severity of ['failed', 'deferred'] as const) {
      expect(approverBannerCopy(severity, null).body).toMatch(/lowest assurance level/i);
    }
  });

  it('states explicitly that Face ID is not the cause on the failed variant', () => {
    expect(approverBannerCopy('failed', 'http_403').body).toMatch(/not about face id/i);
  });

  it('attaches the decoded reason as detail when there is one', () => {
    expect(approverBannerCopy('failed', 'http_403').detail).toMatch(/grant/i);
  });

  it('omits detail when the reason adds nothing', () => {
    expect(approverBannerCopy('deferred', 'no_reauth_grant').detail).toBeNull();
    expect(approverBannerCopy('failed', null).detail).toBeNull();
  });

  it('uses distinct titles so the two states are distinguishable', () => {
    expect(approverBannerCopy('failed', null).title).not.toBe(
      approverBannerCopy('deferred', null).title
    );
  });
});
