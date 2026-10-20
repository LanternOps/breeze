import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbState = vi.hoisted(() => ({ results: [] as unknown[][] }));
vi.mock('../../db', () => {
  const chain = () => {
    const c: Record<string, unknown> = {};
    c.from = () => c;
    c.where = () => c;
    c.limit = async () => dbState.results.shift() ?? [];
    return c;
  };
  return { db: { select: () => chain() } };
});

import { callerAction, CALLER_GATED_TOOLS, loadPinnedCallerBackend, requireResolvedOid } from './callerTarget';

const ORG = '11111111-1111-4111-8111-111111111111';
const CONN = '22222222-2222-4222-8222-222222222222';
const TENANT = '33333333-3333-4333-8333-333333333333';

describe('canonical caller targets', () => {
  it('gates exactly the two protected tools', () => {
    expect(callerAction('m365_reset_password')).toBe('reset_password');
    expect(callerAction('m365_disable_user')).toBe('disable_user');
    for (const name of ['m365_lookup_user', 'm365_revoke_sessions', 'm365_create_user', 'google_reset_password', '']) {
      expect(callerAction(name)).toBeNull();
    }
    expect([...CALLER_GATED_TOOLS].sort()).toEqual(['m365_disable_user', 'm365_reset_password']);
  });

  it('never falls back to a UPN when Graph omitted or garbled the id', () => {
    expect(() => requireResolvedOid({ userPrincipalName: 'person@example.com' })).toThrow();
    expect(() => requireResolvedOid({ id: 'person@example.com' })).toThrow();
    expect(() => requireResolvedOid(null)).toThrow();
    expect(requireResolvedOid({ id: 'AAAAAAAA-1111-4111-8111-111111111111' })).toBe('aaaaaaaa-1111-4111-8111-111111111111');
  });
});

describe('loadPinnedCallerBackend', () => {
  beforeEach(() => { dbState.results = []; });

  it('maps legacy-direct and customer-graph-actions rows', async () => {
    dbState.results.push([{ id: CONN, orgId: ORG, status: 'active', tenantId: TENANT.toUpperCase(), profile: 'legacy-direct' }]);
    await expect(loadPinnedCallerBackend(ORG, CONN)).resolves.toEqual({ backend: 'direct', connectionId: CONN, tenantId: TENANT, orgId: ORG });
    dbState.results.push([{ id: CONN, orgId: ORG, status: 'active', tenantId: TENANT, profile: 'customer-graph-actions' }]);
    await expect(loadPinnedCallerBackend(ORG, CONN)).resolves.toMatchObject({ backend: 'controlPlane' });
  });

  it('refuses an inactive, tenantless or read-only m365 row without falling through to Delegant', async () => {
    for (const row of [
      { status: 'degraded', tenantId: TENANT, profile: 'legacy-direct' },
      { status: 'active', tenantId: null, profile: 'customer-graph-actions' },
      { status: 'active', tenantId: TENANT, profile: 'customer-graph-read' },
    ]) {
      dbState.results.push([{ id: CONN, orgId: ORG, ...row }]);
      await expect(loadPinnedCallerBackend(ORG, CONN)).rejects.toMatchObject({ code: 'connection_not_ready' });
    }
  });

  it('resolves an active Delegant connection and refuses an inactive one', async () => {
    dbState.results.push([], [{ id: CONN, orgId: ORG, status: 'active', tenantId: TENANT }]);
    await expect(loadPinnedCallerBackend(ORG, CONN)).resolves.toEqual({ backend: 'delegant', connectionId: CONN, tenantId: TENANT, orgId: ORG });
    dbState.results.push([], [{ id: CONN, orgId: ORG, status: 'revoked', tenantId: TENANT }]);
    await expect(loadPinnedCallerBackend(ORG, CONN)).rejects.toMatchObject({ code: 'connection_not_ready' });
  });

  it('refuses a non-uuid reference before any query', async () => {
    await expect(loadPinnedCallerBackend(ORG, 'not-a-uuid')).rejects.toMatchObject({ code: 'connection_not_ready' });
  });
});
