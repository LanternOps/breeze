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
  receiveNotifications: true, lastLoginAt: null, invitedAt: null, ...over,
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

  it('effectiveStatus is pending_setup without a password, disabled wins', () => {
    expect(effectivePortalStatus({ status: 'invited', passwordHash: null })).toBe('pending_setup');
    expect(effectivePortalStatus({ status: 'disabled', passwordHash: null })).toBe('disabled');
    expect(effectivePortalStatus({ status: 'active', passwordHash: 'x' })).toBe('active');
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
