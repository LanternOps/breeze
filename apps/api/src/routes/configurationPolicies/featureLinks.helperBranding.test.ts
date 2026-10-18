import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const {
  getConfigPolicyMock,
  addFeatureLinkMock,
  updateFeatureLinkMock,
  listFeatureLinksMock,
  listAssignmentsMock,
  validateFeaturePolicyExistsMock,
} = vi.hoisted(() => ({
  getConfigPolicyMock: vi.fn(),
  addFeatureLinkMock: vi.fn(),
  updateFeatureLinkMock: vi.fn(),
  listFeatureLinksMock: vi.fn(),
  listAssignmentsMock: vi.fn(),
  validateFeaturePolicyExistsMock: vi.fn(),
}));

vi.mock('../../services/configurationPolicy', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../services/configurationPolicy')>();
  return {
    ...original,
    getConfigPolicy: getConfigPolicyMock,
    addFeatureLink: addFeatureLinkMock,
    updateFeatureLink: updateFeatureLinkMock,
    listFeatureLinks: listFeatureLinksMock,
    listAssignments: listAssignmentsMock,
    validateFeaturePolicyExists: validateFeaturePolicyExistsMock,
  };
});

vi.mock('../../services/auditEvents', () => ({
  writeRouteAudit: vi.fn(),
  requestLikeFromSnapshot: vi.fn(() => ({ req: { header: () => undefined } })),
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => next()),
  requireScope: vi.fn(() => (c: any, next: any) => next()),
  requirePermission: vi.fn(() => (c: any, next: any) => next()),
  requireMfa: vi.fn(() => (c: any, next: any) => next()),
  hasSatisfiedMfa: vi.fn(() => true),
}));

import { featureLinkRoutes } from './featureLinks';

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const POLICY_ID = '22222222-2222-2222-2222-222222222222';
const LINK_ID = '33333333-3333-3333-3333-333333333333';
const BRANDED = { displayName: 'Example Assist', primaryColor: '#2255AA' };

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
    c.set('permissions', { permissions: [{ resource: '*', action: '*' }] });
    await next();
  });
  app.route('/', featureLinkRoutes);
  return app;
}

function policy(featureLinks: unknown[] = []) {
  return { id: POLICY_ID, orgId: ORG_ID, partnerId: null, name: 'Policy', featureLinks };
}

async function post(inlineSettings: unknown) {
  return buildApp().request(`/${POLICY_ID}/features`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ featureType: 'helper', inlineSettings }),
  });
}

async function patch(inlineSettings: unknown) {
  return buildApp().request(`/${POLICY_ID}/features/${LINK_ID}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ inlineSettings }),
  });
}

describe('helper branding write guards on feature links', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getConfigPolicyMock.mockResolvedValue(policy());
    listFeatureLinksMock.mockResolvedValue([]);
    validateFeaturePolicyExistsMock.mockResolvedValue(true);
    addFeatureLinkMock.mockResolvedValue({ id: LINK_ID, featureType: 'helper' });
    updateFeatureLinkMock.mockResolvedValue({ id: LINK_ID, featureType: 'helper' });
  });

  it('POST rejects branding on a policy with a site assignment (409) and writes nothing', async () => {
    listAssignmentsMock.mockResolvedValue([{ level: 'site' }]);
    const res = await post({ enabled: true, branding: BRANDED });
    expect(res.status).toBe(409);
    expect(addFeatureLinkMock).not.toHaveBeenCalled();
  });

  it('POST rejects invalid branding with 400 and the validation details', async () => {
    listAssignmentsMock.mockResolvedValue([{ level: 'organization' }]);
    const res = await post({ branding: { displayName: 'x'.repeat(61) } });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ details: ['length:displayName'] });
    expect(addFeatureLinkMock).not.toHaveBeenCalled();
  });

  it('POST allows clearing branding even with a device assignment', async () => {
    listAssignmentsMock.mockResolvedValue([{ level: 'device' }]);
    const res = await post({ enabled: true, branding: {} });
    expect(res.status).not.toBe(409);
    expect(res.status).not.toBe(400);
  });

  it('POST allows valid branding on a partner/organization-only policy', async () => {
    listAssignmentsMock.mockResolvedValue([{ level: 'organization' }, { level: 'partner' }]);
    const res = await post({ enabled: true, branding: BRANDED });
    expect(res.status).not.toBe(409);
    expect(res.status).not.toBe(400);
  });

  it('POST does not touch branding when the inline settings carry no branding key', async () => {
    listAssignmentsMock.mockResolvedValue([{ level: 'device' }]);
    const res = await post({ enabled: true });
    expect(res.status).not.toBe(409);
    expect(listAssignmentsMock).not.toHaveBeenCalled();
  });

  it('PATCH rejects branding on a policy with a device assignment (409) and writes nothing', async () => {
    getConfigPolicyMock.mockResolvedValue(policy([{ id: LINK_ID, featureType: 'helper' }]));
    listAssignmentsMock.mockResolvedValue([{ level: 'device_group' }]);
    const res = await patch({ enabled: true, branding: BRANDED });
    expect(res.status).toBe(409);
    expect(updateFeatureLinkMock).not.toHaveBeenCalled();
  });

  it('PATCH rejects invalid branding with 400', async () => {
    getConfigPolicyMock.mockResolvedValue(policy([{ id: LINK_ID, featureType: 'helper' }]));
    listAssignmentsMock.mockResolvedValue([]);
    const res = await patch({ branding: { primaryColor: 'red' } });
    expect(res.status).toBe(400);
    expect(updateFeatureLinkMock).not.toHaveBeenCalled();
  });
});
