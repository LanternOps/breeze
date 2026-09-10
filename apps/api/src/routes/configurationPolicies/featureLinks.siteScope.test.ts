import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const {
  getConfigPolicyMock,
  addFeatureLinkMock,
  updateFeatureLinkMock,
  removeFeatureLinkMock,
  validateFeaturePolicyExistsMock,
} = vi.hoisted(() => ({
  getConfigPolicyMock: vi.fn(),
  addFeatureLinkMock: vi.fn(),
  updateFeatureLinkMock: vi.fn(),
  removeFeatureLinkMock: vi.fn(),
  validateFeaturePolicyExistsMock: vi.fn(),
}));

vi.mock('../../services/configurationPolicy', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../services/configurationPolicy')>();
  return {
    ...original,
    getConfigPolicy: getConfigPolicyMock,
    addFeatureLink: addFeatureLinkMock,
    updateFeatureLink: updateFeatureLinkMock,
    removeFeatureLink: removeFeatureLinkMock,
    validateFeaturePolicyExists: validateFeaturePolicyExistsMock,
  };
});

vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => next()),
  requireScope: vi.fn(() => (c: any, next: any) => next()),
  requirePermission: vi.fn(() => (c: any, next: any) => next()),
  requireMfa: vi.fn(() => (_c: any, next: any) => next()),
}));

import { featureLinkRoutes } from './featureLinks';

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const POLICY_ID = '22222222-2222-2222-2222-222222222222';
const LINK_ID = '33333333-3333-3333-3333-333333333333';

function makeAuth(allowedSiteIds: string[] | undefined): any {
  return {
    scope: 'organization',
    orgId: ORG_ID,
    partnerId: null,
    user: { id: 'user-1', email: 'test@example.com', name: 'Test User' },
    accessibleOrgIds: [ORG_ID],
    allowedSiteIds,
    canAccessOrg: (orgId: string) => orgId === ORG_ID,
    orgCondition: () => undefined,
  };
}

function app(auth: any) {
  const instance = new Hono();
  instance.use('*', async (c, next) => {
    c.set('auth', auth);
    await next();
  });
  instance.route('/', featureLinkRoutes);
  return instance;
}

describe('configuration policy feature links — site-ceiling gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ['restricted to one site', ['s1']],
    ['restricted to zero sites', []],
  ])('%s: POST /:id/features denied 403, no service call', async (_label, allowedSiteIds) => {
    const res = await app(makeAuth(allowedSiteIds)).request(`/${POLICY_ID}/features`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ featureType: 'patch', featurePolicyId: '44444444-4444-4444-4444-444444444444' }),
    });
    expect(res.status).toBe(403);
    expect(getConfigPolicyMock).not.toHaveBeenCalled();
    expect(addFeatureLinkMock).not.toHaveBeenCalled();
  });

  it('restricted caller: PATCH /:id/features/:linkId denied 403, no service call', async () => {
    const res = await app(makeAuth(['s1'])).request(`/${POLICY_ID}/features/${LINK_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ featurePolicyId: '44444444-4444-4444-4444-444444444444' }),
    });
    expect(res.status).toBe(403);
    expect(getConfigPolicyMock).not.toHaveBeenCalled();
    expect(updateFeatureLinkMock).not.toHaveBeenCalled();
  });

  it('restricted caller: DELETE /:id/features/:linkId denied 403, no service call', async () => {
    const res = await app(makeAuth(['s1'])).request(`/${POLICY_ID}/features/${LINK_ID}`, { method: 'DELETE' });
    expect(res.status).toBe(403);
    expect(getConfigPolicyMock).not.toHaveBeenCalled();
    expect(removeFeatureLinkMock).not.toHaveBeenCalled();
  });

  it('unrestricted caller (allowedSiteIds undefined) is unaffected: POST proceeds to lookup', async () => {
    getConfigPolicyMock.mockResolvedValue({ id: POLICY_ID, orgId: ORG_ID, partnerId: null });
    validateFeaturePolicyExistsMock.mockResolvedValue({ valid: true });
    addFeatureLinkMock.mockResolvedValue({ id: LINK_ID, configPolicyId: POLICY_ID, featureType: 'software_policy', featurePolicyId: '44444444-4444-4444-4444-444444444444' });
    const res = await app(makeAuth(undefined)).request(`/${POLICY_ID}/features`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ featureType: 'software_policy', featurePolicyId: '44444444-4444-4444-4444-444444444444' }),
    });
    expect(res.status).toBe(201);
    expect(getConfigPolicyMock).toHaveBeenCalled();
  });
});
