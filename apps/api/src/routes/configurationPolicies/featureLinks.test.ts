import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { onedriveHelperInlineSettingsSchema } from '@breeze/shared/validators';

// Hoist mock values so they're available in vi.mock factories
const {
  getConfigPolicyMock,
  addFeatureLinkMock,
  updateFeatureLinkMock,
  removeFeatureLinkMock,
  listFeatureLinksMock,
  validateFeaturePolicyExistsMock,
  isBackupProfileReferenceMock,
} = vi.hoisted(() => ({
  getConfigPolicyMock: vi.fn(),
  addFeatureLinkMock: vi.fn(),
  updateFeatureLinkMock: vi.fn(),
  removeFeatureLinkMock: vi.fn(),
  listFeatureLinksMock: vi.fn(),
  validateFeaturePolicyExistsMock: vi.fn(),
  isBackupProfileReferenceMock: vi.fn(),
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
    isBackupProfileReference: isBackupProfileReferenceMock,
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
      isBackupProfileReferenceMock.mockResolvedValue(false);
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

    it('returns 409 (not 500) when the feature type is already linked to this policy', async () => {
      // addFeatureLink uses .onConflictDoNothing().returning() rather than
      // raising a 23505: withDbAccessContext wraps the request in a postgres.js
      // transaction that re-throws the original error at commit time even
      // after it's caught, turning a mapped 409 back into a raw 500 (see
      // createCatalogItem in catalogService.ts). A null return from the
      // mocked service is how the route detects the duplicate feature link.
      addFeatureLinkMock.mockResolvedValue(null);
      const res = await app.request(`/${POLICY_ID}/features`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          featureType: 'pam',
          inlineSettings: {},
        }),
      });

      expect(res.status).toBe(409);
      await expect(res.json()).resolves.toEqual({
        error: 'Feature type "pam" already linked to this policy',
      });
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

  describe('feature link reserved export material validation', () => {
    it.each([
      'security', 'software_policy', 'peripheral_control',
      'warranty', 'helper', 'vulnerability',
    ] as const)('rejects nested reserved material on POST for %s before service work', async (featureType) => {
      const res = await app.request(`/${POLICY_ID}/features`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          featureType,
          inlineSettings: {
            nested: { __breezePatchInlineMirror: 'attacker-value' },
          },
        }),
      });

      expect(res.status).toBe(400);
      expect(addFeatureLinkMock).not.toHaveBeenCalled();
      expect(await res.text()).not.toMatch(/__breezePatchInlineMirror|attacker-value/u);
    });

    it('rejects nested reserved material on PATCH before service work', async () => {
      const res = await app.request(`/${POLICY_ID}/features/${LINK_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          inlineSettings: {
            nested: [{ __breezePatchInlineMirror: 'attacker-value' }],
          },
        }),
      });

      expect(res.status).toBe(400);
      expect(updateFeatureLinkMock).not.toHaveBeenCalled();
      expect(await res.text()).not.toMatch(/__breezePatchInlineMirror|attacker-value/u);
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

    // onedrive_helper is in ORG_SCOPED_ONLY_FEATURES and is covered by its
    // own test below. patch is deliberately NOT rejected: rings are
    // partner-axis and the scheduler groups by device org (#1724 follow-up).
    it('accepts the backup feature on a partner-owned policy (profiles, spec 2026-07-13)', async () => {
      // backup left ORG_SCOPED_ONLY_FEATURE_TYPES with the profiles model:
      // settings are dual-axis and partner-wide links resolve each device
      // org's default destination at job time.
      addFeatureLinkMock.mockResolvedValue({ id: LINK_ID, featureType: 'backup' });
      const res = await app.request(`/${POLICY_ID}/features`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          featureType: 'backup',
          inlineSettings: { backupMode: 'file', targets: { paths: ['C:\\Data'] } },
        }),
      });

      expect(res.status).toBe(201);
      expect(addFeatureLinkMock).toHaveBeenCalled();
    });

    it('rejects the onedrive_helper feature on a partner-owned policy → 400 via ORG_SCOPED_ONLY_FEATURES (no insert)', async () => {
      // onedrive_helper carries a concrete org_id FK (library mappings are
      // org-owned), so it's in ORG_SCOPED_ONLY_FEATURE_TYPES alongside backup —
      // this must 400 through the same partner-wide gate, before ever reaching
      // the onedrive_helper inlineSettings schema validation.
      const res = await app.request(`/${POLICY_ID}/features`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ featureType: 'onedrive_helper', inlineSettings: {} }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(String(body.error)).toContain('not supported on partner-wide policies');
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

    it('ALLOWS linking a partner-owned SOFTWARE POLICY template on a partner-owned policy → 201 (#2126)', async () => {
      validateFeaturePolicyExistsMock.mockResolvedValue({ valid: true });
      addFeatureLinkMock.mockResolvedValue({ id: LINK_ID, featureType: 'software_policy' });
      const res = await app.request(`/${POLICY_ID}/features`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          featureType: 'software_policy',
          featurePolicyId: '55555555-5555-4555-8555-555555555555',
        }),
      });

      expect(res.status).toBe(201);
      expect(validateFeaturePolicyExistsMock).toHaveBeenCalledWith(
        'software_policy',
        '55555555-5555-4555-8555-555555555555',
        expect.objectContaining({ orgId: null, partnerId: PARTNER_POLICY.partnerId })
      );
      expect(addFeatureLinkMock).toHaveBeenCalled();
    });

    it('ALLOWS linking a partner-owned SECURITY policy template on a partner-owned policy → 201 (#2127)', async () => {
      validateFeaturePolicyExistsMock.mockResolvedValue({ valid: true });
      addFeatureLinkMock.mockResolvedValue({ id: LINK_ID, featureType: 'security' });
      const res = await app.request(`/${POLICY_ID}/features`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          featureType: 'security',
          featurePolicyId: '66666666-6666-4666-8666-666666666666',
        }),
      });

      expect(res.status).toBe(201);
      expect(validateFeaturePolicyExistsMock).toHaveBeenCalledWith(
        'security',
        '66666666-6666-4666-8666-666666666666',
        expect.objectContaining({ orgId: null, partnerId: PARTNER_POLICY.partnerId })
      );
    });

    it('allows linking a partner-wide backup profile on a partner-owned policy (spec 2026-07-13)', async () => {
      // backup graduated to PARTNER_LINKABLE with the profiles model —
      // featurePolicyId references a dual-ownership backup_profiles row and
      // validateFeaturePolicyExists enforces the ownership axes.
      isBackupProfileReferenceMock.mockResolvedValue(true);
      addFeatureLinkMock.mockResolvedValue({ id: LINK_ID, featureType: 'backup' });
      const res = await app.request(`/${POLICY_ID}/features`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          featureType: 'backup',
          featurePolicyId: '44444444-4444-4444-4444-444444444444',
          inlineSettings: { schedule: { frequency: 'daily', time: '03:00' } },
        }),
      });

      expect(res.status).toBe(201);
      expect(addFeatureLinkMock).toHaveBeenCalled();
      expect(validateFeaturePolicyExistsMock).toHaveBeenCalled();
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
  // POST/PATCH — onedrive_helper inlineSettings validation
  // ============================================================

  describe('onedrive_helper inline settings validation', () => {
    beforeEach(() => {
      getConfigPolicyMock.mockResolvedValue(STUB_POLICY);
      validateFeaturePolicyExistsMock.mockResolvedValue({ valid: true });
      addFeatureLinkMock.mockResolvedValue({ id: LINK_ID, featureType: 'onedrive_helper' });
    });

    it('POST rejects invalid onedrive settings with 400', async () => {
      const res = await app.request(`/${POLICY_ID}/features`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          featureType: 'onedrive_helper',
          inlineSettings: {
            libraries: [{ libraryId: 'x', displayName: 'X', targetingMode: 'graph_group' }], // no groupId/groupName
          },
        }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toBe('Invalid onedrive_helper settings');
      expect(addFeatureLinkMock).not.toHaveBeenCalled();
    });

    it('POST accepts valid onedrive settings (defaults applied)', async () => {
      const rawInlineSettings = {
        libraries: [{ libraryId: 'lib-1', displayName: 'Docs', targetingMode: 'everyone' }],
      };
      const res = await app.request(`/${POLICY_ID}/features`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          featureType: 'onedrive_helper',
          inlineSettings: rawInlineSettings,
        }),
      });

      expect(res.status).toBe(201);
      expect(addFeatureLinkMock).toHaveBeenCalledTimes(1);

      // Schema-derive the expected (defaulted) shape rather than hand-encoding
      // every field, so this can't silently drift from
      // onedriveHelperInlineSettingsSchema. Sanity-check the specific defaults
      // the finding called out, then assert the route actually reassigns
      // `data.inlineSettings = parsed.data` before calling addFeatureLink —
      // this fails if that reassignment is removed, since the raw request body
      // (no defaults filled in) would be passed instead.
      const expectedSettings = onedriveHelperInlineSettingsSchema.parse(rawInlineSettings);
      expect(expectedSettings.silentAccountConfig).toBe(true);
      expect(expectedSettings.filesOnDemand).toBe(true);
      expect(expectedSettings.restartOnChange).toBe(true);
      expect(expectedSettings.libraries[0]).toMatchObject({ hiveScope: 'hkcu', enabled: true });

      const [, , , inlineSettingsArg] = addFeatureLinkMock.mock.calls[0]!;
      expect(inlineSettingsArg).toEqual(expectedSettings);
    });

    it('PATCH rejects invalid onedrive settings with 400', async () => {
      getConfigPolicyMock.mockResolvedValue({
        ...STUB_POLICY,
        featureLinks: [{ id: LINK_ID, featureType: 'onedrive_helper' }],
      });
      const res = await app.request(`/${POLICY_ID}/features/${LINK_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          inlineSettings: { kfmFolders: ['Downloads'] },
        }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toBe('Invalid onedrive_helper settings');
      expect(updateFeatureLinkMock).not.toHaveBeenCalled();
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
