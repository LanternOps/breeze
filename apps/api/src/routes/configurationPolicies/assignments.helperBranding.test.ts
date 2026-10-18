import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const {
  getConfigPolicyMock,
  assignPolicyMock,
  validateAssignmentTargetMock,
  authorizeAssignmentTargetMock,
  canManagePartnerWideMock,
} = vi.hoisted(() => ({
  getConfigPolicyMock: vi.fn(),
  assignPolicyMock: vi.fn(),
  validateAssignmentTargetMock: vi.fn(),
  authorizeAssignmentTargetMock: vi.fn(),
  canManagePartnerWideMock: vi.fn(),
}));

vi.mock('../../services/configurationPolicy', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../services/configurationPolicy')>();
  return {
    ...original,
    getConfigPolicy: getConfigPolicyMock,
    assignPolicy: assignPolicyMock,
    validateAssignmentTarget: validateAssignmentTargetMock,
    authorizeAssignmentTarget: authorizeAssignmentTargetMock,
    canManagePartnerWidePolicies: canManagePartnerWideMock,
  };
});

vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));
vi.mock('../../services/remoteAccessPolicy', () => ({ invalidateRemoteAccessCache: vi.fn() }));
vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => next()),
  requireScope: vi.fn(() => (c: any, next: any) => next()),
  requirePermission: vi.fn(() => (c: any, next: any) => next()),
  requireMfa: vi.fn(() => (c: any, next: any) => next()),
}));

import { assignmentRoutes } from './assignments';

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const POLICY_ID = '22222222-2222-2222-2222-222222222222';
const SITE_ID = '44444444-4444-4444-4444-444444444444';
const BRANDED_HELPER = { featureType: 'helper', inlineSettings: { enabled: true, branding: { displayName: 'Example Assist' } } };

const auth = {
  scope: 'organization',
  orgId: ORG_ID,
  partnerId: null,
  user: { id: 'user-1', email: 'test@example.com', name: 'Test User' },
  token: { scope: 'organization' },
  accessibleOrgIds: [ORG_ID],
  canAccessOrg: (orgId: string) => orgId === ORG_ID,
  orgCondition: () => undefined,
};

function buildApp() {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('auth', auth);
    await next();
  });
  app.route('/', assignmentRoutes);
  return app;
}

function policy(featureLinks: unknown[]) {
  return { id: POLICY_ID, orgId: ORG_ID, partnerId: null, name: 'Policy', featureLinks };
}

async function assign(level: string, targetId: string) {
  return buildApp().request(`/${POLICY_ID}/assignments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ level, targetId }),
  });
}

describe('helper branding write guard on assignments', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authorizeAssignmentTargetMock.mockResolvedValue({ valid: true });
    validateAssignmentTargetMock.mockResolvedValue({ valid: true });
    assignPolicyMock.mockResolvedValue({ id: 'aid', level: 'site', targetId: SITE_ID });
    canManagePartnerWideMock.mockReturnValue(true);
  });

  it('rejects a site assignment (409) when the policy already carries helper branding', async () => {
    getConfigPolicyMock.mockResolvedValue(policy([BRANDED_HELPER]));
    const res = await assign('site', SITE_ID);
    expect(res.status).toBe(409);
    expect(assignPolicyMock).not.toHaveBeenCalled();
  });

  it.each(['device_group', 'device'])('rejects a %s assignment (409) when the policy carries branding', async (level) => {
    getConfigPolicyMock.mockResolvedValue(policy([BRANDED_HELPER]));
    const res = await assign(level, SITE_ID);
    expect(res.status).toBe(409);
    expect(assignPolicyMock).not.toHaveBeenCalled();
  });

  it('allows a site assignment when the helper link has no branding', async () => {
    getConfigPolicyMock.mockResolvedValue(policy([{ featureType: 'helper', inlineSettings: { enabled: true } }]));
    const res = await assign('site', SITE_ID);
    expect(res.status).not.toBe(409);
    expect(assignPolicyMock).toHaveBeenCalled();
  });

  it('allows an organization assignment when the policy carries branding', async () => {
    getConfigPolicyMock.mockResolvedValue(policy([BRANDED_HELPER]));
    const res = await assign('organization', ORG_ID);
    expect(res.status).not.toBe(409);
    expect(assignPolicyMock).toHaveBeenCalled();
  });
});
