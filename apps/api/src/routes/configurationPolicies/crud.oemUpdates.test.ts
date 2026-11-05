import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// #11070 — two more vendor updates doors: creating a child of a parent whose
// oem_updates link is armed, and setting status active on a policy whose link
// in effect is armed. Both make arming effective, so both need devices.execute + MFA.

const {
  createConfigPolicyMock,
  parentPolicyArmsOemUpdatesMock,
  getConfigPolicyMock,
  updateConfigPolicyMock,
  mfaState,
  authState,
  permState,
} = vi.hoisted(() => ({
  createConfigPolicyMock: vi.fn(),
  parentPolicyArmsOemUpdatesMock: vi.fn(),
  getConfigPolicyMock: vi.fn(),
  updateConfigPolicyMock: vi.fn(),
  mfaState: { satisfied: true },
  authState: { override: null as any },
  permState: { permissions: { permissions: [{ resource: '*', action: '*' }] } as any },
}));

vi.mock('../../services/configurationPolicy', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../services/configurationPolicy')>();
  return {
    ...original,
    createConfigPolicy: createConfigPolicyMock,
    parentPolicyEnablesHpCmslCollection: vi.fn(async () => false),
    parentPolicyArmsOemUpdates: parentPolicyArmsOemUpdatesMock,
    getConfigPolicy: getConfigPolicyMock,
    updateConfigPolicy: updateConfigPolicyMock,
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
  // Route-level MFA stand-in; crud.test.ts exercises the real one.
  // Pass-through: the route-level MFA gate is covered elsewhere. A pass-through
  // here makes the no-MFA cases prove the oem_updates gate's own MFA check.
  requireMfa: vi.fn(() => async (_c: any, next: any) => next()),
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

const ARMED = {
  version: 1, enabled: true,
  schedule: { weekOfMonth: 'third', dayOfWeek: 'wed', windowStart: '01:00', windowHours: 4 },
  catchUpNights: 7, reboot: 'overnight',
  vendors: { dell: { enabled: true, categories: { driver: true }, blockedUpdateIds: [] } },
};
const oem = (inlineSettings: unknown) => ({ id: 'oem-link', featureType: 'oem_updates', inlineSettings });

function createChild(body: Record<string, unknown> = { name: 'Child', parentPolicyId: PARENT_ID }) {
  return buildApp().request('/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function patchPolicy(body: Record<string, unknown>) {
  return buildApp().request(`/${POLICY_ID}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const stored = (over: Record<string, unknown>) => ({
  id: POLICY_ID, orgId: ORG_ID, partnerId: null, name: 'P', status: 'inactive',
  parentPolicyId: null, parentPolicy: null, featureLinks: [], ...over,
});

describe('POST / — oem_updates create-with-parent gate (#11070)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mfaState.satisfied = true;
    authState.override = null;
    permState.permissions = WRITE_ONLY;
    createConfigPolicyMock.mockResolvedValue({ id: POLICY_ID, name: 'Child', orgId: ORG_ID, parentPolicyId: PARENT_ID });
  });

  it('creating a child of an armed parent needs execute', async () => {
    parentPolicyArmsOemUpdatesMock.mockResolvedValue(true);
    const res = await createChild();
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'oem_updates_execute_required' });
    expect(parentPolicyArmsOemUpdatesMock).toHaveBeenCalledWith(PARENT_ID);
    expect(createConfigPolicyMock).not.toHaveBeenCalled();
  });

  it('creating a child of an armed parent with execute but no MFA is refused by the gate itself', async () => {
    permState.permissions = EXECUTE;
    mfaState.satisfied = false;
    parentPolicyArmsOemUpdatesMock.mockResolvedValue(true);
    const res = await createChild();
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'MFA_REQUIRED' });
    expect(createConfigPolicyMock).not.toHaveBeenCalled();
  });

  it('creating a child of an armed parent with execute and MFA passes', async () => {
    permState.permissions = EXECUTE;
    parentPolicyArmsOemUpdatesMock.mockResolvedValue(true);
    const res = await createChild();
    expect(res.status).toBe(201);
  });

  it('creating a child of an unarmed parent, or with no parent, needs only devices.write', async () => {
    parentPolicyArmsOemUpdatesMock.mockResolvedValue(false);
    expect((await createChild()).status).toBe(201);
    expect((await createChild({ name: 'Root' })).status).toBe(201);
  });
});

describe('PATCH /:id — oem_updates activation gate (#11070)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mfaState.satisfied = true;
    authState.override = null;
    permState.permissions = WRITE_ONLY;
    updateConfigPolicyMock.mockResolvedValue({ id: POLICY_ID, name: 'P', orgId: ORG_ID, status: 'active' });
  });

  it('setting status active on an armed policy needs execute', async () => {
    getConfigPolicyMock.mockResolvedValue(stored({ featureLinks: [oem(ARMED)] }));
    const res = await patchPolicy({ status: 'active' });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'oem_updates_execute_required' });
    expect(updateConfigPolicyMock).not.toHaveBeenCalled();
  });

  it('an armed link inherited from the parent counts; an unresolvable parent fails closed', async () => {
    getConfigPolicyMock.mockResolvedValue(stored({ parentPolicyId: PARENT_ID, parentPolicy: { id: PARENT_ID, featureLinks: [oem(ARMED)] } }));
    expect((await patchPolicy({ status: 'active' })).status).toBe(403);
    getConfigPolicyMock.mockResolvedValue(stored({ parentPolicyId: PARENT_ID, parentPolicy: null }));
    expect((await patchPolicy({ status: 'active' })).status).toBe(403);
    expect(updateConfigPolicyMock).not.toHaveBeenCalled();
  });

  it('activating an armed policy with execute but no MFA is refused by the gate itself', async () => {
    permState.permissions = EXECUTE;
    mfaState.satisfied = false;
    getConfigPolicyMock.mockResolvedValue(stored({ featureLinks: [oem(ARMED)] }));
    const res = await patchPolicy({ status: 'active' });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'MFA_REQUIRED' });
    expect(updateConfigPolicyMock).not.toHaveBeenCalled();
  });

  it('with execute and MFA the activation goes through', async () => {
    permState.permissions = EXECUTE;
    getConfigPolicyMock.mockResolvedValue(stored({ featureLinks: [oem(ARMED)] }));
    expect((await patchPolicy({ status: 'active' })).status).toBe(200);
  });

  it('activating an unarmed policy, re-saving an already active one, deactivating or renaming is not gated', async () => {
    getConfigPolicyMock.mockResolvedValue(stored({ featureLinks: [] }));
    expect((await patchPolicy({ status: 'active' })).status).toBe(200);
    getConfigPolicyMock.mockResolvedValue(stored({ status: 'active', featureLinks: [oem(ARMED)] }));
    expect((await patchPolicy({ status: 'active' })).status).toBe(200);
    expect((await patchPolicy({ status: 'inactive' })).status).toBe(200);
    expect((await patchPolicy({ name: 'Renamed' })).status).toBe(200);
  });

  it('a policy the caller cannot read is left to updateConfigPolicy (404)', async () => {
    getConfigPolicyMock.mockResolvedValue(null);
    updateConfigPolicyMock.mockResolvedValue(null);
    expect((await patchPolicy({ status: 'active' })).status).toBe(404);
  });
});
