import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// #5511 W02 (contract D4) — the create-with-parent door. Creating a child of a
// parent whose warranty link collects HP warranty data makes that collection
// effective on the new policy immediately, so the create carries the same
// devices.execute + MFA gate as authoring the link directly.

const {
  createConfigPolicyMock,
  parentPolicyEnablesHpCmslCollectionMock,
  mfaState,
  authState,
  permState,
} = vi.hoisted(() => ({
  createConfigPolicyMock: vi.fn(),
  parentPolicyEnablesHpCmslCollectionMock: vi.fn(),
  mfaState: { satisfied: true },
  authState: { override: null as any },
  permState: { permissions: { permissions: [{ resource: '*', action: '*' }] } as any },
}));

vi.mock('../../services/configurationPolicy', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../services/configurationPolicy')>();
  return {
    ...original,
    createConfigPolicy: createConfigPolicyMock,
    parentPolicyEnablesHpCmslCollection: parentPolicyEnablesHpCmslCollectionMock,
  };
});
vi.mock('../../db', () => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn() },
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));
vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));
vi.mock('../../services/remoteAccessPolicy', () => ({ invalidateRemoteAccessCache: vi.fn() }));
vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => next()),
  requireScope: vi.fn(() => (c: any, next: any) => next()),
  requirePermission: vi.fn(() => (c: any, next: any) => next()),
  // Route-level MFA (SEC-107) stand-in; crud.test.ts exercises the real one.
  requireMfa: vi.fn(() => async (c: any, next: any) => {
    if (!mfaState.satisfied) return c.json({ error: 'MFA required', code: 'MFA_REQUIRED' }, 403);
    await next();
  }),
  hasSatisfiedMfa: vi.fn(() => mfaState.satisfied),
}));

import { crudRoutes } from './crud';

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const POLICY_ID = '22222222-2222-2222-2222-222222222222';
const PARENT_ID = '44444444-4444-4444-4444-444444444444';
const WRITE_ONLY = { permissions: [{ resource: 'devices', action: 'write' }] } as any;
const EXECUTE = { permissions: [{ resource: 'devices', action: 'execute' }] } as any;

function buildApp() {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('auth', authState.override ?? {
      scope: 'organization',
      orgId: ORG_ID,
      partnerId: null,
      user: { id: 'user-1' },
      token: { scope: 'organization', mfa: true },
      accessibleOrgIds: [ORG_ID],
      canAccessOrg: (o: string) => o === ORG_ID,
      orgCondition: () => undefined,
    } as any);
    c.set('permissions', permState.permissions);
    await next();
  });
  app.route('/', crudRoutes);
  return app;
}

function createChild(body: Record<string, unknown> = { name: 'Child', parentPolicyId: PARENT_ID }) {
  return buildApp().request('/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST / — hpCmsl create-with-parent gate (#5511 W02 D4)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mfaState.satisfied = true;
    authState.override = null;
    permState.permissions = { permissions: [{ resource: '*', action: '*' }] } as any;
    createConfigPolicyMock.mockResolvedValue({ id: POLICY_ID, name: 'Child', orgId: ORG_ID, parentPolicyId: PARENT_ID });
    parentPolicyEnablesHpCmslCollectionMock.mockResolvedValue(false);
  });

  it('refuses a devices.write-only caller creating a child of a collecting parent', async () => {
    permState.permissions = WRITE_ONLY;
    parentPolicyEnablesHpCmslCollectionMock.mockResolvedValue(true);

    const res = await createChild();

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'HP_CMSL_EXECUTE_REQUIRED' });
    expect(parentPolicyEnablesHpCmslCollectionMock).toHaveBeenCalledWith(PARENT_ID);
    expect(createConfigPolicyMock).not.toHaveBeenCalled();
  });

  it('refuses without MFA even with devices.execute', async () => {
    permState.permissions = EXECUTE;
    mfaState.satisfied = false;
    parentPolicyEnablesHpCmslCollectionMock.mockResolvedValue(true);

    const res = await createChild();

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'MFA_REQUIRED' });
    expect(createConfigPolicyMock).not.toHaveBeenCalled();
  });

  it('allows a devices.execute caller with MFA', async () => {
    permState.permissions = EXECUTE;
    parentPolicyEnablesHpCmslCollectionMock.mockResolvedValue(true);

    const res = await createChild();

    expect(res.status).toBe(201);
    expect(createConfigPolicyMock).toHaveBeenCalled();
  });

  it('does not gate a child of a parent that does not collect', async () => {
    permState.permissions = WRITE_ONLY;

    const res = await createChild();

    expect(res.status).toBe(201);
    expect(createConfigPolicyMock).toHaveBeenCalled();
  });

  it('gates a PARTNER-WIDE child of a collecting parent too (gate runs before the ownership branch)', async () => {
    permState.permissions = WRITE_ONLY;
    authState.override = {
      scope: 'partner',
      orgId: null,
      partnerId: 'partner-1',
      user: { id: 'user-1' },
      token: { scope: 'partner', mfa: true },
      accessibleOrgIds: [ORG_ID],
      canAccessOrg: () => true,
      orgCondition: () => undefined,
    };
    parentPolicyEnablesHpCmslCollectionMock.mockResolvedValue(true);

    const res = await createChild({ name: 'Child', ownerScope: 'partner', parentPolicyId: PARENT_ID });

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'HP_CMSL_EXECUTE_REQUIRED' });
    expect(createConfigPolicyMock).not.toHaveBeenCalled();
  });

  it('does not consult the parent at all for a root policy', async () => {
    permState.permissions = WRITE_ONLY;

    const res = await createChild({ name: 'Root' });

    expect(res.status).toBe(201);
    expect(parentPolicyEnablesHpCmslCollectionMock).not.toHaveBeenCalled();
  });
});
