import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const {
  getConfigPolicyMock,
  checkDeviceMaintenanceWindowMock,
  resolvePatchConfigDetailsForDeviceMock,
  loadPolicyLocalPatchConfigMock,
  listPatchInventoryMock,
  summarizePatchInventoryMock,
} = vi.hoisted(() => ({
  getConfigPolicyMock: vi.fn(),
  checkDeviceMaintenanceWindowMock: vi.fn(),
  resolvePatchConfigDetailsForDeviceMock: vi.fn(),
  loadPolicyLocalPatchConfigMock: vi.fn(),
  listPatchInventoryMock: vi.fn(),
  summarizePatchInventoryMock: vi.fn((rows: any[]) => ({
    total: rows.length,
    ok: rows.filter((row) => row.effectiveStatus === 'ok').length,
    needsRepair: rows.filter((row) => row.effectiveStatus === 'needs_repair').length,
    invalidReference: rows.filter((row) => row.effectiveStatus === 'invalid_reference').length,
  })),
}));

vi.mock('../../services/configurationPolicy', () => ({
  getConfigPolicy: getConfigPolicyMock,
}));

vi.mock('../../services/featureConfigResolver', () => ({
  checkDeviceMaintenanceWindow: checkDeviceMaintenanceWindowMock,
  resolvePatchConfigDetailsForDevice: resolvePatchConfigDetailsForDeviceMock,
}));

vi.mock('../../services/configPolicyPatching', () => ({
  loadPolicyLocalPatchConfig: loadPolicyLocalPatchConfigMock,
  listPatchInventory: listPatchInventoryMock,
  summarizePatchInventory: summarizePatchInventoryMock,
}));

vi.mock('../../services/auditEvents', () => ({
  writeRouteAudit: vi.fn(),
}));

vi.mock('../../jobs/patchJobExecutor', () => ({
  enqueuePatchJob: vi.fn(async () => undefined),
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => next()),
  requireScope: vi.fn(() => (c: any, next: any) => next()),
  requirePermission: vi.fn(() => (c: any, next: any) => next()),
  requireMfa: vi.fn(() => (c: any, next: any) => next()),
}));

vi.mock('../../db', () => ({
  runOutsideDbContext: vi.fn((fn) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock('../../db/schema', () => ({
  patchJobs: { id: 'patchJobs.id' },
  devices: {
    id: 'devices.id',
    orgId: 'devices.orgId',
    siteId: 'devices.siteId',
    hostname: 'devices.hostname',
  },
  organizations: {
    id: 'organizations.id',
    partnerId: 'organizations.partnerId',
  },
}));

import { db } from '../../db';
import { patchJobRoutes } from './patchJobs';
import { writeRouteAudit } from '../../services/auditEvents';

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

function makePolicyLocal(overrides: Record<string, unknown> = {}): any {
  return {
    configPolicyId: POLICY_ID,
    configPolicyName: 'P1',
    featureLinkId: 'fl-1',
    orgId: ORG_ID,
    featurePolicyId: null,
    settings: {
      sources: ['os'],
      autoApprove: false,
      autoApproveSeverities: [],
      scheduleFrequency: 'daily',
      scheduleTime: '02:00',
      scheduleDayOfWeek: 'sun',
      scheduleDayOfMonth: 1,
      rebootPolicy: 'if_required',
    },
    ring: {
      classification: 'null',
      valid: true,
      ringId: null,
      ringName: null,
      categoryRules: [],
      categories: [],
      excludeCategories: [],
      autoApprove: {},
    },
    ...overrides,
  };
}

function makeResolvedPatchConfig(overrides: Record<string, unknown> = {}): any {
  return {
    settings: {
      id: 'ps-1',
      featureLinkId: 'fl-1',
      sources: ['os'],
      autoApprove: false,
      autoApproveSeverities: [],
      scheduleFrequency: 'daily',
      scheduleTime: '02:00',
      scheduleDayOfWeek: 'sun',
      scheduleDayOfMonth: 1,
      rebootPolicy: 'if_required',
    },
    featureLinkId: 'fl-1',
    configPolicyId: POLICY_ID,
    configPolicyName: 'P1',
    featurePolicyId: null,
    assignmentLevel: 'organization',
    assignmentTargetId: ORG_ID,
    assignmentPriority: 0,
    resolvedTimezone: 'UTC',
    ...overrides,
  };
}

function selectWhereLimitResult(rows: unknown[]) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(rows),
      }),
    }),
  };
}

function selectWhereLimitReject(error: Error) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockRejectedValue(error),
      }),
    }),
  };
}

const inactiveMaintenance = {
  active: false,
  suppressAlerts: false,
  suppressPatching: false,
  suppressAutomations: false,
  suppressScripts: false,
  rebootIfPending: false,
};

describe('configurationPolicies patchJob routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.use('*', async (c, next) => {
      c.set('auth', makeAuth());
      await next();
    });
    app.route('/', patchJobRoutes);
  });

  describe('POST /:id/patch-job', () => {
    it('returns 404 when policy not found', async () => {
      getConfigPolicyMock.mockResolvedValue(null);

      const res = await app.request(`/${POLICY_ID}/patch-job`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceIds: [DEVICE_ID] }),
      });
      expect(res.status).toBe(404);
    });

    it('returns 400 when policy is inactive', async () => {
      getConfigPolicyMock.mockResolvedValue({ id: POLICY_ID, status: 'inactive', orgId: ORG_ID, name: 'P1' });

      const res = await app.request(`/${POLICY_ID}/patch-job`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceIds: [DEVICE_ID] }),
      });
      expect(res.status).toBe(400);
    });

    it('returns 400 when no patch settings are configured', async () => {
      getConfigPolicyMock.mockResolvedValue({ id: POLICY_ID, status: 'active', orgId: ORG_ID, name: 'P1' });
      loadPolicyLocalPatchConfigMock.mockResolvedValue(null);

      const res = await app.request(`/${POLICY_ID}/patch-job`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceIds: [DEVICE_ID] }),
      });
      expect(res.status).toBe(400);
    });

    it('returns 409 when all devices are maintenance-suppressed', async () => {
      getConfigPolicyMock.mockResolvedValue({ id: POLICY_ID, status: 'active', orgId: ORG_ID, name: 'P1' });
      loadPolicyLocalPatchConfigMock.mockResolvedValue(makePolicyLocal());
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ id: DEVICE_ID, orgId: ORG_ID, hostname: 'host-1' }]),
          }),
        } as any);

      checkDeviceMaintenanceWindowMock.mockResolvedValue({
        active: true,
        suppressPatching: true,
        suppressAlerts: false,
        suppressAutomations: false,
        suppressScripts: false,
        rebootIfPending: false,
      });

      const res = await app.request(`/${POLICY_ID}/patch-job`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceIds: [DEVICE_ID] }),
      });
      expect(res.status).toBe(409);
    });

    it('creates patch job successfully when conditions are met', async () => {
      getConfigPolicyMock.mockResolvedValue({ id: POLICY_ID, status: 'active', orgId: ORG_ID, name: 'P1' });
      loadPolicyLocalPatchConfigMock.mockResolvedValue(makePolicyLocal({
        settings: {
          sources: ['third_party'],
          autoApprove: true,
          autoApproveSeverities: ['critical'],
          autoApproveDeferralDays: 5,
          apps: [{ source: 'third_party', packageId: 'Mozilla.Firefox', action: 'block' }],
          scheduleFrequency: 'daily',
          scheduleTime: '02:00',
          scheduleDayOfWeek: 'sun',
          scheduleDayOfMonth: 1,
          rebootPolicy: 'if_required',
        },
      }));
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ id: DEVICE_ID, orgId: ORG_ID, hostname: 'host-1' }]),
          }),
        } as any);

      checkDeviceMaintenanceWindowMock.mockResolvedValue(inactiveMaintenance);

      const insertValuesMock = vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: 'job-1' }]),
      });
      vi.mocked(db.insert).mockReturnValue({
        values: insertValuesMock,
      } as any);

      const res = await app.request(`/${POLICY_ID}/patch-job`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceIds: [DEVICE_ID] }),
      });
      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.totalDevices).toBe(1);
      expect(insertValuesMock.mock.calls[0]?.[0]?.patches).toMatchObject({
        sources: ['third_party'],
        policyAutoApprove: { enabled: true, severities: ['critical'], deferralDays: 5 },
        apps: [{ source: 'third_party', packageId: 'Mozilla.Firefox', action: 'block' }],
      });
      expect(writeRouteAudit).toHaveBeenCalled();
    });

    it('returns 404 when no accessible devices found', async () => {
      getConfigPolicyMock.mockResolvedValue({ id: POLICY_ID, status: 'active', orgId: ORG_ID, name: 'P1' });
      loadPolicyLocalPatchConfigMock.mockResolvedValue(makePolicyLocal());
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([]),
          }),
        } as any);

      const res = await app.request(`/${POLICY_ID}/patch-job`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceIds: [DEVICE_ID] }),
      });
      expect(res.status).toBe(404);
    });

    it('skips devices with inaccessible org', async () => {
      const otherOrgId = '44444444-4444-4444-4444-444444444444';
      getConfigPolicyMock.mockResolvedValue({ id: POLICY_ID, status: 'active', orgId: ORG_ID, name: 'P1' });
      loadPolicyLocalPatchConfigMock.mockResolvedValue(makePolicyLocal());
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ id: DEVICE_ID, orgId: otherOrgId, hostname: 'host-1' }]),
          }),
        } as any);

      const res = await app.request(`/${POLICY_ID}/patch-job`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceIds: [DEVICE_ID] }),
      });
      expect(res.status).toBe(404);
    });

    it('creates partial job when some devices are maintenance-suppressed', async () => {
      const device2 = '55555555-5555-5555-5555-555555555555';
      getConfigPolicyMock.mockResolvedValue({ id: POLICY_ID, status: 'active', orgId: ORG_ID, name: 'P1' });
      loadPolicyLocalPatchConfigMock.mockResolvedValue(makePolicyLocal());
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([
              { id: DEVICE_ID, orgId: ORG_ID, hostname: 'host-1' },
              { id: device2, orgId: ORG_ID, hostname: 'host-2' },
            ]),
          }),
        } as any);

      // First device suppressed, second not
      let maintenanceCallCount = 0;
      checkDeviceMaintenanceWindowMock.mockImplementation(async () => {
        maintenanceCallCount++;
        if (maintenanceCallCount === 1) {
          return { active: true, suppressPatching: true, suppressAlerts: false, suppressAutomations: false, suppressScripts: false, rebootIfPending: false };
        }
        return inactiveMaintenance;
      });

      vi.mocked(db.insert).mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: 'job-1' }]),
        }),
      } as any);

      const res = await app.request(`/${POLICY_ID}/patch-job`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceIds: [DEVICE_ID, device2] }),
      });
      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json.totalDevices).toBe(1);
      expect(json.skipped.maintenanceSuppressedDeviceIds).toContain(DEVICE_ID);
    });

    it('creates one job per org when multiple devices are selected', async () => {
      const device2 = '66666666-6666-6666-6666-666666666666';
      getConfigPolicyMock.mockResolvedValue({ id: POLICY_ID, status: 'active', orgId: ORG_ID, name: 'P1' });
      loadPolicyLocalPatchConfigMock.mockResolvedValue(makePolicyLocal());
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([
              { id: DEVICE_ID, orgId: ORG_ID, hostname: 'host-1' },
              { id: device2, orgId: ORG_ID, hostname: 'host-2' },
            ]),
          }),
        } as any);

      checkDeviceMaintenanceWindowMock.mockResolvedValue(inactiveMaintenance);

      const insertValuesMock = vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: 'job-1' }]),
      });
      vi.mocked(db.insert).mockReturnValue({ values: insertValuesMock } as any);

      const res = await app.request(`/${POLICY_ID}/patch-job`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceIds: [DEVICE_ID, device2] }),
      });

      expect(res.status).toBe(201);
      expect(insertValuesMock).toHaveBeenCalledTimes(1);
      expect(insertValuesMock.mock.calls[0]?.[0]?.targets?.deviceIds).toEqual([DEVICE_ID, device2]);
    });

    it('denies patch jobs when selected devices belong to another accessible org', async () => {
      const device2 = '66666666-6666-6666-6666-666666666666';
      const otherOrgId = '77777777-7777-7777-7777-777777777777';
      getConfigPolicyMock.mockResolvedValue({ id: POLICY_ID, status: 'active', orgId: ORG_ID, name: 'P1' });
      loadPolicyLocalPatchConfigMock.mockResolvedValue(makePolicyLocal());
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([
              { id: DEVICE_ID, orgId: ORG_ID, hostname: 'host-1' },
              { id: device2, orgId: otherOrgId, hostname: 'host-2' },
            ]),
          }),
        } as any);

      checkDeviceMaintenanceWindowMock.mockResolvedValue(inactiveMaintenance);

      // Extend canAccessOrg to include both orgs
      app = new Hono();
      app.use('*', async (c, next) => {
        c.set('auth', makeAuth({
          accessibleOrgIds: [ORG_ID, otherOrgId],
          canAccessOrg: (orgId: string) => orgId === ORG_ID || orgId === otherOrgId,
        }));
        await next();
      });
      app.route('/', patchJobRoutes);

      const res = await app.request(`/${POLICY_ID}/patch-job`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceIds: [DEVICE_ID, device2] }),
      });

      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.error).toContain('policy organization');
      expect(json.skipped.crossOrgDeviceIds).toEqual([device2]);
      expect(db.insert).not.toHaveBeenCalled();
    });

    // ── Partner-wide policies (#1724 follow-up): one policy patches every org
    //    under the partner. Scope guard verifies device.org.partnerId matches. ──
    const PARTNER_ID = '88888888-8888-4888-8888-888888888888';

    it('creates a partner-wide patch job spanning multiple orgs under the partner', async () => {
      const orgA = ORG_ID;
      const orgB = '99999999-9999-4999-8999-999999999999';
      const device2 = '66666666-6666-4666-8666-666666666666';
      getConfigPolicyMock.mockResolvedValue({
        id: POLICY_ID,
        status: 'active',
        orgId: null,
        partnerId: PARTNER_ID,
        name: 'Partner-wide',
      });
      loadPolicyLocalPatchConfigMock.mockResolvedValue(makePolicyLocal({ orgId: null }));
      vi.mocked(db.select)
        // 1) device select
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([
              { id: DEVICE_ID, orgId: orgA, hostname: 'host-a' },
              { id: device2, orgId: orgB, hostname: 'host-b' },
            ]),
          }),
        } as any)
        // 2) organizations→partner select (partner-wide scope guard)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([
              { id: orgA, partnerId: PARTNER_ID },
              { id: orgB, partnerId: PARTNER_ID },
            ]),
          }),
        } as any);

      checkDeviceMaintenanceWindowMock.mockResolvedValue(inactiveMaintenance);

      const insertValuesMock = vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: 'job-1' }]),
      });
      vi.mocked(db.insert).mockReturnValue({ values: insertValuesMock } as any);

      app = new Hono();
      app.use('*', async (c, next) => {
        c.set('auth', makeAuth({
          scope: 'partner',
          partnerId: PARTNER_ID,
          accessibleOrgIds: [orgA, orgB],
          canAccessOrg: (orgId: string) => orgId === orgA || orgId === orgB,
        }));
        await next();
      });
      app.route('/', patchJobRoutes);

      const res = await app.request(`/${POLICY_ID}/patch-job`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceIds: [DEVICE_ID, device2] }),
      });

      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json.totalDevices).toBe(2);
      // One patch_jobs row per device org (job insert grouped by org).
      expect(insertValuesMock).toHaveBeenCalledTimes(2);
    });

    it('denies a partner-wide patch job for a device whose org belongs to another partner', async () => {
      const orgA = ORG_ID;
      const foreignOrg = '99999999-9999-4999-8999-999999999999';
      const foreignPartner = '55555555-5555-4555-8555-555555555555';
      const device2 = '66666666-6666-4666-8666-666666666666';
      getConfigPolicyMock.mockResolvedValue({
        id: POLICY_ID,
        status: 'active',
        orgId: null,
        partnerId: PARTNER_ID,
        name: 'Partner-wide',
      });
      loadPolicyLocalPatchConfigMock.mockResolvedValue(makePolicyLocal({ orgId: null }));
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([
              { id: DEVICE_ID, orgId: orgA, hostname: 'host-a' },
              { id: device2, orgId: foreignOrg, hostname: 'host-foreign' },
            ]),
          }),
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([
              { id: orgA, partnerId: PARTNER_ID },
              { id: foreignOrg, partnerId: foreignPartner },
            ]),
          }),
        } as any);

      checkDeviceMaintenanceWindowMock.mockResolvedValue(inactiveMaintenance);

      app = new Hono();
      app.use('*', async (c, next) => {
        c.set('auth', makeAuth({
          scope: 'partner',
          partnerId: PARTNER_ID,
          // Caller can technically reach both orgs; the partner-scope guard is
          // what must reject the foreign-partner device, not just RLS/access.
          accessibleOrgIds: [orgA, foreignOrg],
          canAccessOrg: () => true,
        }));
        await next();
      });
      app.route('/', patchJobRoutes);

      const res = await app.request(`/${POLICY_ID}/patch-job`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceIds: [DEVICE_ID, device2] }),
      });

      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.error).toContain('policy partner');
      expect(json.skipped.crossOrgDeviceIds).toEqual([device2]);
      expect(db.insert).not.toHaveBeenCalled();
    });

    const SITE_ALLOWED = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const SITE_FORBIDDEN = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

    it('denies patch jobs for a device outside the caller site allowlist before any insert', async () => {
      getConfigPolicyMock.mockResolvedValue({ id: POLICY_ID, status: 'active', orgId: ORG_ID, name: 'P1' });
      loadPolicyLocalPatchConfigMock.mockResolvedValue(makePolicyLocal());
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([
              { id: DEVICE_ID, orgId: ORG_ID, siteId: SITE_FORBIDDEN, hostname: 'host-1' },
            ]),
          }),
        } as any);

      checkDeviceMaintenanceWindowMock.mockResolvedValue(inactiveMaintenance);

      app = new Hono();
      app.use('*', async (c, next) => {
        c.set('auth', makeAuth());
        c.set('permissions', { allowedSiteIds: [SITE_ALLOWED] } as any);
        await next();
      });
      app.route('/', patchJobRoutes);

      const res = await app.request(`/${POLICY_ID}/patch-job`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceIds: [DEVICE_ID] }),
      });

      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.error).toContain('site');
      expect(json.skipped.siteDeniedDeviceIds).toEqual([DEVICE_ID]);
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('allows patch jobs for a device inside the caller site allowlist', async () => {
      getConfigPolicyMock.mockResolvedValue({ id: POLICY_ID, status: 'active', orgId: ORG_ID, name: 'P1' });
      loadPolicyLocalPatchConfigMock.mockResolvedValue(makePolicyLocal());
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([
              { id: DEVICE_ID, orgId: ORG_ID, siteId: SITE_ALLOWED, hostname: 'host-1' },
            ]),
          }),
        } as any);

      checkDeviceMaintenanceWindowMock.mockResolvedValue(inactiveMaintenance);
      vi.mocked(db.insert).mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: 'job-1' }]),
        }),
      } as any);

      app = new Hono();
      app.use('*', async (c, next) => {
        c.set('auth', makeAuth());
        c.set('permissions', { allowedSiteIds: [SITE_ALLOWED] } as any);
        await next();
      });
      app.route('/', patchJobRoutes);

      const res = await app.request(`/${POLICY_ID}/patch-job`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceIds: [DEVICE_ID] }),
      });

      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.totalDevices).toBe(1);
    });
  });

  describe('GET /:id/patch-settings', () => {
    it('returns patch settings when found', async () => {
      getConfigPolicyMock.mockResolvedValue({ id: POLICY_ID, name: 'P1', status: 'active' });
      loadPolicyLocalPatchConfigMock.mockResolvedValue(makePolicyLocal());

      const res = await app.request(`/${POLICY_ID}/patch-settings`);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.configPolicyId).toBe(POLICY_ID);
      expect(json.policyLocal.approvalRing.ringId).toBeNull();
      expect(json.policyLocal.settings.scheduleTime).toBe('02:00');
      expect(json.policyLocal.settings).toBeDefined();
    });

    it('returns 404 when policy not found', async () => {
      getConfigPolicyMock.mockResolvedValue(null);

      const res = await app.request(`/${POLICY_ID}/patch-settings`);
      expect(res.status).toBe(404);
    });

    it('returns 404 when no patch settings link exists', async () => {
      getConfigPolicyMock.mockResolvedValue({ id: POLICY_ID, name: 'P1', status: 'active' });
      loadPolicyLocalPatchConfigMock.mockResolvedValue(null);

      const res = await app.request(`/${POLICY_ID}/patch-settings`);
      expect(res.status).toBe(404);
    });
  });

  describe('GET /:id/resolve-patch-config/:deviceId', () => {
    it('returns resolved patch config for a device', async () => {
      const appRules = [{ source: 'third_party', packageId: 'Mozilla.Firefox', action: 'block' }];
      getConfigPolicyMock.mockResolvedValue({ id: POLICY_ID, name: 'P1', status: 'active' });
      loadPolicyLocalPatchConfigMock.mockResolvedValue(makePolicyLocal({
        settings: {
          sources: ['os'],
          autoApprove: true,
          autoApproveSeverities: ['critical'],
          autoApproveDeferralDays: 5,
          apps: appRules,
          scheduleFrequency: 'daily',
          scheduleTime: '02:00',
          scheduleDayOfWeek: 'sun',
          scheduleDayOfMonth: 1,
          rebootPolicy: 'if_required',
        },
      }));
      resolvePatchConfigDetailsForDeviceMock.mockResolvedValue(makeResolvedPatchConfig());
      vi.mocked(db.select)
        .mockReturnValueOnce(selectWhereLimitResult([{ orgId: ORG_ID }]) as any);

      const res = await app.request(`/${POLICY_ID}/resolve-patch-config/${DEVICE_ID}`);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.policyLocal).not.toBeNull();
      expect(json.effective).not.toBeNull();
      expect(json.policyLocal.approvalRing.ringId).toBeNull();
      expect(json.effective.settings.scheduleTime).toBe('02:00');
      expect(json.effective.approvalRing).toBeDefined();
      // New keys sourced from the requested policy (it is also the winning one)
      expect(json.isWinning).toBe(true);
      expect(json.effective.settings.autoApproveDeferralDays).toBe(5);
      expect(json.effective.settings.apps).toEqual(appRules);
    });

    it('loads the winning policy config when it differs from the requested policy', async () => {
      const winningPolicyId = '88888888-8888-8888-8888-888888888888';
      const winningApps = [{ source: 'custom', packageId: 'corp-tool', action: 'pin', pinnedVersion: '1.2.3' }];
      getConfigPolicyMock.mockResolvedValue({ id: POLICY_ID, name: 'P1', status: 'active' });
      loadPolicyLocalPatchConfigMock.mockImplementation(async (configPolicyId: string) => {
        if (configPolicyId === POLICY_ID) {
          return makePolicyLocal();
        }
        return makePolicyLocal({
          configPolicyId: winningPolicyId,
          configPolicyName: 'P2',
          featureLinkId: 'fl-2',
          settings: {
            sources: ['os', 'third_party'],
            autoApprove: true,
            autoApproveSeverities: ['critical', 'important'],
            autoApproveDeferralDays: 9,
            apps: winningApps,
            scheduleFrequency: 'weekly',
            scheduleTime: '03:30',
            scheduleDayOfWeek: 'tue',
            scheduleDayOfMonth: 1,
            rebootPolicy: 'never',
          },
          ring: {
            classification: 'valid_ring',
            valid: true,
            ringId: 'ring-w',
            ringName: 'Winning Ring',
            categoryRules: [],
            categories: [],
            excludeCategories: [],
            autoApprove: {},
          },
        });
      });
      resolvePatchConfigDetailsForDeviceMock.mockResolvedValue(makeResolvedPatchConfig({
        configPolicyId: winningPolicyId,
        configPolicyName: 'P2',
        featureLinkId: 'fl-2',
      }));
      vi.mocked(db.select)
        .mockReturnValueOnce(selectWhereLimitResult([{ orgId: ORG_ID }]) as any);

      const res = await app.request(`/${POLICY_ID}/resolve-patch-config/${DEVICE_ID}`);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.isWinning).toBe(false);
      expect(json.effective.configPolicyId).toBe(winningPolicyId);
      // New keys must come from the *winning* policy's local config
      expect(json.effective.settings.autoApproveDeferralDays).toBe(9);
      expect(json.effective.settings.apps).toEqual(winningApps);
      expect(json.effective.approvalRing.ringId).toBe('ring-w');
      expect(json.effective.approvalRing.ringName).toBe('Winning Ring');
      // Requested policy's own config is still returned unchanged
      expect(json.policyLocal.configPolicyId).toBe(POLICY_ID);
      expect(loadPolicyLocalPatchConfigMock).toHaveBeenCalledWith(POLICY_ID);
      expect(loadPolicyLocalPatchConfigMock).toHaveBeenCalledWith(winningPolicyId);
      expect(loadPolicyLocalPatchConfigMock).toHaveBeenCalledTimes(2);
    });

    it('returns 404 when policy not found', async () => {
      getConfigPolicyMock.mockResolvedValue(null);

      const res = await app.request(`/${POLICY_ID}/resolve-patch-config/${DEVICE_ID}`);
      expect(res.status).toBe(404);
    });

    it('returns 404 when device not found', async () => {
      getConfigPolicyMock.mockResolvedValue({ id: POLICY_ID, name: 'P1', status: 'active' });
      vi.mocked(db.select).mockReturnValueOnce(selectWhereLimitResult([]) as any);

      const res = await app.request(`/${POLICY_ID}/resolve-patch-config/${DEVICE_ID}`);
      expect(res.status).toBe(404);
    });

    it('returns 403 when device belongs to different org (organization scope)', async () => {
      const otherOrgId = '44444444-4444-4444-4444-444444444444';
      getConfigPolicyMock.mockResolvedValue({ id: POLICY_ID, name: 'P1', status: 'active' });
      vi.mocked(db.select).mockReturnValueOnce(selectWhereLimitResult([{ orgId: otherOrgId }]) as any);

      const res = await app.request(`/${POLICY_ID}/resolve-patch-config/${DEVICE_ID}`);
      expect(res.status).toBe(403);
    });

    it('returns null resolved when no patch config found for policy', async () => {
      getConfigPolicyMock.mockResolvedValue({ id: POLICY_ID, name: 'P1', status: 'active' });
      loadPolicyLocalPatchConfigMock.mockResolvedValue(null);
      resolvePatchConfigDetailsForDeviceMock.mockResolvedValue(null);
      vi.mocked(db.select)
        .mockReturnValueOnce(selectWhereLimitResult([{ orgId: ORG_ID }]) as any);

      const res = await app.request(`/${POLICY_ID}/resolve-patch-config/${DEVICE_ID}`);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.policyLocal).toBeNull();
      expect(json.effective).toBeNull();
    });
  });

  describe('service exceptions', () => {
    it('returns 500 when getConfigPolicy throws in POST /:id/patch-job', async () => {
      getConfigPolicyMock.mockRejectedValue(new Error('DB connection lost'));

      const res = await app.request(`/${POLICY_ID}/patch-job`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceIds: [DEVICE_ID] }),
      });
      expect(res.status).toBe(500);
    });

    it('returns 500 when checkDeviceMaintenanceWindow throws', async () => {
      getConfigPolicyMock.mockResolvedValue({ id: POLICY_ID, status: 'active', orgId: ORG_ID, name: 'P1' });
      loadPolicyLocalPatchConfigMock.mockResolvedValue(makePolicyLocal());
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ id: DEVICE_ID, orgId: ORG_ID, hostname: 'host-1' }]),
          }),
        } as any);

      checkDeviceMaintenanceWindowMock.mockRejectedValue(new Error('DB timeout'));

      const res = await app.request(`/${POLICY_ID}/patch-job`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceIds: [DEVICE_ID] }),
      });
      expect(res.status).toBe(500);
    });

    it('returns 500 when getConfigPolicy throws in GET patch-settings', async () => {
      getConfigPolicyMock.mockRejectedValue(new Error('DB error'));

      const res = await app.request(`/${POLICY_ID}/patch-settings`);
      expect(res.status).toBe(500);
    });

    it('returns 500 when loading patch settings throws', async () => {
      getConfigPolicyMock.mockResolvedValue({ id: POLICY_ID, name: 'P1', status: 'active' });
      vi.mocked(db.select).mockReturnValueOnce(selectWhereLimitResult([{ orgId: ORG_ID }]) as any);
      loadPolicyLocalPatchConfigMock.mockRejectedValue(new Error('query failed'));

      const res = await app.request(`/${POLICY_ID}/resolve-patch-config/${DEVICE_ID}`);
      expect(res.status).toBe(500);
    });
  });
});
