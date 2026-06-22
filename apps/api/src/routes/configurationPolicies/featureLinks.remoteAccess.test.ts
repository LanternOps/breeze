import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// Hoist mock values so they're available in vi.mock factories
const {
  getConfigPolicyMock,
  addFeatureLinkMock,
  updateFeatureLinkMock,
  validateFeaturePolicyExistsMock,
} = vi.hoisted(() => ({
  getConfigPolicyMock: vi.fn(),
  addFeatureLinkMock: vi.fn(),
  updateFeatureLinkMock: vi.fn(),
  validateFeaturePolicyExistsMock: vi.fn(),
}));

vi.mock('../../services/configurationPolicy', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../services/configurationPolicy')>();
  return {
    ...original,
    getConfigPolicy: getConfigPolicyMock,
    addFeatureLink: addFeatureLinkMock,
    updateFeatureLink: updateFeatureLinkMock,
    removeFeatureLink: vi.fn(),
    listFeatureLinks: vi.fn(),
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
const LINK_ID = '44444444-4444-4444-4444-444444444444';

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

const STUB_POLICY_WITH_REMOTE_ACCESS_LINK = {
  ...STUB_POLICY,
  featureLinks: [{ id: LINK_ID, featureType: 'remote_access' }],
};

describe('featureLinks routes — remote_access inlineSettings validation', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = buildApp();
  });

  // ============================================================
  // POST /:id/features — remote_access inlineSettings validation
  // ============================================================

  describe('POST /:id/features — remote_access inlineSettings validation', () => {
    beforeEach(() => {
      getConfigPolicyMock.mockResolvedValue(STUB_POLICY);
      validateFeaturePolicyExistsMock.mockResolvedValue({ valid: true });
      addFeatureLinkMock.mockResolvedValue({ id: LINK_ID, featureType: 'remote_access' });
    });

    it('rejects remote_access inlineSettings with invalid sessionPromptMode → 400', async () => {
      const res = await app.request(`/${POLICY_ID}/features`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          featureType: 'remote_access',
          inlineSettings: { sessionPromptMode: 'nope' },
        }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toMatch(/remote access/i);
      expect(addFeatureLinkMock).not.toHaveBeenCalled();
    });

    it('rejects remote_access inlineSettings with invalid consentUnavailableBehavior → 400', async () => {
      const res = await app.request(`/${POLICY_ID}/features`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          featureType: 'remote_access',
          inlineSettings: { consentUnavailableBehavior: 'invalid_value' },
        }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toMatch(/remote access/i);
      expect(addFeatureLinkMock).not.toHaveBeenCalled();
    });

    it('rejects remote_access inlineSettings with notifyOnSessionEnd as string "true" → 400', async () => {
      const res = await app.request(`/${POLICY_ID}/features`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          featureType: 'remote_access',
          inlineSettings: { notifyOnSessionEnd: 'true' },
        }),
      });

      expect(res.status).toBe(400);
      expect(addFeatureLinkMock).not.toHaveBeenCalled();
    });

    it('accepts remote_access inlineSettings with sessionPromptMode: "consent" → 201', async () => {
      const res = await app.request(`/${POLICY_ID}/features`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          featureType: 'remote_access',
          inlineSettings: { sessionPromptMode: 'consent' },
        }),
      });

      expect(res.status).toBe(201);
      expect(addFeatureLinkMock).toHaveBeenCalled();
    });

    it('accepts remote_access inlineSettings with all valid fields → 201', async () => {
      const res = await app.request(`/${POLICY_ID}/features`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          featureType: 'remote_access',
          inlineSettings: {
            sessionPromptMode: 'notify',
            consentUnavailableBehavior: 'block',
            notifyOnSessionEnd: false,
            showActiveIndicator: false,
            technicianIdentityLevel: 'name',
          },
        }),
      });

      expect(res.status).toBe(201);
      expect(addFeatureLinkMock).toHaveBeenCalled();
    });

    it('accepts remote_access inlineSettings: {} (all defaults) → 201', async () => {
      const res = await app.request(`/${POLICY_ID}/features`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          featureType: 'remote_access',
          inlineSettings: {},
        }),
      });

      expect(res.status).toBe(201);
      expect(addFeatureLinkMock).toHaveBeenCalled();
    });
  });

  // ============================================================
  // PATCH /:id/features/:linkId — remote_access inlineSettings validation
  // ============================================================

  describe('PATCH /:id/features/:linkId — remote_access inlineSettings validation', () => {
    beforeEach(() => {
      getConfigPolicyMock.mockResolvedValue(STUB_POLICY_WITH_REMOTE_ACCESS_LINK);
      updateFeatureLinkMock.mockResolvedValue({ id: LINK_ID, featureType: 'remote_access' });
    });

    it('rejects update remote_access inlineSettings with invalid sessionPromptMode → 400', async () => {
      const res = await app.request(`/${POLICY_ID}/features/${LINK_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          inlineSettings: { sessionPromptMode: 'nope' },
        }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toMatch(/remote access/i);
      expect(updateFeatureLinkMock).not.toHaveBeenCalled();
    });

    it('accepts update remote_access inlineSettings with sessionPromptMode: "off" → 200', async () => {
      const res = await app.request(`/${POLICY_ID}/features/${LINK_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          inlineSettings: { sessionPromptMode: 'off' },
        }),
      });

      expect(res.status).toBe(200);
      expect(updateFeatureLinkMock).toHaveBeenCalled();
    });

    it('accepts update remote_access inlineSettings with technicianIdentityLevel: "generic" → 200', async () => {
      const res = await app.request(`/${POLICY_ID}/features/${LINK_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          inlineSettings: { technicianIdentityLevel: 'generic' },
        }),
      });

      expect(res.status).toBe(200);
      expect(updateFeatureLinkMock).toHaveBeenCalled();
    });
  });
});
