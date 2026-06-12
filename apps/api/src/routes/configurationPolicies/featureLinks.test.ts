import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// Hoist mock values so they're available in vi.mock factories
const {
  getConfigPolicyMock,
  addFeatureLinkMock,
  updateFeatureLinkMock,
  removeFeatureLinkMock,
  listFeatureLinksMock,
  validateFeaturePolicyExistsMock,
} = vi.hoisted(() => ({
  getConfigPolicyMock: vi.fn(),
  addFeatureLinkMock: vi.fn(),
  updateFeatureLinkMock: vi.fn(),
  removeFeatureLinkMock: vi.fn(),
  listFeatureLinksMock: vi.fn(),
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
    listFeatureLinks: listFeatureLinksMock,
    validateFeaturePolicyExists: validateFeaturePolicyExistsMock,
  };
});

vi.mock('../../services/auditEvents', () => ({
  writeRouteAudit: vi.fn(),
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => next()),
  requireScope: vi.fn(() => (c: any, next: any) => next()),
  requirePermission: vi.fn(() => (c: any, next: any) => next()),
  hasSatisfiedMfa: vi.fn(() => true),
}));

import { featureLinkRoutes } from './featureLinks';

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const POLICY_ID = '22222222-2222-2222-2222-222222222222';
const LINK_ID = '33333333-3333-3333-3333-333333333333';

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

function buildApp() {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('auth', makeAuth());
    await next();
  });
  app.route('/', featureLinkRoutes);
  return app;
}

const STUB_POLICY = {
  id: POLICY_ID,
  orgId: ORG_ID,
  name: 'Test Policy',
  featureLinks: [],
};

const STUB_POLICY_WITH_PATCH_LINK = {
  ...STUB_POLICY,
  featureLinks: [{ id: LINK_ID, featureType: 'patch' }],
};

const STUB_POLICY_WITH_PAM_LINK = {
  ...STUB_POLICY,
  featureLinks: [{ id: LINK_ID, featureType: 'pam' }],
};

describe('featureLinks routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = buildApp();
  });

  // ============================================================
  // POST /:id/features — pam inlineSettings validation (Fix A)
  // ============================================================

  describe('POST /:id/features — pam inlineSettings validation', () => {
    beforeEach(() => {
      getConfigPolicyMock.mockResolvedValue(STUB_POLICY);
      validateFeaturePolicyExistsMock.mockResolvedValue({ valid: true });
      addFeatureLinkMock.mockResolvedValue({ id: LINK_ID, featureType: 'pam' });
    });

    it('rejects pam inlineSettings with uacInterceptionEnabled as string "false" → 400', async () => {
      const res = await app.request(`/${POLICY_ID}/features`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          featureType: 'pam',
          inlineSettings: { uacInterceptionEnabled: 'false' },
        }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toMatch(/pam/i);
      // Must name the field
      const details = body.details as any;
      expect(details?.fieldErrors?.uacInterceptionEnabled ?? body.issues).toBeTruthy();
      expect(addFeatureLinkMock).not.toHaveBeenCalled();
    });

    it('rejects pam inlineSettings with uacInterceptionEnabled as number 0 → 400', async () => {
      const res = await app.request(`/${POLICY_ID}/features`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          featureType: 'pam',
          inlineSettings: { uacInterceptionEnabled: 0 },
        }),
      });

      expect(res.status).toBe(400);
      expect(addFeatureLinkMock).not.toHaveBeenCalled();
    });

    it('accepts pam inlineSettings with uacInterceptionEnabled: false (boolean) → 201', async () => {
      const res = await app.request(`/${POLICY_ID}/features`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          featureType: 'pam',
          inlineSettings: { uacInterceptionEnabled: false },
        }),
      });

      expect(res.status).toBe(201);
      expect(addFeatureLinkMock).toHaveBeenCalled();
    });

    it('accepts pam inlineSettings: {} (omitted key treated as default) → 201', async () => {
      const res = await app.request(`/${POLICY_ID}/features`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          featureType: 'pam',
          inlineSettings: {},
        }),
      });

      expect(res.status).toBe(201);
      expect(addFeatureLinkMock).toHaveBeenCalled();
    });

    it('accepts pam link with only featurePolicyId (no inlineSettings) → 201', async () => {
      // addFeatureLinkSchema requires at least one of featurePolicyId or inlineSettings;
      // providing featurePolicyId alone skips the pam inlineSettings validation branch.
      validateFeaturePolicyExistsMock.mockResolvedValue({ valid: true });
      const res = await app.request(`/${POLICY_ID}/features`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          featureType: 'pam',
          featurePolicyId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        }),
      });

      expect(res.status).toBe(201);
      expect(addFeatureLinkMock).toHaveBeenCalled();
    });

    it('rejects pam inlineSettings with unknown extra key (strict passthrough behavior)', async () => {
      const res = await app.request(`/${POLICY_ID}/features`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          featureType: 'pam',
          inlineSettings: { uacInterceptionEnabled: true, unknownKey: 'extra' },
        }),
      });

      // strict() rejects unknown keys → 400
      expect(res.status).toBe(400);
      expect(addFeatureLinkMock).not.toHaveBeenCalled();
    });
  });

  // ============================================================
  // PATCH /:id/features/:linkId — pam inlineSettings validation (Fix A)
  // ============================================================

  describe('PATCH /:id/features/:linkId — pam inlineSettings validation', () => {
    beforeEach(() => {
      getConfigPolicyMock.mockResolvedValue(STUB_POLICY_WITH_PAM_LINK);
      updateFeatureLinkMock.mockResolvedValue({ id: LINK_ID, featureType: 'pam' });
    });

    it('rejects update pam inlineSettings with uacInterceptionEnabled as string "false" → 400', async () => {
      const res = await app.request(`/${POLICY_ID}/features/${LINK_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          inlineSettings: { uacInterceptionEnabled: 'false' },
        }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toMatch(/pam/i);
      expect(updateFeatureLinkMock).not.toHaveBeenCalled();
    });

    it('accepts update pam inlineSettings with uacInterceptionEnabled: true (boolean) → 200', async () => {
      const res = await app.request(`/${POLICY_ID}/features/${LINK_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          inlineSettings: { uacInterceptionEnabled: true },
        }),
      });

      expect(res.status).toBe(200);
      expect(updateFeatureLinkMock).toHaveBeenCalled();
    });
  });

  // ============================================================
  // Sanity: patch feature type validation still works
  // ============================================================

  describe('POST /:id/features — patch inlineSettings validation (regression guard)', () => {
    beforeEach(() => {
      getConfigPolicyMock.mockResolvedValue(STUB_POLICY);
      addFeatureLinkMock.mockResolvedValue({ id: LINK_ID, featureType: 'patch' });
    });

    it('rejects patch inlineSettings with invalid scheduleTime → 400', async () => {
      const res = await app.request(`/${POLICY_ID}/features`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          featureType: 'patch',
          inlineSettings: { scheduleTime: '99:99' },
        }),
      });

      expect(res.status).toBe(400);
      expect(addFeatureLinkMock).not.toHaveBeenCalled();
    });
  });
});
