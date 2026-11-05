import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '../../middleware/auth';

/**
 * Tool catalog W04 (#5219), plan Task A9 — `clampToCallerCredential`, the
 * credential clamp rule 7 runs against. The api_keys read is a one-result
 * fake; `validateApiKeyScopeDelegation` / `requiredPermissionsForApiKeyScopes`
 * are the REAL scope policy (the clamp is only as good as that mapping).
 */

const { keyRows } = vi.hoisted(() => ({ keyRows: [] as unknown[] }));

vi.mock('../../db', () => {
  const chain = (): unknown => new Proxy(() => {}, {
    get(_t, prop) {
      if (prop === 'then') {
        const value = keyRows.shift();
        return (res: (v: unknown) => void, rej: (e: unknown) => void) =>
          (value instanceof Error ? Promise.reject(value) : Promise.resolve(value ?? [])).then(res, rej);
      }
      return () => chain();
    },
  });
  return {
    db: { select: () => chain() },
    runOutsideDbContext: (fn: () => unknown) => fn(),
    withSystemDbAccessContext: (fn: () => unknown) => fn(),
  };
});

import type { UserPermissions } from '../permissions';
import { clampToCallerCredential } from './triggererAccess';

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG = '11111111-1111-4111-8111-222222222222';
const USER = '44444444-4444-4444-8444-444444444444';

const perms = (over: Partial<UserPermissions> = {}): UserPermissions => ({
  permissions: [{ resource: '*', action: '*' }], partnerId: 'p', orgId: ORG, roleId: 'r', scope: 'organization', ...over,
});
const keyAuth = (over: Record<string, unknown> = {}) =>
  ({ principal: { kind: 'api_key', apiKeyId: 'k', ...over }, user: { id: USER } }) as unknown as Pick<AuthContext, 'principal' | 'user'>;
const keyRow = (over: Record<string, unknown> = {}) => ({
  scopes: ['ai:read', 'ai:write', 'ai:execute'], principalType: 'human', createdBy: USER, orgId: ORG, status: 'active', ...over,
});

beforeEach(() => {
  keyRows.length = 0;
});

describe('clampToCallerCredential', () => {
  it('a user session keeps its own permissions', async () => {
    const p = perms();
    expect(await clampToCallerCredential({ principal: { kind: 'user_session' }, user: { id: USER } } as never, p, ORG)).toBe(p);
  });

  it('a human key is clamped to its scope-conferred permissions the creator still holds', async () => {
    keyRows.push([keyRow({ scopes: ['ai:read'] })]);
    const out = await clampToCallerCredential(keyAuth(), perms(), ORG);
    expect(out).not.toBeNull();
    expect(out!.permissions.length).toBeGreaterThan(0);
    expect(out!.permissions.some((p) => p.resource === 'scripts' && p.action === 'execute')).toBe(false);
  });

  it('a DB error on the key lookup propagates (never read as "no permissions")', async () => {
    keyRows.push(new Error('connection terminated unexpectedly'));
    await expect(clampToCallerCredential(keyAuth(), perms(), ORG)).rejects.toThrow('connection terminated unexpectedly');
  });

  it('a missing key row is null', async () => {
    keyRows.push([]);
    expect(await clampToCallerCredential(keyAuth(), perms(), ORG)).toBeNull();
  });

  it('a key of another org is null', async () => {
    keyRows.push([keyRow({ orgId: OTHER_ORG })]);
    expect(await clampToCallerCredential(keyAuth(), perms(), ORG)).toBeNull();
  });

  it('a key whose scopes are null confers nothing', async () => {
    keyRows.push([keyRow({ scopes: null })]);
    const out = await clampToCallerCredential(keyAuth(), perms(), ORG);
    // An empty grant: never the creator's permissions.
    expect(out).not.toBeNull();
    expect(out!.permissions).toEqual([]);
  });

  it('a service-principal key row is null', async () => {
    keyRows.push([keyRow({ principalType: 'service' })]);
    expect(await clampToCallerCredential(keyAuth(), perms(), ORG)).toBeNull();
  });

  it('a partner service principal or an OAuth grant is null without a read', async () => {
    expect(await clampToCallerCredential(keyAuth({ partnerServicePrincipalId: 'sp' }), perms(), ORG)).toBeNull();
    expect(await clampToCallerCredential({ principal: { kind: 'oauth_grant', grantId: 'g' }, user: { id: USER } } as never, perms(), ORG)).toBeNull();
    expect(keyRows).toHaveLength(0);
  });
});
