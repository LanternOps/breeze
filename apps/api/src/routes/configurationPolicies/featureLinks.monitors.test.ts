import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// Hoist mock values so they're available in vi.mock factories
const {
  getConfigPolicyMock,
  addFeatureLinkMock,
  updateFeatureLinkMock,
  validateFeaturePolicyExistsMock,
  getMonitorDefinitionMock,
  isMonitorAttachableToPolicyMock,
} = vi.hoisted(() => ({
  getConfigPolicyMock: vi.fn(),
  addFeatureLinkMock: vi.fn(),
  updateFeatureLinkMock: vi.fn(),
  validateFeaturePolicyExistsMock: vi.fn(),
  getMonitorDefinitionMock: vi.fn(),
  isMonitorAttachableToPolicyMock: vi.fn(),
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

// The route imports getMonitorDefinition directly from monitorService — NOT
// through the configurationPolicy service barrel — to check visibility of
// each monitorId before ever calling addFeatureLink/updateFeatureLink.
vi.mock('../../services/monitors/monitorAttachability', () => ({
  isMonitorAttachableToPolicy: isMonitorAttachableToPolicyMock,
}));

vi.mock('../../services/monitors/monitorService', () => ({
  getMonitorDefinition: getMonitorDefinitionMock,
}));

vi.mock('../../services/auditEvents', () => ({
  writeRouteAudit: vi.fn(),
  // See featureLinks.siteScope.test.ts for why this export is required now
  // that the route imports services/monitors/monitorService, which
  // transitively loads routes/agentWs -> services/commandResultHandlers ->
  // customFields/scriptWriteBack (calls requestLikeFromSnapshot at import
  // time).
  requestLikeFromSnapshot: vi.fn(() => ({ req: { header: () => undefined } })),
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => next()),
  requireScope: vi.fn(() => (c: any, next: any) => next()),
  requirePermission: vi.fn(() => (c: any, next: any) => next()),
  requireMfa: vi.fn(() => (_c: any, next: any) => next()),
}));

import { featureLinkRoutes } from './featureLinks';

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const POLICY_ID = '22222222-2222-2222-2222-222222222222';
const LINK_ID = '44444444-4444-4444-4444-444444444444';
const MONITOR_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

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

const STUB_POLICY_WITH_MONITORS_LINK = {
  ...STUB_POLICY,
  featureLinks: [{ id: LINK_ID, featureType: 'monitors' }],
};

describe('featureLinks routes — monitors inlineSettings validation (#5289 Task 7)', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = buildApp();
  });

  describe('POST /:id/features — monitors', () => {
    beforeEach(() => {
      getConfigPolicyMock.mockResolvedValue(STUB_POLICY);
      validateFeaturePolicyExistsMock.mockResolvedValue({ valid: true });
      addFeatureLinkMock.mockResolvedValue({ id: LINK_ID, featureType: 'monitors' });
    });

    it('accepts a monitorId visible to the caller → 201', async () => {
      getMonitorDefinitionMock.mockResolvedValue({ id: MONITOR_ID, kind: 'cpu' });
      isMonitorAttachableToPolicyMock.mockResolvedValue(true);

      const res = await app.request(`/${POLICY_ID}/features`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          featureType: 'monitors',
          inlineSettings: { items: [{ monitorId: MONITOR_ID, enabled: true }] },
        }),
      });

      expect(res.status).toBe(201);
      expect(getMonitorDefinitionMock).toHaveBeenCalledWith(MONITOR_ID, expect.anything());
      expect(addFeatureLinkMock).toHaveBeenCalled();
    });

    it('rejects a monitorId the auth cannot see → 400 Unknown monitorId', async () => {
      getMonitorDefinitionMock.mockResolvedValue(null);

      const res = await app.request(`/${POLICY_ID}/features`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          featureType: 'monitors',
          inlineSettings: { items: [{ monitorId: MONITOR_ID }] },
        }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toBe('Unknown monitorId');
      expect(addFeatureLinkMock).not.toHaveBeenCalled();
    });

    it('rejects malformed monitors inlineSettings (non-uuid monitorId) → 400', async () => {
      const res = await app.request(`/${POLICY_ID}/features`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          featureType: 'monitors',
          inlineSettings: { items: [{ monitorId: 'not-a-uuid' }] },
        }),
      });

      expect(res.status).toBe(400);
      expect(getMonitorDefinitionMock).not.toHaveBeenCalled();
      expect(addFeatureLinkMock).not.toHaveBeenCalled();
    });

    it('refuses an incompatible monitor with 400 MONITOR_NOT_ATTACHABLE BEFORE writing', async () => {
      // The database's own guard is a DEFERRABLE INITIALLY DEFERRED trigger, so
      // it only fires at the request transaction's COMMIT — after this handler
      // has returned. The compatibility check therefore has to happen here,
      // before the write, and this test pins that it does: addFeatureLink must
      // never be called for an incompatible pair.
      getMonitorDefinitionMock.mockResolvedValue({ id: MONITOR_ID, kind: 'cpu' });
      isMonitorAttachableToPolicyMock.mockResolvedValue(false);

      const res = await app.request(`/${POLICY_ID}/features`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          featureType: 'monitors',
          inlineSettings: { items: [{ monitorId: MONITOR_ID }] },
        }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toBe('MONITOR_NOT_ATTACHABLE');
    });

    it('rejects a featurePolicyId on a monitors link — inline-only feature type', async () => {
      validateFeaturePolicyExistsMock.mockResolvedValue({
        valid: false,
        error: 'monitors feature type does not support featurePolicyId; use inlineSettings instead',
      });

      const res = await app.request(`/${POLICY_ID}/features`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          featureType: 'monitors',
          featurePolicyId: '99999999-9999-4999-8999-999999999999',
        }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toMatch(/does not support featurePolicyId/);
      expect(addFeatureLinkMock).not.toHaveBeenCalled();
    });
  });

  describe('PATCH /:id/features/:linkId — monitors', () => {
    beforeEach(() => {
      getConfigPolicyMock.mockResolvedValue(STUB_POLICY_WITH_MONITORS_LINK);
      updateFeatureLinkMock.mockResolvedValue({ id: LINK_ID, featureType: 'monitors' });
    });

    it('accepts a monitorId visible to the caller → 200', async () => {
      getMonitorDefinitionMock.mockResolvedValue({ id: MONITOR_ID, kind: 'cpu' });
      isMonitorAttachableToPolicyMock.mockResolvedValue(true);

      const res = await app.request(`/${POLICY_ID}/features/${LINK_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          inlineSettings: { items: [{ monitorId: MONITOR_ID, enabled: false }] },
        }),
      });

      expect(res.status).toBe(200);
      expect(updateFeatureLinkMock).toHaveBeenCalled();
    });

    it('rejects a monitorId the auth cannot see → 400 Unknown monitorId', async () => {
      getMonitorDefinitionMock.mockResolvedValue(null);

      const res = await app.request(`/${POLICY_ID}/features/${LINK_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          inlineSettings: { items: [{ monitorId: MONITOR_ID }] },
        }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toBe('Unknown monitorId');
      expect(updateFeatureLinkMock).not.toHaveBeenCalled();
    });

    it('refuses an incompatible monitor with 400 MONITOR_NOT_ATTACHABLE BEFORE writing', async () => {
      // See the POST case: the DB guard is deferred, so this must be a
      // pre-check, not a caught constraint violation.
      getMonitorDefinitionMock.mockResolvedValue({ id: MONITOR_ID, kind: 'cpu' });
      isMonitorAttachableToPolicyMock.mockResolvedValue(false);

      const res = await app.request(`/${POLICY_ID}/features/${LINK_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          inlineSettings: { items: [{ monitorId: MONITOR_ID }] },
        }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toBe('MONITOR_NOT_ATTACHABLE');
      expect(updateFeatureLinkMock).not.toHaveBeenCalled();
    });
  });
});
