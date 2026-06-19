import { describe, expect, it } from 'vitest';

import { getErrorMessage, getErrorTitle, isAccessDenied } from './errorMessages';

// #1629 follow-up: a 403 is a permission denial, NOT an expired session. Before
// the fix, both 401 and 403 mapped to "Session expired / Please sign in again",
// so a validly-signed-in but permission-limited user was told to sign in again.
describe('errorMessages — 401 vs 403 distinction', () => {
  // A real Response so the `error instanceof Response` branch is exercised.
  const resp = (status: number): Response => new Response(null, { status });

  it('401 (Response) → "Session expired" / "sign in again"', () => {
    const err = resp(401);
    expect(getErrorTitle(err)).toBe('Session expired');
    expect(getErrorMessage(err)).toBe('Your session has expired. Please sign in again.');
    expect(isAccessDenied(err)).toBe(false);
  });

  it('403 (Response) → "Access denied" / permission message, NOT session expired', () => {
    const err = resp(403);
    expect(getErrorTitle(err)).toBe('Access denied');
    expect(getErrorMessage(err)).toBe("You don't have permission to view this.");
    // The two must produce different titles + messages (the core bug).
    expect(getErrorTitle(err)).not.toBe(getErrorTitle(resp(401)));
    expect(getErrorMessage(err)).not.toBe(getErrorMessage(resp(401)));
    expect(isAccessDenied(err)).toBe(true);
  });

  it('treats any error object carrying status === 403 as access-denied (e.g. ActionError)', () => {
    const actionLike = Object.assign(new Error('forbidden'), { status: 403 });
    expect(isAccessDenied(actionLike)).toBe(true);
    expect(getErrorTitle(actionLike)).toBe('Access denied');
    expect(getErrorMessage(actionLike)).toBe("You don't have permission to view this.");

    const actionLike401 = Object.assign(new Error('unauthorized'), { status: 401 });
    expect(isAccessDenied(actionLike401)).toBe(false);
    expect(getErrorTitle(actionLike401)).toBe('Session expired');
  });

  it('5xx still maps to a server error and is not access-denied', () => {
    const err = resp(503);
    expect(getErrorTitle(err)).toBe('Server error');
    expect(getErrorMessage(err)).toBe("Something went wrong on our end. We're looking into it.");
    expect(isAccessDenied(err)).toBe(false);
  });

  it('network/fetch failures are unchanged and not access-denied', () => {
    const err = new TypeError('Failed to fetch');
    expect(getErrorTitle(err)).toBe('Connection error');
    expect(getErrorMessage(err)).toBe('Unable to reach the server. Check your connection and try again.');
    expect(isAccessDenied(err)).toBe(false);
  });

  it('a plain non-status error is not access-denied', () => {
    expect(isAccessDenied(new Error('boom'))).toBe(false);
    expect(isAccessDenied('boom')).toBe(false);
    expect(isAccessDenied(null)).toBe(false);
  });
});
