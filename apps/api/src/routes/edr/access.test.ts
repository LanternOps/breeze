import { describe, expect, it } from 'vitest';
import {
  EDR_CONNECTION_PUBLIC_SELECT,
  EDR_TENANT_PUBLIC_SELECT,
  isGateFailure,
  pgErrorCode,
  requireEdrPartnerAdmin,
  resolveEdrPartnerId,
  type EdrRouteAuth,
} from './access';

const PARTNER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function auth(over: Partial<EdrRouteAuth> = {}): EdrRouteAuth {
  return {
    scope: 'partner',
    partnerId: PARTNER,
    partnerOrgAccess: 'all',
    orgId: null,
    accessibleOrgIds: [],
    canAccessOrg: () => true,
    ...over,
  } as EdrRouteAuth;
}

describe('resolveEdrPartnerId', () => {
  it('returns the partner id for a partner token', () => {
    expect(resolveEdrPartnerId(auth())).toEqual({ partnerId: PARTNER });
  });
  it('refuses an org-scoped token with 403', () => {
    const r = resolveEdrPartnerId(auth({ scope: 'organization', orgId: 'o1' }));
    expect(isGateFailure(r) && r.status).toBe(403);
  });
  it('refuses a caller with no partner context', () => {
    const r = resolveEdrPartnerId(auth({ partnerId: null }));
    expect(isGateFailure(r) && r.status).toBe(403);
  });
});

describe('requireEdrPartnerAdmin', () => {
  it('allows a partner user with all-org access', () => {
    expect(requireEdrPartnerAdmin(auth())).toEqual({ partnerId: PARTNER });
  });
  it('refuses a selected-org partner user (Review Focus 5)', () => {
    const r = requireEdrPartnerAdmin(auth({ partnerOrgAccess: 'selected' }));
    expect(isGateFailure(r) && r.status).toBe(403);
  });
  it('refuses an org token', () => {
    const r = requireEdrPartnerAdmin(auth({ scope: 'organization', orgId: 'o1' }));
    expect(isGateFailure(r) && r.status).toBe(403);
  });
});

describe('pgErrorCode', () => {
  it('reads direct and wrapped codes', () => {
    expect(pgErrorCode({ code: '23505' })).toBe('23505');
    expect(pgErrorCode({ cause: { code: '23503' } })).toBe('23503');
    expect(pgErrorCode(null)).toBeNull();
  });
});

describe('public select lists', () => {
  const columnNames = (sel: Record<string, unknown>) =>
    Object.values(sel).map((v) => (v as { name?: string }).name).filter((n): n is string => typeof n === 'string');

  it('never select an *_encrypted column (connections)', () => {
    expect(Object.keys(EDR_CONNECTION_PUBLIC_SELECT).filter((k) => /encrypted/i.test(k))).toEqual([]);
    expect(columnNames(EDR_CONNECTION_PUBLIC_SELECT).filter((n) => n.endsWith('_encrypted'))).toEqual([]);
    expect(EDR_CONNECTION_PUBLIC_SELECT).toHaveProperty('hasCredentials');
    expect(EDR_CONNECTION_PUBLIC_SELECT).toHaveProperty('hasWebhookSecret');
  });
  it('never select an *_encrypted column (tenants)', () => {
    expect(Object.keys(EDR_TENANT_PUBLIC_SELECT).filter((k) => /encrypted/i.test(k))).toEqual([]);
    expect(columnNames(EDR_TENANT_PUBLIC_SELECT).filter((n) => n.endsWith('_encrypted'))).toEqual([]);
    expect(EDR_TENANT_PUBLIC_SELECT).toHaveProperty('hasInstallerSecret');
  });
});
