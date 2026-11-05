import { beforeEach, describe, expect, it, vi } from 'vitest';

// Each db.select() chain resolves to the next queued result, whatever the
// builder methods in between (from / innerJoin / where / limit).
const queue: unknown[][] = [];
const selects: unknown[] = [];
function chain(): unknown {
  const target = {
    then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve(queue.shift() ?? []).then(resolve, reject),
  };
  return new Proxy(target, {
    get: (t, prop) => (prop === 'then' ? t.then : () => chain()),
  });
}
vi.mock('../db', () => ({
  db: { select: (cols: unknown) => { selects.push(cols); return chain(); } },
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
}));
vi.mock('./mfaPolicy', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./mfaPolicy')>()),
  getScopeSecuritySettings: vi.fn(async () => undefined),
}));

import {
  getScopedUserForCaller,
  hasFullPartnerMembership,
  listScopedUsersForCaller,
} from './userDirectory';

const partnerAuth = (over: Record<string, unknown> = {}) =>
  ({
    scope: 'partner',
    partnerId: 'p-1',
    orgId: null,
    user: { id: 'u-caller' },
    accessibleOrgIds: ['o-1'],
    partnerOrgAccess: 'all',
    ...over,
  }) as never;

const userRow = {
  id: 'u-1',
  email: 'a@example.com',
  name: 'A',
  status: 'active',
  lastLoginAt: null,
  mfaEnabled: true,
  mfaEpoch: 3,
  mfaEnrollmentDeadline: null,
  mfaEnrollmentGraceGrantedAt: null,
  roleId: 'r-1',
  roleName: 'Admin',
  roleForceMfa: true,
  orgAccess: 'all',
  orgIds: null,
};

beforeEach(() => {
  queue.length = 0;
  selects.length = 0;
});

describe('userDirectory gates (W18, #6789)', () => {
  it('hasFullPartnerMembership reads partner_users.orgAccess, not accessibleOrgIds', async () => {
    queue.push([{ orgAccess: 'selected' }]);
    expect(await hasFullPartnerMembership(partnerAuth())).toBe(false);
    queue.push([{ orgAccess: 'all' }]);
    expect(await hasFullPartnerMembership(partnerAuth())).toBe(true);
    queue.push([]);
    expect(await hasFullPartnerMembership(partnerAuth())).toBe(false);
  });

  it('selected-org partner caller refused by listScopedUsers and getScopedUser, and nothing else is read', async () => {
    queue.push([{ orgAccess: 'selected' }]);
    const list = await listScopedUsersForCaller(partnerAuth());
    expect(list).toEqual({ ok: false, code: 'FORBIDDEN', message: 'Full partner organization access required' });
    expect(selects).toHaveLength(1);

    queue.push([{ orgAccess: 'none' }]);
    const one = await getScopedUserForCaller(partnerAuth(), 'u-1');
    expect(one).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    expect(selects).toHaveLength(2);
  });

  it('a partner token without a partner id is refused', async () => {
    const result = await listScopedUsersForCaller(partnerAuth({ partnerId: null }));
    expect(result).toEqual({ ok: false, code: 'FORBIDDEN', message: 'Partner context required' });
    expect(selects).toHaveLength(0);
  });

  it('system scope without a partner or org context is refused (getScopeContext parity)', async () => {
    const auth = { scope: 'system', partnerId: null, orgId: null, user: { id: 'u' }, accessibleOrgIds: null } as never;
    expect(await listScopedUsersForCaller(auth)).toEqual({
      ok: false, code: 'FORBIDDEN', message: 'Partner or organization context required',
    });
    expect(await getScopedUserForCaller(auth, 'u-1')).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    expect(selects).toHaveLength(0);
  });

  it('listScopedUsers drops roleForceMfa, mfaEpoch, grace columns and keeps mfaStatus', async () => {
    queue.push([{ orgAccess: 'all' }], [userRow], []);
    const result = await listScopedUsersForCaller(partnerAuth());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [row] = result.value;
    expect(row).toMatchObject({ id: 'u-1', mfaStatus: 'enrolled', mfaProtected: true });
    for (const key of ['roleForceMfa', 'mfaEpoch', 'mfaEnrollmentGraceGrantedAt', 'passwordHash']) {
      expect(Object.keys(row!)).not.toContain(key);
    }
  });

  it('no credential column is ever SELECTED by the list or single-user reads (projection, not row shape)', async () => {
    const CREDENTIAL = /password|secret|recovery|totp|token|hash|epoch|grace|forceMfa/i;
    queue.push([{ orgAccess: 'all' }], [userRow], []);
    await listScopedUsersForCaller(partnerAuth());
    queue.push([{ orgAccess: 'all' }], [{ id: 'u-1' }]);
    await getScopedUserForCaller(partnerAuth(), 'u-1');
    const orgAuth = { scope: 'organization', partnerId: null, orgId: 'o-1', user: { id: 'u' } } as never;
    queue.push([{ id: 'u-1' }]);
    await getScopedUserForCaller(orgAuth, 'u-1');
    // selects[1] is the list query, selects[4] and selects[5] the two single-user reads.
    const listed = Object.keys(selects[1] as object);
    expect(listed).toContain('email');
    // The list SELECTS mfaEpoch / grace / roleForceMfa only to derive mfaStatus; they are stripped from the
    // output (asserted above). Nothing else credential-shaped is selected.
    expect(listed.filter((k) => CREDENTIAL.test(k)).sort()).toEqual(['mfaEnrollmentGraceGrantedAt', 'mfaEpoch', 'roleForceMfa']);
    for (const cols of [selects[4], selects[5]]) {
      expect(Object.keys(cols as object)).toContain('email');
      expect(Object.keys(cols as object).filter((k) => CREDENTIAL.test(k))).toEqual([]);
    }
  });

  it('a partner token with no allowlist array still needs orgAccess all (stricter than the router)', async () => {
    queue.push([{ orgAccess: 'selected' }]);
    expect(await listScopedUsersForCaller(partnerAuth({ accessibleOrgIds: undefined }))).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    queue.push([{ orgAccess: 'selected' }]);
    expect(await getScopedUserForCaller(partnerAuth({ accessibleOrgIds: null }), 'u-1')).toMatchObject({ ok: false, code: 'FORBIDDEN' });
  });

  it('an organization caller lists its org without a partner membership read', async () => {
    const auth = { scope: 'organization', partnerId: null, orgId: 'o-1', user: { id: 'u' } } as never;
    queue.push([{ ...userRow, orgAccess: undefined, orgIds: undefined, siteIds: null, deviceGroupIds: null }], []);
    const result = await listScopedUsersForCaller(auth);
    expect(result.ok).toBe(true);
    expect(selects).toHaveLength(2);
  });

  it('a user outside the caller scope is NOT_FOUND', async () => {
    queue.push([{ orgAccess: 'all' }], []);
    expect(await getScopedUserForCaller(partnerAuth(), 'u-foreign')).toEqual({
      ok: false, code: 'NOT_FOUND', message: 'User not found',
    });
  });
});
