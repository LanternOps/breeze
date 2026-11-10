import { beforeEach, describe, expect, it, vi } from 'vitest';

const queue: unknown[][] = [];
const selects: unknown[] = [];
function chain(): unknown {
  const target = {
    then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve(queue.shift() ?? []).then(resolve, reject),
  };
  return new Proxy(target, { get: (t, prop) => (prop === 'then' ? t.then : () => chain()) });
}
vi.mock('../db', () => ({ db: { select: (cols: unknown) => { selects.push(cols); return chain(); } } }));

import { effectivePortalStatus, listPortalUsersForCaller, listPortalUsersForOrg } from './portalUserDirectory';

const ORG = '11111111-1111-4111-8111-111111111111';
const SENTINEL = '$argon2id$v=19$SENTINEL-HASH';
const row = (over: Record<string, unknown> = {}) => ({
  id: 'pu-1', email: 'c@example.com', name: 'C', passwordHash: SENTINEL, status: 'active',
  receiveNotifications: true, lastLoginAt: null, invitedAt: null, authMethod: 'password', browserAccess: 'granted', ...over,
});

beforeEach(() => {
  queue.length = 0;
  selects.length = 0;
});

describe('portalUserDirectory (W18, #6789)', () => {
  it('portal user list carries no passwordHash', async () => {
    queue.push([row()]);
    const list = await listPortalUsersForOrg(ORG);
    const text = JSON.stringify(list);
    expect(text).not.toContain(SENTINEL);
    expect(text).not.toContain('passwordHash');
    expect(list[0]).toMatchObject({ id: 'pu-1', effectiveStatus: 'active' });
  });

  it('portal user list items carry contactId and authMethod but never passwordHash (portal registration W1)', async () => {
    queue.push([row({ contactId: 'ct-1', authMethod: 'entra' })]);
    const list = await listPortalUsersForOrg(ORG);
    // The mock returns whatever is queued, so the SELECT itself must name the columns.
    expect(Object.keys(selects[0] as Record<string, unknown>)).toEqual(expect.arrayContaining(['contactId', 'authMethod']));
    expect(list[0]).toMatchObject({ contactId: 'ct-1', authMethod: 'entra' });
    expect(JSON.stringify(list)).not.toContain(SENTINEL);
    expect(list[0]).not.toHaveProperty('passwordHash');
  });

  it('effectiveStatus is pending_setup without a password, disabled wins', () => {
    const pw = { authMethod: 'password', hasExternalIdentity: false };
    expect(effectivePortalStatus({ status: 'invited', passwordHash: null, ...pw })).toBe('pending_setup');
    expect(effectivePortalStatus({ status: 'disabled', passwordHash: null, ...pw })).toBe('disabled');
    expect(effectivePortalStatus({ status: 'active', passwordHash: 'x', ...pw })).toBe('active');
  });

  it('effectiveStatus is pending_setup only for a password-eligible account with no password AND no identity (W3)', () => {
    // An identity is a credential: the account can sign in without a password.
    expect(effectivePortalStatus({ status: 'active', passwordHash: null, authMethod: 'password', hasExternalIdentity: true })).toBe('active');
    // Identity-only (add-in JIT, approved SSO request): never "pending setup".
    expect(effectivePortalStatus({ status: 'active', passwordHash: null, authMethod: 'entra', hasExternalIdentity: true })).toBe('active');
    expect(effectivePortalStatus({ status: 'disabled', passwordHash: null, authMethod: 'entra', hasExternalIdentity: true })).toBe('disabled');
  });

  it('identity-only active account reads active, not pending_setup; list items carry browserAccess and identityProviders', async () => {
    queue.push(
      [
        row({ id: 'pu-addin', passwordHash: null, status: 'active', authMethod: 'entra', browserAccess: 'none' }),
        row({ id: 'pu-pending', passwordHash: null, status: 'invited', authMethod: 'password', browserAccess: 'granted' }),
      ],
      [{ portalUserId: 'pu-addin', provider: 'entra' }],
    );
    const list = await listPortalUsersForOrg(ORG);
    expect(list[0]).toMatchObject({ id: 'pu-addin', effectiveStatus: 'active', browserAccess: 'none', identityProviders: ['entra'] });
    expect(list[1]).toMatchObject({ id: 'pu-pending', effectiveStatus: 'pending_setup', browserAccess: 'granted', identityProviders: [] });
    // The SELECT names browser_access; providers come from a second read over portal_user_identities.
    expect(Object.keys(selects[0] as Record<string, unknown>)).toEqual(expect.arrayContaining(['browserAccess']));
    expect(selects).toHaveLength(2);
    expect(Object.keys(selects[1] as Record<string, unknown>)).toEqual(expect.arrayContaining(['portalUserId', 'provider']));
    expect(JSON.stringify(list)).not.toContain('passwordHash');
  });

  it('an empty org runs no identity read', async () => {
    queue.push([]);
    expect(await listPortalUsersForOrg(ORG)).toEqual([]);
    expect(selects).toHaveLength(1);
  });

  it('an inaccessible org is not found without reading portal users', async () => {
    const auth = { scope: 'partner', canAccessOrg: () => false } as never;
    expect(await listPortalUsersForCaller(auth, ORG)).toBeNull();
    expect(selects).toHaveLength(0);
  });

  it('a deleted or missing org is not found', async () => {
    queue.push([]);
    const auth = { scope: 'partner', canAccessOrg: () => true } as never;
    expect(await listPortalUsersForCaller(auth, ORG)).toBeNull();
    expect(selects).toHaveLength(1);
  });

  it('an accessible org lists its users', async () => {
    queue.push([{ id: ORG }], [row({ passwordHash: null, status: 'invited' })]);
    const auth = { scope: 'partner', canAccessOrg: () => true } as never;
    expect(await listPortalUsersForCaller(auth, ORG)).toMatchObject([{ effectiveStatus: 'pending_setup' }]);
  });
});
