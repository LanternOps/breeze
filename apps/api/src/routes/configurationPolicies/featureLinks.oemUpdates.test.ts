import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

/**
 * Vendor updates (`oem_updates`, #11070): arming through the feature-link doors.
 * Arming (policy on, a category newly true, overnight reboot on, a blocked ID
 * removed) needs devices:execute + MFA; narrowing needs only devices:write.
 * A category whose availability gate is closed cannot be stored true.
 */
const {
  getConfigPolicyMock,
  addFeatureLinkMock,
  updateFeatureLinkMock,
  removeFeatureLinkMock,
  state,
  gates,
} = vi.hoisted(() => ({
  getConfigPolicyMock: vi.fn(),
  addFeatureLinkMock: vi.fn(),
  updateFeatureLinkMock: vi.fn(),
  removeFeatureLinkMock: vi.fn(),
  state: {
    permissions: [] as Array<{ resource: string; action: string }>,
    mfa: true,
    auth: {} as Record<string, unknown>,
  },
  // Which lane:category gates are open in this test's manifest.
  gates: { open: new Set<string>(['dell:driver', 'dell:application']) },
}));

vi.mock('../../services/configurationPolicy', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../services/configurationPolicy')>();
  return {
    ...original,
    getConfigPolicy: getConfigPolicyMock,
    addFeatureLink: addFeatureLinkMock,
    updateFeatureLink: updateFeatureLinkMock,
    removeFeatureLink: removeFeatureLinkMock,
    listFeatureLinks: vi.fn(),
    validateFeaturePolicyExists: vi.fn(async () => ({ valid: true })),
  };
});

vi.mock('../../services/oemUpdates/toolManifest', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../services/oemUpdates/toolManifest')>();
  return { ...original, isCategoryOpen: (lane: string, category: string) => gates.open.has(`${lane}:${category}`) };
});

vi.mock('../../services/auditEvents', () => ({
  writeRouteAudit: vi.fn(),
  requestLikeFromSnapshot: vi.fn(() => ({ req: { header: () => undefined } })),
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn((_c: any, next: any) => next()),
  requireScope: vi.fn(() => (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => (_c: any, next: any) => next()),
  requireMfa: vi.fn(() => (_c: any, next: any) => next()),
  hasSatisfiedMfa: vi.fn((auth: any) => auth.token?.mfa === true),
}));

import { featureLinkRoutes } from './featureLinks';

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const POLICY_ID = '22222222-2222-2222-2222-222222222222';
const PARENT_ID = '55555555-5555-5555-5555-555555555555';
const LINK_ID = '44444444-4444-4444-4444-444444444444';
const PARTNER_ID = '99999999-9999-9999-9999-999999999999';

function buildApp() {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('auth', {
      scope: 'organization',
      orgId: ORG_ID,
      partnerId: null,
      user: { id: 'user-1', email: 'test@example.com', name: 'Test User' },
      token: { scope: 'organization', mfa: state.mfa },
      accessibleOrgIds: [ORG_ID],
      canAccessOrg: (orgId: string) => orgId === ORG_ID,
      orgCondition: () => undefined,
      ...state.auth,
    } as any);
    c.set('permissions', { permissions: state.permissions, partnerId: null, orgId: ORG_ID, roleId: 'role-1', scope: 'organization' } as any);
    await next();
  });
  app.route('/', featureLinkRoutes);
  return app;
}

const SCHEDULE = { weekOfMonth: 'third', dayOfWeek: 'wed', windowStart: '01:00', windowHours: 4 };
const settings = (over: Record<string, unknown> = {}, dell: Record<string, unknown> = {}) => ({
  version: 1,
  enabled: true,
  schedule: SCHEDULE,
  catchUpNights: 7,
  reboot: 'overnight',
  vendors: { dell: { enabled: true, categories: { driver: true }, blockedUpdateIds: [], ...dell } },
  ...over,
});
const OFF = settings({ enabled: false });
const ARMED = settings({}, { categories: { driver: true, application: true } });

const POLICY = { id: POLICY_ID, orgId: ORG_ID, partnerId: null, name: 'Policy', parentPolicyId: null, featureLinks: [] as any[] };
const OWN = (inlineSettings: unknown) => ({ id: LINK_ID, featureType: 'oem_updates', featurePolicyId: null, inlineSettings });
const child = (parentSettings: unknown | undefined, ownSettings?: unknown) => ({
  ...POLICY,
  parentPolicyId: PARENT_ID,
  featureLinks: ownSettings === undefined ? [] : [OWN(ownSettings)],
  parentPolicy: {
    id: PARENT_ID,
    featureLinks: parentSettings === undefined ? [] : [{ id: 'parent-link', featureType: 'oem_updates', inlineSettings: parentSettings }],
  },
});

function send(app: Hono, method: 'POST' | 'PATCH' | 'DELETE', body?: Record<string, unknown>) {
  const path = method === 'POST' ? `/${POLICY_ID}/features` : `/${POLICY_ID}/features/${LINK_ID}`;
  return app.request(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

const WRITE_ONLY = [{ resource: 'devices', action: 'write' }];
const WRITE_AND_EXECUTE = [...WRITE_ONLY, { resource: 'devices', action: 'execute' }];

describe('oem_updates feature links (#11070)', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    state.permissions = WRITE_ONLY;
    state.mfa = true;
    state.auth = {};
    gates.open = new Set(['dell:driver', 'dell:application']);
    app = buildApp();
    getConfigPolicyMock.mockResolvedValue(POLICY);
    addFeatureLinkMock.mockResolvedValue(OWN(OFF));
    updateFeatureLinkMock.mockResolvedValue(OWN(OFF));
    removeFeatureLinkMock.mockResolvedValue({ id: LINK_ID, featureType: 'oem_updates' });
  });

  describe('POST /:id/features', () => {
    it('arming without execute is 403 before validation, nothing written', async () => {
      const res = await send(app, 'POST', { featureType: 'oem_updates', inlineSettings: { ...settings(), bogus: 1 } });
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe('oem_updates_execute_required');
      expect(addFeatureLinkMock).not.toHaveBeenCalled();
    });

    it('arming with execute but no MFA is 403 MFA_REQUIRED', async () => {
      state.permissions = WRITE_AND_EXECUTE;
      state.mfa = false;
      const res = await send(app, 'POST', { featureType: 'oem_updates', inlineSettings: settings() });
      expect(res.status).toBe(403);
      expect(addFeatureLinkMock).not.toHaveBeenCalled();
    });

    it('arming with execute and MFA passes, with arming authorized to the service', async () => {
      state.permissions = WRITE_AND_EXECUTE;
      const res = await send(app, 'POST', { featureType: 'oem_updates', inlineSettings: settings() });
      expect(res.status).toBe(201);
      expect(addFeatureLinkMock).toHaveBeenCalledWith(
        POLICY_ID, 'oem_updates', undefined, settings(), expect.anything(), undefined,
        { oemUpdatesArmAuthorized: true },
      );
    });

    it('a disabled link needs only devices.write, and the service is told arming is not authorized', async () => {
      const res = await send(app, 'POST', { featureType: 'oem_updates', inlineSettings: OFF });
      expect(res.status).toBe(201);
      expect(addFeatureLinkMock.mock.calls[0]![6]).toEqual({ oemUpdatesArmAuthorized: false });
    });

    it('an override that narrows an armed parent needs only devices.write', async () => {
      getConfigPolicyMock.mockResolvedValue(child(ARMED));
      const res = await send(app, 'POST', { featureType: 'oem_updates', inlineSettings: settings() });
      expect(res.status).toBe(201);
    });

    it('an override with an unresolvable parent is compared with nothing (fails closed)', async () => {
      getConfigPolicyMock.mockResolvedValue({ ...child(ARMED), parentPolicy: null });
      const res = await send(app, 'POST', { featureType: 'oem_updates', inlineSettings: settings() });
      expect(res.status).toBe(403);
    });

    it('bios true on a closed gate is 400, even for an authorized writer', async () => {
      state.permissions = WRITE_AND_EXECUTE;
      const res = await send(app, 'POST', { featureType: 'oem_updates', inlineSettings: settings({}, { categories: { bios: true } }) });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: 'oem_updates_category_gate_closed', categories: ['dell:bios'] });
      expect(addFeatureLinkMock).not.toHaveBeenCalled();
    });

    it('featurePolicyId set is 400', async () => {
      const res = await send(app, 'POST', { featureType: 'oem_updates', featurePolicyId: PARENT_ID, inlineSettings: OFF });
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe('oem_updates_feature_policy_not_allowed');
    });

    it('invalid settings are 400', async () => {
      const res = await send(app, 'POST', { featureType: 'oem_updates', inlineSettings: { ...OFF, catchUpNights: 15 } });
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe('oem_updates_invalid_settings');
    });

    it('partner-wide policy still needs canManagePartnerWidePolicies, before any vendor check', async () => {
      getConfigPolicyMock.mockResolvedValue({ ...POLICY, orgId: null, partnerId: PARTNER_ID });
      state.auth = { scope: 'partner', orgId: null, partnerId: PARTNER_ID, partnerOrgAccess: 'selected' };
      state.permissions = WRITE_AND_EXECUTE;
      const res = await send(app, 'POST', { featureType: 'oem_updates', inlineSettings: OFF });
      expect(res.status).toBe(403);
      expect(String((await res.json()).error)).toMatch(/full partner org access/);
      expect(addFeatureLinkMock).not.toHaveBeenCalled();
    });

    it('partner-wide policy with full partner access stores a disabled link', async () => {
      getConfigPolicyMock.mockResolvedValue({ ...POLICY, orgId: null, partnerId: PARTNER_ID });
      state.auth = { scope: 'partner', orgId: null, partnerId: PARTNER_ID, partnerOrgAccess: 'all' };
      const res = await send(app, 'POST', { featureType: 'oem_updates', inlineSettings: OFF });
      expect(res.status).toBe(201);
    });
  });

  describe('PATCH /:id/features/:linkId', () => {
    it('newly arming the stored link needs execute', async () => {
      getConfigPolicyMock.mockResolvedValue({ ...POLICY, featureLinks: [OWN(OFF)] });
      const res = await send(app, 'PATCH', { inlineSettings: settings() });
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe('oem_updates_execute_required');
      expect(updateFeatureLinkMock).not.toHaveBeenCalled();
    });

    it('narrowing with devices.write passes: off, a category removed, a blocked ID added', async () => {
      getConfigPolicyMock.mockResolvedValue({ ...POLICY, featureLinks: [OWN(ARMED)] });
      for (const inlineSettings of [
        settings({ enabled: false }),
        settings(),
        settings({}, { categories: { driver: true, application: true }, blockedUpdateIds: ['ABC12'] }),
      ]) {
        const res = await send(app, 'PATCH', { inlineSettings });
        expect(res.status).toBe(200);
      }
      expect(updateFeatureLinkMock.mock.calls[0]![5]).toEqual({ oemUpdatesArmAuthorized: false });
    });

    it('arming with execute and MFA passes', async () => {
      state.permissions = WRITE_AND_EXECUTE;
      getConfigPolicyMock.mockResolvedValue({ ...POLICY, featureLinks: [OWN(OFF)] });
      const res = await send(app, 'PATCH', { inlineSettings: settings() });
      expect(res.status).toBe(200);
      expect(updateFeatureLinkMock.mock.calls[0]![5]).toEqual({ oemUpdatesArmAuthorized: true });
    });

    it('a featurePolicyId is 400', async () => {
      getConfigPolicyMock.mockResolvedValue({ ...POLICY, featureLinks: [OWN(OFF)] });
      const res = await send(app, 'PATCH', { featurePolicyId: PARENT_ID });
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe('oem_updates_feature_policy_not_allowed');
    });

    it('opening a gate changes no stored link: a category stays off until a writer turns it on', async () => {
      // The stored link predates the BIOS gate opening; it has no bios key.
      getConfigPolicyMock.mockResolvedValue({ ...POLICY, featureLinks: [OWN(settings())] });
      gates.open.add('dell:bios');
      // Turning bios on after the gate opened is arming: execute is needed.
      const res = await send(app, 'PATCH', { inlineSettings: settings({}, { categories: { driver: true, bios: true } }) });
      expect(res.status).toBe(403);
      expect(updateFeatureLinkMock).not.toHaveBeenCalled();
    });
  });

  describe('DELETE /:id/features/:linkId', () => {
    it('deleting an override that reverts to an armed parent needs execute', async () => {
      getConfigPolicyMock.mockResolvedValue(child(ARMED, OFF));
      const res = await send(app, 'DELETE');
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe('oem_updates_execute_required');
      expect(removeFeatureLinkMock).not.toHaveBeenCalled();
    });

    it('deleting one with no armed parent does not', async () => {
      for (const policy of [child(undefined, ARMED), child(OFF, ARMED), { ...POLICY, featureLinks: [OWN(ARMED)] }]) {
        getConfigPolicyMock.mockResolvedValue(policy);
        const res = await send(app, 'DELETE');
        expect(res.status).toBe(200);
      }
    });

    it('deleting an override no narrower than its armed parent does not', async () => {
      getConfigPolicyMock.mockResolvedValue(child(settings(), ARMED));
      const res = await send(app, 'DELETE');
      expect(res.status).toBe(200);
    });

    it('an unresolvable parent fails closed', async () => {
      getConfigPolicyMock.mockResolvedValue({ ...child(undefined, OFF), parentPolicy: null });
      const res = await send(app, 'DELETE');
      expect(res.status).toBe(403);
    });

    it('with execute and MFA the revert goes through', async () => {
      state.permissions = WRITE_AND_EXECUTE;
      getConfigPolicyMock.mockResolvedValue(child(ARMED, OFF));
      const res = await send(app, 'DELETE');
      expect(res.status).toBe(200);
    });
  });
});

describe('GET /oem-updates/gates (#11070)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    gates.open = new Set(['dell:driver', 'dell:application']);
  });

  it('reports, per lane, whether it has shipped and which categories are open, device-less', async () => {
    const res = await buildApp().request('/oem-updates/gates');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.lanes.map((l: { lane: string }) => l.lane)).toEqual(['dell', 'surface', 'hp', 'lenovo']);
    expect(body.data.lanes[0]).toEqual({
      lane: 'dell',
      shipped: true,
      categories: { bios: false, firmware: false, driver: true, application: true },
    });
    expect(body.data.lanes[2]).toEqual({
      lane: 'hp',
      shipped: true,
      categories: { bios: false, firmware: false, driver: false, application: false },
    });
    expect(body.data.lanes[3]).toEqual({
      lane: 'lenovo',
      shipped: false,
      categories: { bios: false, firmware: false, driver: false, application: false },
    });
  });

  it('is not captured as a policy id by /:id/features', async () => {
    const res = await buildApp().request('/oem-updates/gates');
    expect(res.status).toBe(200);
    expect(getConfigPolicyMock).not.toHaveBeenCalled();
  });
});
