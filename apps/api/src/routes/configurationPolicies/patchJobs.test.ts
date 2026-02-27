import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const {
  getConfigPolicyMock,
  checkDeviceMaintenanceWindowMock,
} = vi.hoisted(() => ({
  getConfigPolicyMock: vi.fn(),
  checkDeviceMaintenanceWindowMock: vi.fn(),
}));

vi.mock('../../services/configurationPolicy', () => ({
  getConfigPolicy: getConfigPolicyMock,
}));

vi.mock('../../services/featureConfigResolver', () => ({
  checkDeviceMaintenanceWindow: checkDeviceMaintenanceWindowMock,
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
}));

vi.mock('../../db', () => ({
  runOutsideDbContext: vi.fn((fn) => fn()),
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock('../../db/schema', () => ({
  configPolicyFeatureLinks: {
    id: 'configPolicyFeatureLinks.id',
    configPolicyId: 'configPolicyFeatureLinks.configPolicyId',
    featureType: 'configPolicyFeatureLinks.featureType',
    featurePolicyId: 'configPolicyFeatureLinks.featurePolicyId',
    inlineSettings: 'configPolicyFeatureLinks.inlineSettings',
  },
  patchPolicies: {
    id: 'patchPolicies.id',
    name: 'patchPolicies.name',
    categoryRules: 'patchPolicies.categoryRules',
    autoApprove: 'patchPolicies.autoApprove',
  },
  patchJobs: { id: 'patchJobs.id' },
  devices: {
    id: 'devices.id',
    orgId: 'devices.orgId',
    hostname: 'devices.hostname',
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

function makeFeatureLink(overrides: Record<string, unknown> = {}): any {
  return {
    id: 'fl-1',
    configPolicyId: POLICY_ID,
    featureType: 'patch',
    featurePolicyId: null,
    inlineSettings: {
      scheduleFrequency: 'daily',
      scheduleTime: '02:00',
      scheduleDayOfWeek: 'sun',
      scheduleDayOfMonth: 1,
      rebootPolicy: 'if_required',
    },
    ...overrides,
  };
}

function selectWhereResult(rows: unknown[]) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(rows),
    }),
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
      vi.mocked(db.select).mockReturnValueOnce(selectWhereLimitResult([]) as any);

      const res = await app.request(`/${POLICY_ID}/patch-job`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceIds: [DEVICE_ID] }),
      });
      expect(res.status).toBe(400);
    });

    it('returns 409 when all devices are maintenance-suppressed', async () => {
      getConfigPolicyMock.mockResolvedValue({ id: POLICY_ID, status: 'active', orgId: ORG_ID, name: 'P1' });
      vi.mocked(db.select)
        .mockReturnValueOnce(selectWhereLimitResult([makeFeatureLink()]) as any)
        .mockReturnValueOnce(selectWhereResult([{ id: DEVICE_ID, orgId: ORG_ID, hostname: 'host-1' }]) as any);

      checkDeviceMaintenanceWindowMock.mockResolvedValue({
        active: true,
        suppressPatching: true,
        suppressAlerts: false,
        suppressAutomations: false,
        suppressScripts: false,
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
      vi.mocked(db.select)
        .mockReturnValueOnce(selectWhereLimitResult([makeFeatureLink()]) as any)
        .mockReturnValueOnce(selectWhereResult([{ id: DEVICE_ID, orgId: ORG_ID, hostname: 'host-1' }]) as any);

      checkDeviceMaintenanceWindowMock.mockResolvedValue(inactiveMaintenance);

      vi.mocked(db.insert).mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: 'job-1' }]),
        }),
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
      expect(writeRouteAudit).toHaveBeenCalled();
    });

    it('returns 404 when no accessible devices found', async () => {
      getConfigPolicyMock.mockResolvedValue({ id: POLICY_ID, status: 'active', orgId: ORG_ID, name: 'P1' });
      vi.mocked(db.select)
        .mockReturnValueOnce(selectWhereLimitResult([makeFeatureLink()]) as any)
        .mockReturnValueOnce(selectWhereResult([]) as any);

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
      vi.mocked(db.select)
        .mockReturnValueOnce(selectWhereLimitResult([makeFeatureLink()]) as any)
        .mockReturnValueOnce(selectWhereResult([{ id: DEVICE_ID, orgId: otherOrgId, hostname: 'host-1' }]) as any);

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
      vi.mocked(db.select)
        .mockReturnValueOnce(selectWhereLimitResult([makeFeatureLink()]) as any)
        .mockReturnValueOnce(selectWhereResult([
          { id: DEVICE_ID, orgId: ORG_ID, hostname: 'host-1' },
          { id: device2, orgId: ORG_ID, hostname: 'host-2' },
        ]) as any);

      // First device suppressed, second not
      let maintenanceCallCount = 0;
      checkDeviceMaintenanceWindowMock.mockImplementation(async () => {
        maintenanceCallCount++;
        if (maintenanceCallCount === 1) {
          return { active: true, suppressPatching: true, suppressAlerts: false, suppressAutomations: false, suppressScripts: false };
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
      vi.mocked(db.select)
        .mockReturnValueOnce(selectWhereLimitResult([makeFeatureLink()]) as any)
        .mockReturnValueOnce(selectWhereResult([
          { id: DEVICE_ID, orgId: ORG_ID, hostname: 'host-1' },
          { id: device2, orgId: ORG_ID, hostname: 'host-2' },
        ]) as any);

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

    it('creates separate jobs when devices belong to different orgs', async () => {
      const device2 = '66666666-6666-6666-6666-666666666666';
      const otherOrgId = '77777777-7777-7777-7777-777777777777';
      getConfigPolicyMock.mockResolvedValue({ id: POLICY_ID, status: 'active', orgId: ORG_ID, name: 'P1' });
      vi.mocked(db.select)
        .mockReturnValueOnce(selectWhereLimitResult([makeFeatureLink()]) as any)
        .mockReturnValueOnce(selectWhereResult([
          { id: DEVICE_ID, orgId: ORG_ID, hostname: 'host-1' },
          { id: device2, orgId: otherOrgId, hostname: 'host-2' },
        ]) as any);

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
      expect(insertValuesMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('GET /:id/patch-settings', () => {
    it('returns patch settings when found', async () => {
      getConfigPolicyMock.mockResolvedValue({ id: POLICY_ID, name: 'P1', status: 'active' });
      vi.mocked(db.select).mockReturnValueOnce(selectWhereLimitResult([makeFeatureLink()]) as any);

      const res = await app.request(`/${POLICY_ID}/patch-settings`);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.configPolicyId).toBe(POLICY_ID);
      expect(json.approvalRing.ringId).toBeNull();
      expect(json.deployment.scheduleTime).toBe('02:00');
      expect(json.deployment).toBeDefined();
    });

    it('returns 404 when policy not found', async () => {
      getConfigPolicyMock.mockResolvedValue(null);

      const res = await app.request(`/${POLICY_ID}/patch-settings`);
      expect(res.status).toBe(404);
    });

    it('returns 404 when no patch settings link exists', async () => {
      getConfigPolicyMock.mockResolvedValue({ id: POLICY_ID, name: 'P1', status: 'active' });
      vi.mocked(db.select).mockReturnValueOnce(selectWhereLimitResult([]) as any);

      const res = await app.request(`/${POLICY_ID}/patch-settings`);
      expect(res.status).toBe(404);
    });
  });

  describe('GET /:id/resolve-patch-config/:deviceId', () => {
    it('returns resolved patch config for a device', async () => {
      getConfigPolicyMock.mockResolvedValue({ id: POLICY_ID, name: 'P1', status: 'active' });
      vi.mocked(db.select)
        .mockReturnValueOnce(selectWhereLimitResult([{ orgId: ORG_ID }]) as any)
        .mockReturnValueOnce(selectWhereLimitResult([makeFeatureLink()]) as any);

      const res = await app.request(`/${POLICY_ID}/resolve-patch-config/${DEVICE_ID}`);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.resolved).not.toBeNull();
      expect(json.resolved.approvalRing.ringId).toBeNull();
      expect(json.resolved.deployment.scheduleTime).toBe('02:00');
      expect(json.resolved.deployment).toBeDefined();
      expect(json.resolved.approvalRing).toBeDefined();
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
      vi.mocked(db.select)
        .mockReturnValueOnce(selectWhereLimitResult([{ orgId: ORG_ID }]) as any)
        .mockReturnValueOnce(selectWhereLimitResult([]) as any);

      const res = await app.request(`/${POLICY_ID}/resolve-patch-config/${DEVICE_ID}`);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.resolved).toBeNull();
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
      vi.mocked(db.select)
        .mockReturnValueOnce(selectWhereLimitResult([makeFeatureLink()]) as any)
        .mockReturnValueOnce(selectWhereResult([{ id: DEVICE_ID, orgId: ORG_ID, hostname: 'host-1' }]) as any);

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
      vi.mocked(db.select)
        .mockReturnValueOnce(selectWhereLimitResult([{ orgId: ORG_ID }]) as any)
        .mockReturnValueOnce(selectWhereLimitReject(new Error('query failed')) as any);

      const res = await app.request(`/${POLICY_ID}/resolve-patch-config/${DEVICE_ID}`);
      expect(res.status).toBe(500);
    });
  });
});
