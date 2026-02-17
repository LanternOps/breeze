import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// Hoist mock values
const {
  getConfigPolicyMock,
  resolvePatchConfigForDeviceMock,
  checkDeviceMaintenanceWindowMock,
} = vi.hoisted(() => ({
  getConfigPolicyMock: vi.fn(),
  resolvePatchConfigForDeviceMock: vi.fn(),
  checkDeviceMaintenanceWindowMock: vi.fn(),
}));

vi.mock('../../services/configurationPolicy', () => ({
  getConfigPolicy: getConfigPolicyMock,
}));

vi.mock('../../services/featureConfigResolver', () => ({
  resolvePatchConfigForDevice: resolvePatchConfigForDeviceMock,
  checkDeviceMaintenanceWindow: checkDeviceMaintenanceWindowMock,
}));

vi.mock('../../services/auditEvents', () => ({
  writeRouteAudit: vi.fn(),
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => next()),
  requireScope: vi.fn(() => (c: any, next: any) => next()),
}));

vi.mock('../../db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock('../../db/schema', () => ({
  configPolicyFeatureLinks: { id: 'id', configPolicyId: 'configPolicyId', featureType: 'featureType' },
  configPolicyPatchSettings: { featureLinkId: 'featureLinkId' },
  patchJobs: { id: 'id' },
  devices: { id: 'id', orgId: 'orgId' },
}));

import { db } from '../../db';
import { patchJobRoutes } from './patchJobs';
import { writeRouteAudit } from '../../services/auditEvents';
import { requireScope } from '../../middleware/auth';

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

function makePatchSettings(overrides: Record<string, unknown> = {}): any {
  return {
    id: 'ps-1',
    featureLinkId: 'fl-1',
    sources: ['windows_update'],
    autoApprove: true,
    autoApproveSeverities: ['critical'],
    rebootPolicy: 'if_needed',
    scheduleFrequency: 'daily',
    scheduleTime: '02:00',
    scheduleDayOfWeek: null,
    scheduleDayOfMonth: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
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

  // ============================================
  // POST /:id/patch-job
  // ============================================

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

      // Mock loadConfigPolicyPatchSettings → null (no feature link found)
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([]),
            }),
          }),
        }),
      } as any);

      const res = await app.request(`/${POLICY_ID}/patch-job`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceIds: [DEVICE_ID] }),
      });
      expect(res.status).toBe(400);
    });

    it('returns 409 when all devices are maintenance-suppressed', async () => {
      getConfigPolicyMock.mockResolvedValue({ id: POLICY_ID, status: 'active', orgId: ORG_ID, name: 'P1' });

      // loadConfigPolicyPatchSettings returns settings
      let selectCallCount = 0;
      vi.mocked(db.select).mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) {
          // loadConfigPolicyPatchSettings
          return {
            from: vi.fn().mockReturnValue({
              innerJoin: vi.fn().mockReturnValue({
                where: vi.fn().mockReturnValue({
                  limit: vi.fn().mockResolvedValue([{ patchSettings: makePatchSettings(), featureLinkId: 'fl-1' }]),
                }),
              }),
            }),
          } as any;
        }
        // Devices query
        return {
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([
              { id: DEVICE_ID, orgId: ORG_ID, hostname: 'host-1' },
            ]),
          }),
        } as any;
      });

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

      let selectCallCount = 0;
      vi.mocked(db.select).mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) {
          return {
            from: vi.fn().mockReturnValue({
              innerJoin: vi.fn().mockReturnValue({
                where: vi.fn().mockReturnValue({
                  limit: vi.fn().mockResolvedValue([{ patchSettings: makePatchSettings(), featureLinkId: 'fl-1' }]),
                }),
              }),
            }),
          } as any;
        }
        return {
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([
              { id: DEVICE_ID, orgId: ORG_ID, hostname: 'host-1' },
            ]),
          }),
        } as any;
      });

      checkDeviceMaintenanceWindowMock.mockResolvedValue(inactiveMaintenance);
      resolvePatchConfigForDeviceMock.mockResolvedValue(makePatchSettings());

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
      expect(writeRouteAudit).toHaveBeenCalled();
    });

    it('returns 404 when no accessible devices found', async () => {
      getConfigPolicyMock.mockResolvedValue({ id: POLICY_ID, status: 'active', orgId: ORG_ID, name: 'P1' });

      let selectCallCount = 0;
      vi.mocked(db.select).mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) {
          return {
            from: vi.fn().mockReturnValue({
              innerJoin: vi.fn().mockReturnValue({
                where: vi.fn().mockReturnValue({
                  limit: vi.fn().mockResolvedValue([{ patchSettings: makePatchSettings(), featureLinkId: 'fl-1' }]),
                }),
              }),
            }),
          } as any;
        }
        // No devices found
        return {
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([]),
          }),
        } as any;
      });

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

      let selectCallCount = 0;
      vi.mocked(db.select).mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) {
          return {
            from: vi.fn().mockReturnValue({
              innerJoin: vi.fn().mockReturnValue({
                where: vi.fn().mockReturnValue({
                  limit: vi.fn().mockResolvedValue([{ patchSettings: makePatchSettings(), featureLinkId: 'fl-1' }]),
                }),
              }),
            }),
          } as any;
        }
        // Device belongs to a different org the user can't access
        return {
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([
              { id: DEVICE_ID, orgId: otherOrgId, hostname: 'host-1' },
            ]),
          }),
        } as any;
      });

      const res = await app.request(`/${POLICY_ID}/patch-job`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceIds: [DEVICE_ID] }),
      });
      // All devices are inaccessible → 404
      expect(res.status).toBe(404);
    });

    it('creates partial job when some devices suppressed by maintenance', async () => {
      const device2 = '55555555-5555-5555-5555-555555555555';
      getConfigPolicyMock.mockResolvedValue({ id: POLICY_ID, status: 'active', orgId: ORG_ID, name: 'P1' });

      let selectCallCount = 0;
      vi.mocked(db.select).mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) {
          return {
            from: vi.fn().mockReturnValue({
              innerJoin: vi.fn().mockReturnValue({
                where: vi.fn().mockReturnValue({
                  limit: vi.fn().mockResolvedValue([{ patchSettings: makePatchSettings(), featureLinkId: 'fl-1' }]),
                }),
              }),
            }),
          } as any;
        }
        return {
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([
              { id: DEVICE_ID, orgId: ORG_ID, hostname: 'host-1' },
              { id: device2, orgId: ORG_ID, hostname: 'host-2' },
            ]),
          }),
        } as any;
      });

      // First device suppressed, second not
      let maintenanceCallCount = 0;
      checkDeviceMaintenanceWindowMock.mockImplementation(async () => {
        maintenanceCallCount++;
        if (maintenanceCallCount === 1) {
          return { active: true, suppressPatching: true, suppressAlerts: false, suppressAutomations: false, suppressScripts: false };
        }
        return inactiveMaintenance;
      });

      resolvePatchConfigForDeviceMock.mockResolvedValue(makePatchSettings());

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
      expect(json.totalDevices).toBe(1); // Only device2 passed
      // Verify the correct device was suppressed
      expect(checkDeviceMaintenanceWindowMock).toHaveBeenCalledTimes(2);
      if (json.skipped?.maintenanceSuppressedDeviceIds) {
        expect(json.skipped.maintenanceSuppressedDeviceIds).toContain(DEVICE_ID);
      }
    });

    it('creates separate jobs when devices resolve different patch settings', async () => {
      const device2 = '66666666-6666-6666-6666-666666666666';
      getConfigPolicyMock.mockResolvedValue({ id: POLICY_ID, status: 'active', orgId: ORG_ID, name: 'P1' });

      let selectCallCount = 0;
      vi.mocked(db.select).mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) {
          return {
            from: vi.fn().mockReturnValue({
              innerJoin: vi.fn().mockReturnValue({
                where: vi.fn().mockReturnValue({
                  limit: vi.fn().mockResolvedValue([{ patchSettings: makePatchSettings(), featureLinkId: 'fl-1' }]),
                }),
              }),
            }),
          } as any;
        }
        return {
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([
              { id: DEVICE_ID, orgId: ORG_ID, hostname: 'host-1' },
              { id: device2, orgId: ORG_ID, hostname: 'host-2' },
            ]),
          }),
        } as any;
      });

      checkDeviceMaintenanceWindowMock.mockResolvedValue(inactiveMaintenance);
      resolvePatchConfigForDeviceMock.mockImplementation(async (deviceId: string) => {
        if (deviceId === DEVICE_ID) {
          return makePatchSettings({ scheduleTime: '01:00' });
        }
        return makePatchSettings({ scheduleTime: '03:00' });
      });

      const insertReturningMock = vi.fn()
        .mockResolvedValueOnce([{ id: 'job-1' }])
        .mockResolvedValueOnce([{ id: 'job-2' }]);
      const insertValuesMock = vi.fn().mockReturnValue({
        returning: insertReturningMock,
      });
      vi.mocked(db.insert).mockReturnValue({
        values: insertValuesMock,
      } as any);

      const res = await app.request(`/${POLICY_ID}/patch-job`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceIds: [DEVICE_ID, device2] }),
      });

      expect(res.status).toBe(201);
      expect(insertValuesMock).toHaveBeenCalledTimes(2);

      const firstPayload = insertValuesMock.mock.calls[0]?.[0];
      const secondPayload = insertValuesMock.mock.calls[1]?.[0];
      const scheduleTimes = [firstPayload?.patches?.scheduleTime, secondPayload?.patches?.scheduleTime];
      expect(scheduleTimes.sort()).toEqual(['01:00', '03:00']);
    });
  });

  // ============================================
  // GET /:id/patch-settings
  // ============================================

  describe('GET /:id/patch-settings', () => {
    it('returns patch settings when found', async () => {
      getConfigPolicyMock.mockResolvedValue({ id: POLICY_ID, name: 'P1', status: 'active' });

      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{
                patchSettings: makePatchSettings(),
                featureLinkId: 'fl-1',
              }]),
            }),
          }),
        }),
      } as any);

      const res = await app.request(`/${POLICY_ID}/patch-settings`);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.configPolicyId).toBe(POLICY_ID);
      expect(json.patchSettings.sources).toContain('windows_update');
    });

    it('returns 404 when policy not found', async () => {
      getConfigPolicyMock.mockResolvedValue(null);

      const res = await app.request(`/${POLICY_ID}/patch-settings`);
      expect(res.status).toBe(404);
    });

    it('returns 404 when no patch settings link exists', async () => {
      getConfigPolicyMock.mockResolvedValue({ id: POLICY_ID, name: 'P1', status: 'active' });

      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([]),
            }),
          }),
        }),
      } as any);

      const res = await app.request(`/${POLICY_ID}/patch-settings`);
      expect(res.status).toBe(404);
    });
  });

  // ============================================
  // GET /:id/resolve-patch-config/:deviceId
  // ============================================

  describe('GET /:id/resolve-patch-config/:deviceId', () => {
    it('returns resolved patch config for a device', async () => {
      getConfigPolicyMock.mockResolvedValue({ id: POLICY_ID, name: 'P1', status: 'active' });

      // Device lookup
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ orgId: ORG_ID }]),
          }),
        }),
      } as any);

      resolvePatchConfigForDeviceMock.mockResolvedValue(makePatchSettings());

      const res = await app.request(`/${POLICY_ID}/resolve-patch-config/${DEVICE_ID}`);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.resolved).not.toBeNull();
      expect(json.resolved.sources).toContain('windows_update');
    });

    it('returns 404 when policy not found', async () => {
      getConfigPolicyMock.mockResolvedValue(null);

      const res = await app.request(`/${POLICY_ID}/resolve-patch-config/${DEVICE_ID}`);
      expect(res.status).toBe(404);
    });

    it('returns 404 when device not found', async () => {
      getConfigPolicyMock.mockResolvedValue({ id: POLICY_ID, name: 'P1', status: 'active' });

      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      } as any);

      const res = await app.request(`/${POLICY_ID}/resolve-patch-config/${DEVICE_ID}`);
      expect(res.status).toBe(404);
    });

    it('returns 403 when device belongs to different org (organization scope)', async () => {
      const otherOrgId = '44444444-4444-4444-4444-444444444444';
      getConfigPolicyMock.mockResolvedValue({ id: POLICY_ID, name: 'P1', status: 'active' });

      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ orgId: otherOrgId }]),
          }),
        }),
      } as any);

      const res = await app.request(`/${POLICY_ID}/resolve-patch-config/${DEVICE_ID}`);
      expect(res.status).toBe(403);
    });

    it('returns null resolved when no patch config found for device', async () => {
      getConfigPolicyMock.mockResolvedValue({ id: POLICY_ID, name: 'P1', status: 'active' });

      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ orgId: ORG_ID }]),
          }),
        }),
      } as any);

      resolvePatchConfigForDeviceMock.mockResolvedValue(null);

      const res = await app.request(`/${POLICY_ID}/resolve-patch-config/${DEVICE_ID}`);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.resolved).toBeNull();
    });
  });

  // ============================================
  // Service exception handling
  // ============================================

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

      let selectCallCount = 0;
      vi.mocked(db.select).mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) {
          return {
            from: vi.fn().mockReturnValue({
              innerJoin: vi.fn().mockReturnValue({
                where: vi.fn().mockReturnValue({
                  limit: vi.fn().mockResolvedValue([{ patchSettings: makePatchSettings(), featureLinkId: 'fl-1' }]),
                }),
              }),
            }),
          } as any;
        }
        return {
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([
              { id: DEVICE_ID, orgId: ORG_ID, hostname: 'host-1' },
            ]),
          }),
        } as any;
      });

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

    it('returns 500 when resolvePatchConfigForDevice throws', async () => {
      getConfigPolicyMock.mockResolvedValue({ id: POLICY_ID, name: 'P1', status: 'active' });

      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ orgId: ORG_ID }]),
          }),
        }),
      } as any);

      resolvePatchConfigForDeviceMock.mockRejectedValue(new Error('Hierarchy error'));

      const res = await app.request(`/${POLICY_ID}/resolve-patch-config/${DEVICE_ID}`);
      expect(res.status).toBe(500);
    });
  });
});
