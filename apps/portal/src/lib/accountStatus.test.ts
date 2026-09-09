import { describe, expect, it } from 'vitest';
import {
  PORTAL_ACCOUNT_INACTIVE_CODE,
  PORTAL_ACCOUNT_DISABLED_PAGE,
  isAccountDisabledResponse,
  redirectToAccountDisabled,
} from './accountStatus';

describe('isAccountDisabledResponse', () => {
  it('is true for the API portal auth gate\'s inactive-account 403 (sweep 2026-09-08 G5-6)', () => {
    expect(isAccountDisabledResponse({ statusCode: 403, code: PORTAL_ACCOUNT_INACTIVE_CODE })).toBe(true);
  });

  it('is false for a bare 403 with no code (e.g. org-status gate)', () => {
    expect(isAccountDisabledResponse({ statusCode: 403 })).toBe(false);
  });

  it('is false for an unrelated 403 code (e.g. a visibility gate)', () => {
    expect(isAccountDisabledResponse({ statusCode: 403, code: 'PORTAL_TICKETS_DISABLED' })).toBe(false);
  });

  it('is false for a non-403 outcome even carrying the code', () => {
    expect(isAccountDisabledResponse({ statusCode: 200, code: PORTAL_ACCOUNT_INACTIVE_CODE })).toBe(false);
  });

  it('is false for a network-error response with neither field', () => {
    expect(isAccountDisabledResponse({})).toBe(false);
  });
});

describe('redirectToAccountDisabled', () => {
  it('redirects to the account-disabled page', () => {
    const redirect = (path: string, status?: number) => new Response(null, { status: status ?? 302, headers: { Location: path } });
    const res = redirectToAccountDisabled({ redirect });
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe(PORTAL_ACCOUNT_DISABLED_PAGE);
  });
});
