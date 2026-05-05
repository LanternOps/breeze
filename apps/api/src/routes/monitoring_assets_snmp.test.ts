import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../db', () => ({
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

vi.mock('../db/schema', () => ({
  devices: {
    id: 'devices.id',
    orgId: 'devices.orgId',
  },
  deviceSoftware: {},
  deviceChangeLog: {
    orgId: 'deviceChangeLog.orgId',
    changeType: 'deviceChangeLog.changeType',
    subject: 'deviceChangeLog.subject',
  },
  discoveredAssets: {
    id: 'discoveredAssets.id',
    orgId: 'discoveredAssets.orgId',
    siteId: 'discoveredAssets.siteId',
    hostname: 'discoveredAssets.hostname',
    ipAddress: 'discoveredAssets.ipAddress',
    assetType: 'discoveredAssets.assetType',
    approvalStatus: 'discoveredAssets.approvalStatus',
    isOnline: 'discoveredAssets.isOnline',
    lastSeenAt: 'discoveredAssets.lastSeenAt',
    createdAt: 'discoveredAssets.createdAt',
    updatedAt: 'discoveredAssets.updatedAt',
  },
  networkMonitors: {
    assetId: 'networkMonitors.assetId',
    orgId: 'networkMonitors.orgId',
    isActive: 'networkMonitors.isActive',
    id: 'networkMonitors.id',
    updatedAt: 'networkMonitors.updatedAt',
  },
  snmpDevices: {
    id: 'snmpDevices.id',
    orgId: 'snmpDevices.orgId',
    assetId: 'snmpDevices.assetId',
    snmpVersion: 'snmpDevices.snmpVersion',
    templateId: 'snmpDevices.templateId',
    pollingInterval: 'snmpDevices.pollingInterval',
    port: 'snmpDevices.port',
    isActive: 'snmpDevices.isActive',
    lastPolled: 'snmpDevices.lastPolled',
    lastStatus: 'snmpDevices.lastStatus',
    createdAt: 'snmpDevices.createdAt',
    community: 'snmpDevices.community',
    authPassword: 'snmpDevices.authPassword',
    privPassword: 'snmpDevices.privPassword',
    username: 'snmpDevices.username',
  },
  snmpMetrics: {
    id: 'snmpMetrics.id',
    deviceId: 'snmpMetrics.deviceId',
    oid: 'snmpMetrics.oid',
    name: 'snmpMetrics.name',
    value: 'snmpMetrics.value',
    valueType: 'snmpMetrics.valueType',
    timestamp: 'snmpMetrics.timestamp',
  },
  snmpTemplates: {
    id: 'snmpTemplates.id',
    orgId: 'snmpTemplates.orgId',
    isBuiltIn: 'snmpTemplates.isBuiltIn',
  },
  serviceProcessCheckResults: {
    id: 'serviceProcessCheckResults.id',
    orgId: 'serviceProcessCheckResults.orgId',
    deviceId: 'serviceProcessCheckResults.deviceId',
    watchType: 'serviceProcessCheckResults.watchType',
    name: 'serviceProcessCheckResults.name',
    status: 'serviceProcessCheckResults.status',
    cpuPercent: 'serviceProcessCheckResults.cpuPercent',
    memoryMb: 'serviceProcessCheckResults.memoryMb',
    pid: 'serviceProcessCheckResults.pid',
    details: 'serviceProcessCheckResults.details',
    autoRestartAttempted: 'serviceProcessCheckResults.autoRestartAttempted',
    autoRestartSucceeded: 'serviceProcessCheckResults.autoRestartSucceeded',
    timestamp: 'serviceProcessCheckResults.timestamp',
  },
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      user: { id: 'user-1', email: 'test@example.com', name: 'Test User' },
      scope: 'organization',
      partnerId: null,
      orgId: 'org-111',
      accessibleOrgIds: ['org-111'],
      orgCondition: () => undefined,
      canAccessOrg: (id: string) => id === 'org-111',
    });
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (_c: any, next: any) => next()),
  requireMfa: vi.fn(() => async (_c: any, next: any) => next()),
}));

vi.mock('../services/auditEvents', () => ({
  writeRouteAudit: vi.fn(),
}));

vi.mock('../services/redis', () => ({
  isRedisAvailable: vi.fn(() => true),
}));

import { monitoringRoutes } from './monitoring';
import { db } from '../db';
import { decryptSecret, isEncryptedSecret } from '../services/secretCrypto';

const ORG_ID = 'org-111';
const ASSET_ID = '11111111-1111-1111-1111-111111111111';
const DEVICE_ID = '22222222-2222-2222-2222-222222222222';
const SNMP_DEVICE_ID = '33333333-3333-3333-3333-333333333333';


describe('monitoring routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route('/monitoring', monitoringRoutes);
  });

  // ============================================
  // PUT /assets/:id/snmp
  // ============================================
  describe('PUT /monitoring/assets/:id/snmp', () => {
    it('stores encrypted SNMP community strings for an asset', async () => {
      // Asset lookup
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{
                id: ASSET_ID,
                orgId: ORG_ID,
                hostname: 'switch-01',
                ipAddress: '10.0.0.1',
              }]),
            }),
          }),
        } as any)
        // Existing SNMP rows
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([]),
              }),
            }),
          }),
        } as any);
      // Insert new SNMP device
      const insertValues = vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{
          id: SNMP_DEVICE_ID,
          snmpVersion: 'v2c',
          port: 161,
          community: 'enc:v1:mock',
          username: null,
          templateId: null,
          pollingInterval: 300,
          isActive: true,
          lastPolled: null,
          lastStatus: null,
        }]),
      });
      vi.mocked(db.insert).mockReturnValueOnce({
        values: insertValues,
      } as any);

      const res = await app.request(`/monitoring/assets/${ASSET_ID}/snmp`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ snmpVersion: 'v2c', community: 'public' }),
      });

      expect(res.status).toBe(200);
      const saved = insertValues.mock.calls[0]?.[0] as any;
      expect(saved).toBeDefined();
      expect(isEncryptedSecret(saved.community)).toBe(true);
      expect(decryptSecret(saved.community)).toBe('public');
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.snmpDevice.snmpVersion).toBe('v2c');
      expect(body.snmpDevice.community).toBe('********');
    });

    it('creates encrypted SNMP v3 credentials for an asset', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{
                id: ASSET_ID,
                orgId: ORG_ID,
                hostname: 'switch-01',
                ipAddress: '10.0.0.1',
              }]),
            }),
          }),
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([]),
              }),
            }),
          }),
        } as any);
      const insertValues = vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{
          id: SNMP_DEVICE_ID,
          snmpVersion: 'v3',
          port: 161,
          community: null,
          username: 'poller',
          authPassword: 'enc:v1:mock-auth',
          privPassword: 'enc:v1:mock-priv',
          templateId: null,
          pollingInterval: 300,
          isActive: true,
          lastPolled: null,
          lastStatus: null,
        }]),
      });
      vi.mocked(db.insert).mockReturnValueOnce({
        values: insertValues,
      } as any);

      const res = await app.request(`/monitoring/assets/${ASSET_ID}/snmp`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({
          snmpVersion: 'v3',
          username: 'poller',
          authPassword: 'auth-secret',
          privPassword: 'priv-secret',
        }),
      });

      expect(res.status).toBe(200);
      const saved = insertValues.mock.calls[0]?.[0] as any;
      expect(saved).toBeDefined();
      expect(decryptSecret(saved.authPassword)).toBe('auth-secret');
      expect(decryptSecret(saved.privPassword)).toBe('priv-secret');
      const body = await res.json();
      expect(body.snmpDevice.authPassword).toBe('********');
      expect(body.snmpDevice.privPassword).toBe('********');
    });

    it('returns 404 for nonexistent asset', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      } as any);

      const res = await app.request(`/monitoring/assets/${ASSET_ID}/snmp`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ snmpVersion: 'v2c', community: 'public' }),
      });

      expect(res.status).toBe(404);
    });

    it('rejects v2c without community string', async () => {
      const res = await app.request(`/monitoring/assets/${ASSET_ID}/snmp`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ snmpVersion: 'v2c' }),
      });

      expect(res.status).toBe(400);
    });

    it('rejects v3 without username', async () => {
      const res = await app.request(`/monitoring/assets/${ASSET_ID}/snmp`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ snmpVersion: 'v3' }),
      });

      expect(res.status).toBe(400);
    });
  });

  // ============================================
  // PATCH /assets/:id/snmp
  // ============================================
  describe('PATCH /monitoring/assets/:id/snmp', () => {
    it('updates existing SNMP config', async () => {
      // Asset lookup
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{ id: ASSET_ID, orgId: ORG_ID }]),
            }),
          }),
        } as any)
        // Existing SNMP device
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([{
                  id: SNMP_DEVICE_ID,
                  snmpVersion: 'v2c',
                  pollingInterval: 300,
                }]),
              }),
            }),
          }),
        } as any);
      vi.mocked(db.update).mockReturnValueOnce({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{
              id: SNMP_DEVICE_ID,
              snmpVersion: 'v2c',
              port: 161,
              community: 'public',
              username: null,
              templateId: null,
              pollingInterval: 600,
              isActive: true,
              lastPolled: null,
              lastStatus: null,
            }]),
          }),
        }),
      } as any);

      const res = await app.request(`/monitoring/assets/${ASSET_ID}/snmp`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ pollingInterval: 600 }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.snmpDevice.pollingInterval).toBe(600);
    });

    it('preserves encrypted secrets when masked placeholders are submitted', async () => {
      const encryptedCommunity = 'enc:v1:existing-community';
      const encryptedAuthPassword = 'enc:v1:existing-auth';
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{ id: ASSET_ID, orgId: ORG_ID }]),
            }),
          }),
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([{
                  id: SNMP_DEVICE_ID,
                  snmpVersion: 'v2c',
                  pollingInterval: 300,
                  community: encryptedCommunity,
                  authPassword: encryptedAuthPassword,
                }]),
              }),
            }),
          }),
        } as any);
      const updateSet = vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{
            id: SNMP_DEVICE_ID,
            snmpVersion: 'v2c',
            port: 161,
            community: encryptedCommunity,
            authPassword: encryptedAuthPassword,
            username: null,
            templateId: null,
            pollingInterval: 600,
            isActive: true,
            lastPolled: null,
            lastStatus: null,
          }]),
        }),
      });
      vi.mocked(db.update).mockReturnValueOnce({ set: updateSet } as any);

      const res = await app.request(`/monitoring/assets/${ASSET_ID}/snmp`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ community: '********', authPassword: '********', pollingInterval: 600 }),
      });

      expect(res.status).toBe(200);
      expect(updateSet).toHaveBeenCalledWith({ pollingInterval: 600 });
    });

    it('returns 404 when no SNMP config exists', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{ id: ASSET_ID, orgId: ORG_ID }]),
            }),
          }),
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([]),
              }),
            }),
          }),
        } as any);

      const res = await app.request(`/monitoring/assets/${ASSET_ID}/snmp`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ pollingInterval: 600 }),
      });

      expect(res.status).toBe(404);
    });

    it('returns 400 when no fields to update', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{ id: ASSET_ID, orgId: ORG_ID }]),
            }),
          }),
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([{ id: SNMP_DEVICE_ID }]),
              }),
            }),
          }),
        } as any);

      const res = await app.request(`/monitoring/assets/${ASSET_ID}/snmp`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
    });
  });

  // ============================================
  // DELETE /assets/:id
  // ============================================
  describe('DELETE /monitoring/assets/:id', () => {
    it('disables all monitoring for an asset', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ id: ASSET_ID, orgId: ORG_ID }]),
          }),
        }),
      } as any);
      // Disable SNMP
      vi.mocked(db.update)
        .mockReturnValueOnce({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([{ id: SNMP_DEVICE_ID }]),
            }),
          }),
        } as any)
        // Disable network monitors
        .mockReturnValueOnce({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([{ id: 'net-1' }]),
            }),
          }),
        } as any);

      const res = await app.request(`/monitoring/assets/${ASSET_ID}`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
    });

    it('returns 404 when no active monitoring found', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ id: ASSET_ID, orgId: ORG_ID }]),
          }),
        }),
      } as any);
      vi.mocked(db.update)
        .mockReturnValueOnce({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([]),
            }),
          }),
        } as any)
        .mockReturnValueOnce({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([]),
            }),
          }),
        } as any);

      const res = await app.request(`/monitoring/assets/${ASSET_ID}`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(404);
    });

    it('returns 404 for nonexistent asset', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      } as any);

      const res = await app.request(`/monitoring/assets/${ASSET_ID}`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(404);
    });
  });

});
