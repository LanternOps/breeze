import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({
  db: { select: vi.fn() },
}));
vi.mock('./permissions', () => ({
  getUserPermissions: vi.fn(),
}));
vi.mock('./resilienceSiteAuthorization', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./resilienceSiteAuthorization')>();
  return { ...actual, authorizeResilienceResources: vi.fn() };
});

import { db } from '../db';
import { getUserPermissions } from './permissions';
import {
  ResilienceAuthorizationError,
  authorizeResilienceResources,
} from './resilienceSiteAuthorization';
import {
  RESTORE_CROSS_ORG_ERROR,
  RESTORE_TARGET_DENIED_ERROR,
  authorizeAiRestore,
  resolveAiCallerPermissions,
} from './aiToolsRestoreAuthorization';
import type { AuthContext } from '../middleware/auth';

const ORG_A = '11111111-1111-1111-1111-111111111111';
const ORG_B = '22222222-2222-2222-2222-222222222222';
const SNAPSHOT = { id: 'snap-1', orgId: ORG_A };

function targetDeviceIs(rows: Array<{ orgId: string }>) {
  vi.mocked(db.select).mockReturnValue({
    from: () => ({ where: () => ({ limit: () => Promise.resolve(rows) }) }),
  } as any);
}

function partnerAuth(kind: 'user_session' | 'ai_agent' = 'user_session', allowedSiteIds?: string[]): AuthContext {
  return {
    principal: { kind },
    user: { id: 'user-1', email: 'a@b.c', name: 'A', isPlatformAdmin: false },
    token: {} as any,
    partnerId: 'partner-1',
    orgId: null,
    scope: 'partner',
    accessibleOrgIds: [ORG_A, ORG_B],
    orgCondition: () => undefined,
    canAccessOrg: () => true,
    allowedSiteIds,
  } as unknown as AuthContext;
}

const GRANT = {
  permissions: [{ resource: 'backup', action: 'cross_site_restore' }],
  partnerId: 'partner-1', orgId: null, roleId: 'role-1', scope: 'partner' as const,
};

describe('authorizeAiRestore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getUserPermissions).mockResolvedValue(GRANT as any);
    vi.mocked(authorizeResilienceResources).mockResolvedValue({ resources: [] });
  });

  it('refuses a target device in a different org than the snapshot, before any RBAC lookup', async () => {
    targetDeviceIs([{ orgId: ORG_B }]);
    const result = await authorizeAiRestore(partnerAuth(), { snapshot: SNAPSHOT, targetDeviceId: 'dev-b' });
    expect(result).toEqual({ ok: false, error: RESTORE_CROSS_ORG_ERROR, code: 'cross_org_restore_denied' });
    expect(authorizeResilienceResources).not.toHaveBeenCalled();
  });

  it('refuses a target device the caller cannot see', async () => {
    targetDeviceIs([]);
    const result = await authorizeAiRestore(partnerAuth(), { snapshot: SNAPSHOT, targetDeviceId: 'dev-x' });
    expect(result).toEqual({ ok: false, error: RESTORE_TARGET_DENIED_ERROR });
  });

  it("authorizes the pair in the SNAPSHOT's org as a restore, with the caller's live grant", async () => {
    targetDeviceIs([{ orgId: ORG_A }]);
    const result = await authorizeAiRestore(partnerAuth(), { snapshot: SNAPSHOT, targetDeviceId: 'dev-a' });

    expect(result).toEqual({ ok: true });
    expect(getUserPermissions).toHaveBeenCalledWith('user-1', { partnerId: 'partner-1', orgId: undefined, scope: 'partner' });
    expect(authorizeResilienceResources).toHaveBeenCalledWith({
      orgId: ORG_A,
      principal: { kind: 'user_session', permissions: GRANT },
      refs: [
        { kind: 'snapshot', id: 'snap-1', role: 'source' },
        { kind: 'device', id: 'dev-a', role: 'target' },
      ],
      operation: 'restore',
    });
  });

  it('maps the resolver site denial (e.g. missing backup:cross_site_restore) to site_access_denied', async () => {
    targetDeviceIs([{ orgId: ORG_A }]);
    vi.mocked(authorizeResilienceResources).mockRejectedValue(new ResilienceAuthorizationError(403, 'site_access_denied'));
    const result = await authorizeAiRestore(partnerAuth(), { snapshot: SNAPSHOT, targetDeviceId: 'dev-a2' });
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ code: 'site_access_denied' });
    expect((result as { error: string }).error).toMatch(/^site_access_denied: .*backup:cross_site_restore/);
  });

  it('rethrows anything that is not an authorization denial', async () => {
    targetDeviceIs([{ orgId: ORG_A }]);
    vi.mocked(authorizeResilienceResources).mockRejectedValue(new Error('db down'));
    await expect(authorizeAiRestore(partnerAuth(), { snapshot: SNAPSHOT, targetDeviceId: 'dev-a' })).rejects.toThrow('db down');
  });
});

describe('resolveAiCallerPermissions', () => {
  beforeEach(() => vi.clearAllMocks());

  it('never grants an AI agent principal user permissions', async () => {
    const perms = await resolveAiCallerPermissions(partnerAuth('ai_agent', ['site-1']));
    expect(getUserPermissions).not.toHaveBeenCalled();
    expect(perms.permissions).toEqual([]);
    expect(perms.allowedSiteIds).toEqual(['site-1']);
  });

  it('falls back to an empty grant (fail closed) when no role resolves', async () => {
    vi.mocked(getUserPermissions).mockResolvedValue(null);
    const perms = await resolveAiCallerPermissions(partnerAuth());
    expect(perms.permissions).toEqual([]);
  });
});
