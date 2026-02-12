import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { deviceRoutes } from '../routes/devices';
import { createAuthenticatedClient, createTestDevice, createTestUser } from './helpers';

const mockQueueCommand = vi.fn();

vi.mock('../services/commandQueue', () => ({
  queueCommand: (...args: unknown[]) => mockQueueCommand(...args)
}));

vi.mock('../services/auditEvents', () => ({
  writeAuditEvent: vi.fn(),
  writeRouteAudit: vi.fn()
}));

vi.mock('../services/enrollmentKeySecurity', () => ({
  hashEnrollmentKey: vi.fn((key: string) => `hashed-${key}`),
  generateEnrollmentKey: vi.fn(() => 'ek_test123')
}));

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => Object.assign(Promise.resolve([]), {
          limit: vi.fn(() => Promise.resolve([]))
        }))
      }))
    })),
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
    }))
  },
  withDbAccessContext: vi.fn(async (_ctx: any, fn: any) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: any) => fn()),
  runOutsideDbContext: vi.fn((fn: any) => fn()),
  SYSTEM_DB_ACCESS_CONTEXT: { scope: 'system', orgId: null, accessibleOrgIds: null }
}));

vi.mock('../db/schema', () => ({
  users: { id: 'id', email: 'email', name: 'name', status: 'status' },
  devices: { id: 'id', orgId: 'orgId' },
  deviceCommands: { deviceId: 'deviceId', status: 'status', createdAt: 'createdAt' },
  alerts: { deviceId: 'deviceId', status: 'status', triggeredAt: 'triggeredAt' },
  alertRules: {},
  alertTemplates: {},
  organizations: {},
  partnerUsers: {},
  organizationUsers: {},
  deviceHardware: {},
  deviceNetwork: {},
  deviceMetrics: {},
  deviceSoftware: {},
  deviceGroups: {},
  deviceGroupMemberships: {},
  enrollmentKeys: {},
  sites: {}
}));

import { db } from '../db';

function mockUserLookup(user = createTestUser()) {
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue([user])
      })
    })
  } as any);
}

function mockDeviceLookup(device: ReturnType<typeof createTestDevice> | null) {
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(device ? [device] : [])
      })
    })
  } as any);
}

describe('device endpoints (authenticated)', () => {
  let app: Hono;

  beforeEach(() => {
    // resetAllMocks clears mockReturnValueOnce queue to prevent test pollution
    vi.resetAllMocks();
    // Restore factory defaults after reset
    vi.mocked(db.select).mockImplementation(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => Object.assign(Promise.resolve([]), {
          limit: vi.fn(() => Promise.resolve([])),
          orderBy: vi.fn(() => ({
            limit: vi.fn(() => ({
              offset: vi.fn(() => Promise.resolve([]))
            }))
          }))
        }))
      }))
    }) as any);
    vi.mocked(db.insert).mockImplementation(() => ({
      values: vi.fn(() => ({
        returning: vi.fn(() => Promise.resolve([]))
      }))
    }) as any);
    vi.mocked(db.update).mockImplementation(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn(() => Promise.resolve([]))
        }))
      }))
    }) as any);
    mockQueueCommand.mockReset();
    app = new Hono();
    app.route('/devices', deviceRoutes);
  });

  describe('POST /devices/bulk/commands', () => {
    it('should queue commands for multiple devices', async () => {
      const deviceOne = createTestDevice({ id: '00000000-0000-0000-0000-000000000001', status: 'online' });
      const deviceTwo = createTestDevice({ id: '00000000-0000-0000-0000-000000000002', status: 'offline' });
      const deviceThree = createTestDevice({ id: '00000000-0000-0000-0000-000000000003', status: 'decommissioned' });

      mockUserLookup();
      mockDeviceLookup(deviceOne);
      mockDeviceLookup(deviceTwo);
      mockDeviceLookup(deviceThree);

      // The bulk command handler uses db.insert().values().returning() for each device
      vi.mocked(db.insert)
        .mockReturnValueOnce({
          values: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{
              id: 'cmd-1',
              deviceId: deviceOne.id,
              type: 'reboot',
              status: 'pending',
              createdAt: new Date()
            }])
          })
        } as any)
        .mockReturnValueOnce({
          values: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{
              id: 'cmd-2',
              deviceId: deviceTwo.id,
              type: 'reboot',
              status: 'pending',
              createdAt: new Date()
            }])
          })
        } as any);

      const client = await createAuthenticatedClient(app);
      const res = await client.post('/devices/bulk/commands', {
        deviceIds: [deviceOne.id, deviceTwo.id, deviceThree.id],
        type: 'reboot'
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.commands).toHaveLength(2);
      expect(body.failed).toEqual([deviceThree.id]);
      expect(body.commands.map((command: { deviceId: string }) => command.deviceId)).toEqual([
        deviceOne.id,
        deviceTwo.id
      ]);
    });
  });

  describe('POST /devices/:id/maintenance', () => {
    it('should enable maintenance mode', async () => {
      const device = createTestDevice({ id: 'device-1', status: 'online' });
      const updated = { ...device, status: 'maintenance' };

      mockUserLookup();
      mockDeviceLookup(device);
      vi.mocked(db.update).mockReturnValueOnce({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([updated])
          })
        })
      } as any);

      const client = await createAuthenticatedClient(app);
      const res = await client.post(`/devices/${device.id}/maintenance`, {
        enable: true,
        durationHours: 2
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.device.status).toBe('maintenance');
    });

    it('should disable maintenance mode', async () => {
      const device = createTestDevice({ id: 'device-2', status: 'maintenance' });
      const updated = { ...device, status: 'online' };

      mockUserLookup();
      mockDeviceLookup(device);
      vi.mocked(db.update).mockReturnValueOnce({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([updated])
          })
        })
      } as any);

      const client = await createAuthenticatedClient(app);
      const res = await client.post(`/devices/${device.id}/maintenance`, {
        enable: false
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.device.status).toBe('online');
    });
  });

  describe('GET /devices/:id/alerts', () => {
    it('should return alerts for a device', async () => {
      const device = createTestDevice({ id: 'device-1' });
      const mockAlert = {
        id: 'alert-1',
        title: 'High CPU',
        message: 'CPU at 95%',
        severity: 'warning',
        status: 'active',
        triggeredAt: new Date(),
        acknowledgedAt: null,
        resolvedAt: null,
        ruleName: 'cpu-rule',
        templateName: 'cpu-template'
      };

      mockUserLookup();
      mockDeviceLookup(device);
      // Alerts query: db.select().from(alerts).leftJoin().leftJoin().where().orderBy().limit()
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          leftJoin: vi.fn().mockReturnValue({
            leftJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                orderBy: vi.fn().mockReturnValue({
                  limit: vi.fn().mockResolvedValue([mockAlert])
                })
              })
            })
          })
        })
      } as any);

      const client = await createAuthenticatedClient(app);
      const res = await client.get(`/devices/${device.id}/alerts?limit=10`);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(1);
      expect(body.data[0].id).toBe('alert-1');
    });
  });
});
