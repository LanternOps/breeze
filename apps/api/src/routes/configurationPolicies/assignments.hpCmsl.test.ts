import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const {
  getConfigPolicyMock,
  assignPolicyMock,
  validateAssignmentTargetMock,
  authorizeAssignmentTargetMock,
  mfaState,
  permState,
} = vi.hoisted(() => ({
  getConfigPolicyMock: vi.fn(),
  assignPolicyMock: vi.fn(),
  validateAssignmentTargetMock: vi.fn(),
  authorizeAssignmentTargetMock: vi.fn(),
  mfaState: { satisfied: true },
  permState: { permissions: { permissions: [{ resource: '*', action: '*' }] } as any },
}));

vi.mock('../../services/configurationPolicy', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../services/configurationPolicy')>();
  return {
    ...original,
    getConfigPolicy: getConfigPolicyMock,
    assignPolicy: assignPolicyMock,
    unassignPolicy: vi.fn(),
    listAssignments: vi.fn(),
    listAssignmentsForTarget: vi.fn(),
    validateAssignmentTarget: validateAssignmentTargetMock,
    authorizeAssignmentTarget: authorizeAssignmentTargetMock,
    getAssignment: vi.fn(),
  };
});
vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));
vi.mock('../../services/remoteAccessPolicy', () => ({ invalidateRemoteAccessCache: vi.fn() }));
vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => next()),
  requireScope: vi.fn(() => (c: any, next: any) => next()),
  requirePermission: vi.fn(() => (c: any, next: any) => next()),
  // Route-level MFA (SEC-107) stand-in, same shape as assignments.test.ts.
  requireMfa: vi.fn(() => async (c: any, next: any) => {
    if (!mfaState.satisfied) return c.json({ error: 'MFA required', code: 'MFA_REQUIRED' }, 403);
    await next();
  }),
  hasSatisfiedMfa: vi.fn(() => mfaState.satisfied),
}));

import { assignmentRoutes } from './assignments';
import { HP_CMSL_EULA_ID } from '@breeze/shared/validators';

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const POLICY_ID = '22222222-2222-2222-2222-222222222222';
const DEVICE_ID = '44444444-4444-4444-4444-444444444444';

const CONSENT = {
  acceptedByUserId: 'user-1',
  acceptedAt: '2026-09-10T00:00:00.000Z',
  eulaId: HP_CMSL_EULA_ID,
};
const COLLECTING_LINK = {
  id: 'link-1',
  featureType: 'warranty',
  inlineSettings: { hpCmsl: { enabled: true, consent: CONSENT } },
};

function buildApp() {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('auth', {
      scope: 'organization',
      orgId: ORG_ID,
      partnerId: null,
      user: { id: 'user-1' },
      token: { scope: 'organization' },
      accessibleOrgIds: [ORG_ID],
      canAccessOrg: (o: string) => o === ORG_ID,
    } as any);
    c.set('permissions', permState.permissions);
    await next();
  });
  app.route('/', assignmentRoutes);
  return app;
}

function assign() {
  return buildApp().request(`/${POLICY_ID}/assignments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ level: 'device', targetId: DEVICE_ID }),
  });
}

describe('POST /:id/assignments — hpCmsl gate (#5511 W02 D4)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mfaState.satisfied = true;
    permState.permissions = { permissions: [{ resource: '*', action: '*' }] } as any;
    validateAssignmentTargetMock.mockResolvedValue({ valid: true });
    authorizeAssignmentTargetMock.mockResolvedValue({ valid: true });
    assignPolicyMock.mockResolvedValue({ id: 'assignment-1' });
  });

  it('refuses a devices.write-only caller assigning a policy that collects', async () => {
    permState.permissions = { permissions: [{ resource: 'devices', action: 'write' }] } as any;
    getConfigPolicyMock.mockResolvedValue({
      id: POLICY_ID, orgId: ORG_ID, partnerId: null, name: 'P',
      featureLinks: [COLLECTING_LINK], parentPolicy: null,
    });

    const res = await assign();

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'HP_CMSL_EXECUTE_REQUIRED' });
    expect(assignPolicyMock).not.toHaveBeenCalled();
  });

  it('refuses an execute-capable caller without MFA', async () => {
    permState.permissions = { permissions: [{ resource: 'devices', action: 'execute' }] } as any;
    mfaState.satisfied = false;
    getConfigPolicyMock.mockResolvedValue({
      id: POLICY_ID, orgId: ORG_ID, partnerId: null, name: 'P',
      featureLinks: [COLLECTING_LINK], parentPolicy: null,
    });

    const res = await assign();

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'MFA_REQUIRED' });
    expect(assignPolicyMock).not.toHaveBeenCalled();
  });

  it('allows a devices.execute caller with MFA to assign a policy that collects', async () => {
    permState.permissions = { permissions: [{ resource: 'devices', action: 'execute' }] } as any;
    getConfigPolicyMock.mockResolvedValue({
      id: POLICY_ID, orgId: ORG_ID, partnerId: null, name: 'P',
      featureLinks: [COLLECTING_LINK], parentPolicy: null,
    });

    const res = await assign();

    expect(res.status).toBe(201);
    expect(assignPolicyMock).toHaveBeenCalled();
  });

  it('refuses when the parent is set but could not be resolved (fail closed)', async () => {
    permState.permissions = { permissions: [{ resource: 'devices', action: 'write' }] } as any;
    getConfigPolicyMock.mockResolvedValue({
      id: POLICY_ID, orgId: ORG_ID, partnerId: null, name: 'P',
      parentPolicyId: 'parent', parentPolicy: null,
      featureLinks: [],
    });

    const res = await assign();

    expect(res.status).toBe(403);
    expect(assignPolicyMock).not.toHaveBeenCalled();
  });

  it('refuses when the collecting link is INHERITED from the parent', async () => {
    permState.permissions = { permissions: [{ resource: 'devices', action: 'write' }] } as any;
    getConfigPolicyMock.mockResolvedValue({
      id: POLICY_ID, orgId: ORG_ID, partnerId: null, name: 'P',
      featureLinks: [],
      parentPolicy: { id: 'parent', featureLinks: [COLLECTING_LINK] },
    });

    const res = await assign();

    expect(res.status).toBe(403);
    expect(assignPolicyMock).not.toHaveBeenCalled();
  });

  it('does NOT refuse when the policy overrides the parent with collection off', async () => {
    permState.permissions = { permissions: [{ resource: 'devices', action: 'write' }] } as any;
    getConfigPolicyMock.mockResolvedValue({
      id: POLICY_ID, orgId: ORG_ID, partnerId: null, name: 'P',
      featureLinks: [{ id: 'own', featureType: 'warranty', inlineSettings: { hpCmsl: { enabled: false } } }],
      parentPolicy: { id: 'parent', featureLinks: [COLLECTING_LINK] },
    });

    const res = await assign();

    expect(res.status).toBe(201);
    expect(assignPolicyMock).toHaveBeenCalled();
  });

  it('does not gate an ordinary assignment of a policy with no warranty link', async () => {
    permState.permissions = { permissions: [{ resource: 'devices', action: 'write' }] } as any;
    getConfigPolicyMock.mockResolvedValue({
      id: POLICY_ID, orgId: ORG_ID, partnerId: null, name: 'P',
      featureLinks: [{ id: 'p', featureType: 'patch', inlineSettings: {} }],
      parentPolicy: null,
    });

    const res = await assign();

    expect(res.status).toBe(201);
  });
});
