import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const {
  getConfigPolicyMock,
  assignPolicyMock,
  unassignPolicyMock,
  listAssignmentsMock,
  listAssignmentsForTargetMock,
  validateAssignmentTargetMock,
} = vi.hoisted(() => ({
  getConfigPolicyMock: vi.fn(),
  assignPolicyMock: vi.fn(),
  unassignPolicyMock: vi.fn(),
  listAssignmentsMock: vi.fn(),
  listAssignmentsForTargetMock: vi.fn(),
  validateAssignmentTargetMock: vi.fn(),
}));

vi.mock('../../services/configurationPolicy', () => ({
  getConfigPolicy: getConfigPolicyMock,
  assignPolicy: assignPolicyMock,
  unassignPolicy: unassignPolicyMock,
  listAssignments: listAssignmentsMock,
  listAssignmentsForTarget: listAssignmentsForTargetMock,
  validateAssignmentTarget: validateAssignmentTargetMock,
}));

vi.mock('../../services/auditEvents', () => ({
  writeRouteAudit: vi.fn(),
}));

vi.mock('../../services/remoteAccessPolicy', () => ({
  invalidateRemoteAccessCache: vi.fn(),
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => next()),
  requireScope: vi.fn(() => (c: any, next: any) => next()),
  requirePermission: vi.fn(() => (c: any, next: any) => next()),
}));

import { assignmentRoutes } from './assignments';

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const POLICY_ID = '22222222-2222-2222-2222-222222222222';
const DEVICE_ID = '33333333-3333-3333-3333-333333333333';

function makeAuth(overrides: Record<string, unknown> = {}): any {
  return {
    scope: 'organization',
    orgId: ORG_ID,
    partnerId: null,
    user: { id: 'user-1', email: 'test@example.com', name: 'Test User' },
    token: { scope: 'organization' },
    accessibleOrgIds: [ORG_ID],
    canAccessOrg: (orgId: string) => orgId === ORG_ID,
    orgCondition: () => undefined,
    ...overrides,
  };
}

describe('configurationPolicies assignment routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.use('*', async (c, next) => {
      c.set('auth', makeAuth());
      await next();
    });
    app.route('/', assignmentRoutes);
  });

  it('assigns a policy when the target belongs to the policy organization', async () => {
    getConfigPolicyMock.mockResolvedValue({ id: POLICY_ID, orgId: ORG_ID, name: 'Policy 1' });
    validateAssignmentTargetMock.mockResolvedValue({ valid: true });
    assignPolicyMock.mockResolvedValue({
      id: '44444444-4444-4444-4444-444444444444',
      configPolicyId: POLICY_ID,
      level: 'device',
      targetId: DEVICE_ID,
    });

    const res = await app.request(`/${POLICY_ID}/assignments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ level: 'device', targetId: DEVICE_ID }),
    });

    expect(res.status).toBe(201);
    expect(validateAssignmentTargetMock).toHaveBeenCalledWith(ORG_ID, 'device', DEVICE_ID);
    expect(assignPolicyMock).toHaveBeenCalledWith(
      POLICY_ID,
      'device',
      DEVICE_ID,
      0,
      'user-1',
      undefined,
      undefined
    );
  });

  it('denies cross-org assignment targets before inserting the assignment', async () => {
    getConfigPolicyMock.mockResolvedValue({ id: POLICY_ID, orgId: ORG_ID, name: 'Policy 1' });
    validateAssignmentTargetMock.mockResolvedValue({
      valid: false,
      error: 'Device target not found in the policy organization',
    });

    const res = await app.request(`/${POLICY_ID}/assignments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ level: 'device', targetId: DEVICE_ID }),
    });

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({
      error: 'Device target not found in the policy organization',
    });
    expect(assignPolicyMock).not.toHaveBeenCalled();
  });
});
