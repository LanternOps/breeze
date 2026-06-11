import { describe, it, expect } from 'vitest';
import { getViewerAccessTokenExpirySeconds } from './remoteSessionAuth';
import { VIEWER_ACCESS_TOKEN_EXPIRY_SECONDS } from './jwt';

/**
 * Security finding #6 — the viewer-token exchange responses (/connect/exchange,
 * VNC exchanges) advertised `expiresInSeconds: 900` while the signed viewer JWT
 * actually lived 2h, an 8x understatement of the real exposure window. The fix
 * derives the advertised value from the same source as the JWT so they cannot
 * drift. This test locks that invariant.
 */
describe('viewer access token advertised TTL (finding #6)', () => {
  it('advertises exactly the real signed viewer-token TTL', () => {
    expect(getViewerAccessTokenExpirySeconds()).toBe(VIEWER_ACCESS_TOKEN_EXPIRY_SECONDS);
  });

  it('does not regress to the stale 15-minute (900s) advertised window', () => {
    expect(getViewerAccessTokenExpirySeconds()).not.toBe(900);
    // Real viewer sessions run for hours; the advertised window must be >= 2h
    // (non-E2E) so clients are never told the token dies sooner than it does.
    expect(getViewerAccessTokenExpirySeconds()).toBeGreaterThanOrEqual(2 * 60 * 60);
  });
});
