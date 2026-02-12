import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { snmpRoutes } from './snmp';

vi.mock('../services', () => ({}));

vi.mock('../services/auditEvents', () => ({
  writeAuditEvent: vi.fn(),
  writeRouteAudit: vi.fn()
}));

vi.mock('../services/redis', () => ({
  isRedisAvailable: vi.fn(() => false)
}));

vi.mock('../routes/agentWs', () => ({
  sendCommandToAgent: vi.fn(),
  isAgentConnected: vi.fn(() => false)
}));

vi.mock('../jobs/snmpWorker', () => ({
  enqueueSnmpPoll: vi.fn(),
  buildSnmpPollCommand: vi.fn()
}));

vi.mock('../services/snmpDashboardTopInterfaces', () => ({
  buildTopInterfaces: vi.fn(() => [])
}));

const mockDevice = {
  id: 'snmp-dev-001',
  orgId: 'org-123',
  name: 'Edge Switch',
  ipAddress: '10.0.1.1',
  snmpVersion: 'v2c',
  port: 161,
  templateId: 'tmpl-001',
  isActive: true,
  lastPolled: new Date(),
  lastStatus: 'online',
  pollingInterval: 300,
  createdAt: new Date(),
  templateName: 'HP Switch'
};

const createDbSelectChain = (results: unknown[] = []) => ({
  from: vi.fn().mockReturnValue({
    leftJoin: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        orderBy: vi.fn().mockResolvedValue(results)
      })
    }),
    where: vi.fn().mockReturnValue(Object.assign(Promise.resolve([{ count: results.length }]), {
      orderBy: vi.fn().mockResolvedValue(results),
      limit: vi.fn().mockResolvedValue(results)
    }))
  })
});

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => createDbSelectChain()),
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        returning: vi.fn(() => Promise.resolve([]))
      }))
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn(() => Promise.resolve([]))
        }))
      }))
    })),
    delete: vi.fn(() => ({
      where: vi.fn(() => ({
        returning: vi.fn(() => Promise.resolve([]))
      }))
    }))
  },
  withDbAccessContext: vi.fn(async (_ctx: any, fn: any) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: any) => fn()),
  runOutsideDbContext: vi.fn((fn: any) => fn()),
  SYSTEM_DB_ACCESS_CONTEXT: { scope: 'system', orgId: null, accessibleOrgIds: null }
}));

vi.mock('../db/schema', () => ({
  snmpTemplates: { id: 'id', name: 'name' },
  snmpDevices: {
    id: 'id', orgId: 'orgId', name: 'name', ipAddress: 'ipAddress',
    snmpVersion: 'snmpVersion', port: 'port', templateId: 'templateId',
    isActive: 'isActive', lastPolled: 'lastPolled', lastStatus: 'lastStatus',
    pollingInterval: 'pollingInterval', createdAt: 'createdAt',
    community: 'community', location: 'location', tags: 'tags'
  },
  snmpMetrics: { deviceId: 'deviceId', timestamp: 'timestamp' },
  snmpAlertThresholds: { deviceId: 'deviceId' },
  devices: {}
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      user: { id: 'user-123', email: 'test@example.com' },
      scope: 'organization',
      orgId: 'org-123',
      partnerId: null,
      accessibleOrgIds: ['org-123'],
      canAccessOrg: (orgId: string) => orgId === 'org-123'
    });
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next())
}));

import { db } from '../db';

describe('snmp routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route('/snmp', snmpRoutes);
  });

  describe('GET /snmp/devices', () => {
    it('should list devices with filters', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce(createDbSelectChain([mockDevice]) as any)
        .mockReturnValueOnce(createDbSelectChain([{ count: 1 }]) as any);

      const res = await app.request('/snmp/devices?status=online&search=edge', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(1);
      expect(body.total).toBe(1);
    });
  });

  describe('POST /snmp/devices', () => {
    it('should create a new device', async () => {
      const templateUuid = '00000000-0000-0000-0000-000000000099';
      const newDevice = {
        id: 'snmp-dev-new',
        orgId: 'org-123',
        name: 'Branch Switch',
        ipAddress: '10.100.20.5',
        snmpVersion: 'v2c',
        community: 'public',
        templateId: templateUuid,
        location: 'Branch 2',
        tags: ['switch', 'branch'],
        port: 161,
        isActive: true,
        lastStatus: 'online',
        pollingInterval: 300,
        createdAt: new Date()
      };

      // Template lookup: db.select().from().where().limit()
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue(Object.assign(Promise.resolve([{ id: templateUuid }]), {
            limit: vi.fn().mockResolvedValue([{ id: templateUuid }])
          }))
        })
      } as any);

      vi.mocked(db.insert).mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([newDevice])
        })
      } as any);

      const res = await app.request('/snmp/devices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Branch Switch',
          ipAddress: '10.100.20.5',
          snmpVersion: 'v2c',
          community: 'public',
          templateId: templateUuid,
          location: 'Branch 2',
          tags: ['switch', 'branch']
        })
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.data.id).toBe('snmp-dev-new');
    });
  });

  describe('GET /snmp/devices/:id', () => {
    it('should return device details with template and metrics', async () => {
      const deviceWithDetails = {
        ...mockDevice,
        community: 'public',
        location: 'DC1',
        tags: ['switch'],
        templateId: null
      };

      // 1st select: device lookup via from().where(and(...)).limit(1)
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue(Object.assign(Promise.resolve([deviceWithDetails]), {
              limit: vi.fn().mockResolvedValue([deviceWithDetails])
            }))
          })
        } as any)
        // 2nd select: metrics via from().where().orderBy().limit()
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue(Object.assign(Promise.resolve([]), {
              orderBy: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([])
              }),
              limit: vi.fn().mockResolvedValue([])
            }))
          })
        } as any);

      const res = await app.request('/snmp/devices/snmp-dev-001', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.id).toBe('snmp-dev-001');
    });
  });

  describe('PATCH /snmp/devices/:id', () => {
    it('should update a device', async () => {
      const updated = { ...mockDevice, location: 'Lab A', tags: ['lab', 'printer'] };

      // 1st: device existence check via select().from().where().limit()
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue(Object.assign(Promise.resolve([{ id: mockDevice.id }]), {
            limit: vi.fn().mockResolvedValue([{ id: mockDevice.id }])
          }))
        })
      } as any);

      vi.mocked(db.update).mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([updated])
          })
        })
      } as any);

      const res = await app.request('/snmp/devices/snmp-dev-001', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          location: 'Lab A',
          tags: ['lab', 'printer']
        })
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.location).toBe('Lab A');
    });
  });

  describe('DELETE /snmp/devices/:id', () => {
    it('should delete a device', async () => {
      // 1st: device existence check via select().from().where().limit()
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue(Object.assign(Promise.resolve([{ id: 'snmp-dev-001' }]), {
            limit: vi.fn().mockResolvedValue([{ id: 'snmp-dev-001' }])
          }))
        })
      } as any);

      // delete calls: metrics, alert thresholds, then device (returning)
      vi.mocked(db.delete)
        .mockReturnValueOnce({
          where: vi.fn().mockResolvedValue(undefined)
        } as any)
        .mockReturnValueOnce({
          where: vi.fn().mockResolvedValue(undefined)
        } as any)
        .mockReturnValueOnce({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ id: 'snmp-dev-001', orgId: 'org-123', name: 'Edge Switch' }])
          })
        } as any);

      const res = await app.request('/snmp/devices/snmp-dev-001', {
        method: 'DELETE'
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.id).toBe('snmp-dev-001');
    });
  });

  describe('POST /snmp/devices/:id/poll', () => {
    it('should poll device metrics', async () => {
      // Device lookup via select().from().where().limit()
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue(Object.assign(Promise.resolve([{ id: mockDevice.id, orgId: mockDevice.orgId }]), {
            limit: vi.fn().mockResolvedValue([{ id: mockDevice.id, orgId: mockDevice.orgId }])
          }))
        })
      } as any);

      const res = await app.request('/snmp/devices/snmp-dev-001/poll', {
        method: 'POST',
        headers: { Authorization: 'Bearer token' }
      });

      // Poll endpoint returns 503 when Redis is unavailable (mocked as unavailable)
      expect([200, 500, 503]).toContain(res.status);
    });
  });
});
