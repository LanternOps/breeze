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
  // Route-level MFA stand-in, same shape as assignments.test.ts.
  // Pass-through: the route-level MFA gate is covered elsewhere. A pass-through
  // here makes the no-MFA cases prove the oem_updates gate's own MFA check.
  requireMfa: vi.fn(() => async (_c: any, next: any) => next()),
  hasSatisfiedMfa: vi.fn(() => mfaState.satisfied),
}));

import { assignmentRoutes } from './assignments';

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const POLICY_ID = '22222222-2222-2222-2222-222222222222';
const DEVICE_ID = '44444444-4444-4444-4444-444444444444';

const ARMED = {
  version: 1, enabled: true,
  schedule: { weekOfMonth: 'third', dayOfWeek: 'wed', windowStart: '01:00', windowHours: 4 },
  catchUpNights: 7, reboot: 'overnight',
  vendors: { dell: { enabled: true, categories: { driver: true }, blockedUpdateIds: [] } },
};
const OFF = { ...ARMED, enabled: false };
const oem = (inlineSettings: unknown) => ({ id: 'oem-link', featureType: 'oem_updates', inlineSettings });
const WRITE_ONLY = { permissions: [{ resource: 'devices', action: 'write' }] } as any;
const EXECUTE = { permissions: [{ resource: 'devices', action: 'execute' }] } as any;

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

const policy = (over: Record<string, unknown>) => ({
  id: POLICY_ID, orgId: ORG_ID, partnerId: null, name: 'P', parentPolicyId: null, parentPolicy: null, featureLinks: [], ...over,
});

// #11070: an assignment is how an armed vendor updates link REACHES devices, so
// assigning one is the same capability as arming it, reached through a second door.
describe('POST /:id/assignments — oem_updates gate (#11070)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mfaState.satisfied = true;
    permState.permissions = WRITE_ONLY;
    validateAssignmentTargetMock.mockResolvedValue({ valid: true });
    authorizeAssignmentTargetMock.mockResolvedValue({ valid: true });
    assignPolicyMock.mockResolvedValue({ id: 'assignment-1' });
  });

  it('assigning an armed policy needs execute', async () => {
    getConfigPolicyMock.mockResolvedValue(policy({ featureLinks: [oem(ARMED)] }));
    const res = await assign();
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'oem_updates_execute_required' });
    expect(assignPolicyMock).not.toHaveBeenCalled();
  });

  it('assigning an armed policy with execute but no MFA is refused', async () => {
    permState.permissions = EXECUTE;
    mfaState.satisfied = false;
    getConfigPolicyMock.mockResolvedValue(policy({ featureLinks: [oem(ARMED)] }));
    const res = await assign();
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'MFA_REQUIRED' });
    expect(assignPolicyMock).not.toHaveBeenCalled();
  });

  it('assigning an armed policy with execute and MFA passes', async () => {
    permState.permissions = EXECUTE;
    getConfigPolicyMock.mockResolvedValue(policy({ featureLinks: [oem(ARMED)] }));
    const res = await assign();
    expect(res.status).toBe(201);
  });

  it('assigning an unarmed one does not', async () => {
    for (const featureLinks of [[oem(OFF)], [], [{ id: 'p', featureType: 'patch', inlineSettings: {} }]]) {
      getConfigPolicyMock.mockResolvedValue(policy({ featureLinks }));
      const res = await assign();
      expect(res.status).toBe(201);
    }
  });

  it('an armed link inherited from the parent needs execute; an own disarmed override does not', async () => {
    getConfigPolicyMock.mockResolvedValue(policy({ parentPolicyId: 'parent', parentPolicy: { id: 'parent', featureLinks: [oem(ARMED)] } }));
    expect((await assign()).status).toBe(403);
    getConfigPolicyMock.mockResolvedValue(policy({ parentPolicyId: 'parent', featureLinks: [oem(OFF)], parentPolicy: { id: 'parent', featureLinks: [oem(ARMED)] } }));
    expect((await assign()).status).toBe(201);
  });

  it('unresolvable parent fails closed', async () => {
    getConfigPolicyMock.mockResolvedValue(policy({ parentPolicyId: 'parent', parentPolicy: null }));
    const res = await assign();
    expect(res.status).toBe(403);
    expect(assignPolicyMock).not.toHaveBeenCalled();
  });
});
