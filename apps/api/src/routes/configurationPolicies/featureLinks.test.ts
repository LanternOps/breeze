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

  // ============================================================
  // POST /:id/features — org-scoped features rejected on partner-wide (#1724)
  // ============================================================
  describe('POST /:id/features — org-scoped features rejected on partner-wide policy', () => {
    const PARTNER_POLICY = {
      id: POLICY_ID,
      orgId: null,
      partnerId: '99999999-9999-9999-9999-999999999999',
      name: 'Partner-wide',
      featureLinks: [],
    };

    beforeEach(() => {
      getConfigPolicyMock.mockResolvedValue(PARTNER_POLICY);
      addFeatureLinkMock.mockResolvedValue({ id: LINK_ID, featureType: 'backup' });
      // Writes on a partner-wide policy require the partner-wide capability —
      // rebuild the app with a full-partner-admin auth so the tests below
      // exercise the per-feature-type behavior, not the capability gate.
      app = new Hono();
      app.use('*', async (c, next) => {
        c.set('auth', makeAuth({
          scope: 'partner',
          orgId: null,
          partnerId: PARTNER_POLICY.partnerId,
          partnerOrgAccess: 'all',
        }));
        await next();
      });
      app.route('/', featureLinkRoutes);
    });

    it('denies ANY feature-link write on a partner-wide policy without full partner org access → 403', async () => {
      // A 'selected'-access partner user can SEE the partner-wide policy but
      // must not edit its feature links (all-orgs blast radius, same rationale
      // as the create/assign guards).
      const appSelected = new Hono();
      appSelected.use('*', async (c, next) => {
        c.set('auth', makeAuth({
          scope: 'partner',
          orgId: null,
          partnerId: PARTNER_POLICY.partnerId,
          partnerOrgAccess: 'selected',
        }));
        await next();
      });
      appSelected.route('/', featureLinkRoutes);

      const res = await appSelected.request(`/${POLICY_ID}/features`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ featureType: 'patch', inlineSettings: { scheduleTime: '02:00' } }),
      });

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(String(body.error)).toMatch(/full partner org access/);
      expect(addFeatureLinkMock).not.toHaveBeenCalled();
    });

    it('denies feature-link DELETE on a partner-wide policy without full partner org access → 403', async () => {
      getConfigPolicyMock.mockResolvedValue({
        ...PARTNER_POLICY,
        featureLinks: [{ id: LINK_ID, featureType: 'patch' }],
      });
      const appSelected = new Hono();
      appSelected.use('*', async (c, next) => {
        c.set('auth', makeAuth({
          scope: 'partner',
          orgId: null,
          partnerId: PARTNER_POLICY.partnerId,
          partnerOrgAccess: 'selected',
        }));
        await next();
      });
      appSelected.route('/', featureLinkRoutes);

      const res = await appSelected.request(`/${POLICY_ID}/features/${LINK_ID}`, { method: 'DELETE' });

      expect(res.status).toBe(403);
      expect(removeFeatureLinkMock).not.toHaveBeenCalled();
    });

    // onedrive_helper is also in ORG_SCOPED_ONLY_FEATURES but isn't accepted by
    // addFeatureLinkSchema's enum, so it can't reach the route at all — only
    // backup is exercisable here. patch is deliberately NOT rejected: rings are
    // partner-axis and the scheduler groups by device org (#1724 follow-up).
    it('rejects the backup feature on a partner-owned policy → 400 (no insert)', async () => {
      const res = await app.request(`/${POLICY_ID}/features`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Valid body (passes the schema refine) so we exercise the
        // partner-wide guard, not the generic validator.
        body: JSON.stringify({ featureType: 'backup', inlineSettings: { enabled: true } }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(String(body.error)).toContain('partner-wide');
      expect(addFeatureLinkMock).not.toHaveBeenCalled();
    });

    it('ALLOWS the patch feature on a partner-owned policy → 201 (rings are partner-axis)', async () => {
      addFeatureLinkMock.mockResolvedValue({ id: LINK_ID, featureType: 'patch' });
      const res = await app.request(`/${POLICY_ID}/features`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Minimal valid patch inline settings (defaults fill the rest).
        body: JSON.stringify({ featureType: 'patch', inlineSettings: { scheduleTime: '02:00' } }),
      });

      expect(res.status).toBe(201);
      expect(addFeatureLinkMock).toHaveBeenCalled();
    });

    it('ALLOWS linking a patch update ring (featurePolicyId) on a partner-owned policy → 201', async () => {
      validateFeaturePolicyExistsMock.mockResolvedValue({ valid: true });
      addFeatureLinkMock.mockResolvedValue({ id: LINK_ID, featureType: 'patch' });
      const res = await app.request(`/${POLICY_ID}/features`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          featureType: 'patch',
          featurePolicyId: '44444444-4444-4444-4444-444444444444',
          inlineSettings: { scheduleTime: '02:00' },
        }),
      });

      expect(res.status).toBe(201);
      // Validation must receive the policy's partnerId so it resolves the
      // partner-axis ring without an owning org.
      expect(validateFeaturePolicyExistsMock).toHaveBeenCalledWith(
        'patch',
        '44444444-4444-4444-4444-444444444444',
        expect.objectContaining({ orgId: null, partnerId: PARTNER_POLICY.partnerId })
      );
      expect(addFeatureLinkMock).toHaveBeenCalled();
    });

    it('still rejects linking an org-scoped feature policy (non-patch) on a partner-owned policy → 400', async () => {
      const res = await app.request(`/${POLICY_ID}/features`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          featureType: 'security',
          featurePolicyId: '44444444-4444-4444-4444-444444444444',
        }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(String(body.error)).toContain('partner-owned');
      expect(addFeatureLinkMock).not.toHaveBeenCalled();
    });

    it('still allows an org-derived feature (security) on a partner-owned policy', async () => {
      addFeatureLinkMock.mockResolvedValue({ id: LINK_ID, featureType: 'security' });
      const res = await app.request(`/${POLICY_ID}/features`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ featureType: 'security', inlineSettings: { enabled: true } }),
      });

      expect(res.status).toBe(201);
      expect(addFeatureLinkMock).toHaveBeenCalled();
    });
  });

  // ============================================================
  // alert_rule offline-duration cap vs the re-eval horizon (issue #1982)
  // ============================================================

  describe('alert_rule offline-duration validation (issue #1982)', () => {
    beforeEach(() => {
      validateFeaturePolicyExistsMock.mockResolvedValue({ valid: true });
      addFeatureLinkMock.mockResolvedValue({ id: LINK_ID, featureType: 'alert_rule' });
      updateFeatureLinkMock.mockResolvedValue({ id: LINK_ID, featureType: 'alert_rule' });
    });

    it('POST rejects an offline rule whose duration exceeds the horizon → 400', async () => {
      getConfigPolicyMock.mockResolvedValue(STUB_POLICY);
      const res = await app.request(`/${POLICY_ID}/features`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          featureType: 'alert_rule',
          inlineSettings: { items: [{ name: 'Weekly offline', conditions: { type: 'offline', durationMinutes: 10080 } }] },
        }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as Record<string, unknown>;
      expect(String(body.error)).toContain('1440');
      expect(addFeatureLinkMock).not.toHaveBeenCalled();
    });

    it('POST accepts an offline rule within the horizon → 201', async () => {
      getConfigPolicyMock.mockResolvedValue(STUB_POLICY);
      const res = await app.request(`/${POLICY_ID}/features`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          featureType: 'alert_rule',
          inlineSettings: { items: [{ name: 'Offline 1h', conditions: { type: 'offline', durationMinutes: 60 } }] },
        }),
      });

      expect(res.status).toBe(201);
      expect(addFeatureLinkMock).toHaveBeenCalled();
    });

    it('PATCH rejects updating an alert_rule link to an oversized offline duration → 400', async () => {
      getConfigPolicyMock.mockResolvedValue({
        ...STUB_POLICY,
        featureLinks: [{ id: LINK_ID, featureType: 'alert_rule' }],
      });
      const res = await app.request(`/${POLICY_ID}/features/${LINK_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          inlineSettings: { items: [{ name: 'Too long', conditions: { type: 'offline', durationMinutes: 4320 } }] },
        }),
      });

      expect(res.status).toBe(400);
      expect(updateFeatureLinkMock).not.toHaveBeenCalled();
    });
  });
});
