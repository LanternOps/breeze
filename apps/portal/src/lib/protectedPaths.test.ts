import { describe, expect, it } from 'vitest';
import {
  PORTAL_PROTECTED_PREFIXES,
  isProtectedPath,
  requiresAccountStatusGuard
} from './protectedPaths';
import { PORTAL_ACCOUNT_DISABLED_PAGE } from './accountStatus';

describe('isProtectedPath', () => {
  it('matches a protected prefix exactly and as a path segment', () => {
    expect(isProtectedPath('/tickets')).toBe(true);
    expect(isProtectedPath('/tickets/42')).toBe(true);
  });

  it('does not match a prefix that is only a string prefix of another route', () => {
    expect(isProtectedPath('/ticketsomething')).toBe(false);
  });

  it('leaves the public token documents and auth pages unprotected', () => {
    for (const path of ['/login', '/forgot-password', '/reset-password', '/accept-invite', '/quote/abc', '/invoice/abc', '/invoice/return']) {
      expect(isProtectedPath(path), path).toBe(false);
    }
  });
});

describe('requiresAccountStatusGuard', () => {
  // #5320 — the account-disabled bounce used to live only in the landing
  // computation (/, /login, /forgot-password) plus a hand-rolled check in
  // quotes/index.astro, so every other signed-in page rendered the API's raw
  // "Account is not active" text inline.
  it('guards every protected page', () => {
    for (const prefix of PORTAL_PROTECTED_PREFIXES) {
      if (prefix === PORTAL_ACCOUNT_DISABLED_PAGE) continue;
      expect(requiresAccountStatusGuard(prefix), prefix).toBe(true);
      expect(requiresAccountStatusGuard(`${prefix}/child`), prefix).toBe(true);
    }
  });

  it('never guards the account-disabled page itself (redirect loop)', () => {
    expect(requiresAccountStatusGuard(PORTAL_ACCOUNT_DISABLED_PAGE)).toBe(false);
    expect(requiresAccountStatusGuard(`${PORTAL_ACCOUNT_DISABLED_PAGE}/`)).toBe(false);
  });

  it('never guards unauthenticated surfaces (no API round trip for a signed-out visitor)', () => {
    for (const path of ['/login', '/forgot-password', '/reset-password', '/accept-invite', '/quote/abc', '/invoice/abc']) {
      expect(requiresAccountStatusGuard(path), path).toBe(false);
    }
  });
});
