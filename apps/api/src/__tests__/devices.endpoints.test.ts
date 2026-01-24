import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { deviceRoutes } from '../routes/devices';
import { createAuthenticatedClient, createTestDevice, createTestUser } from './helpers';

const mockQueueCommand = vi.fn();

vi.mock('../services/commandQueue', () => ({
  queueCommand: (...args: unknown[]) => mockQueueCommand(...args)
}));

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
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
  }
}));

vi.mock('../db/schema', () => ({
  users: { id: 'id', email: 'email', name: 'name', status: 'status' },
  devices: {},
  deviceCommands: {},
  alerts: {},
  organizations: {},
  deviceHardware: {},
  deviceNetwork: {},
  deviceMetrics: {},
  deviceSoftware: {},
  deviceGroups: {},
  deviceGroupMemberships: {},
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
    vi.clearAllMocks();
    app = new Hono();
    app.route('/devices', deviceRoutes);
  });

  describe('POST /devices/bulk/commands', () => {
    it('should queue commands for multiple devices', async () => {
      const deviceOne = createTestDevice({ id: 'device-1', status: 'online' });
      const deviceTwo = createTestDevice({ id: 'device-2', status: 'offline' });
      const deviceThree = createTestDevice({ id: 'device-3', status: 'decommissioned' });

      mockUserLookup();
      mockDeviceLookup(deviceOne);
      mockDeviceLookup(deviceTwo);
      mockDeviceLookup(deviceThree);

      mockQueueCommand
        .mockResolvedValueOnce({
          id: 'cmd-1',
          deviceId: deviceOne.id,
          type: 'reboot',
          status: 'pending',
          createdAt: new Date()
        })
        .mockResolvedValueOnce({
          id: 'cmd-2',
          deviceId: deviceTwo.id,
          type: 'reboot',
          status: 'pending',
          createdAt: new Date()
        });

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
    it('should return alerts with pagination', async () => {
      const device = createTestDevice({ id: 'device-1' });
      const deviceAlerts = [
        {
          id: 'alert-1',
          deviceId: device.id,
          status: 'active',
          triggeredAt: new Date()
        }
      ];

      mockUserLookup();
      mockDeviceLookup(device);
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ count: 3 }])
          })
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockReturnValue({
                limit: vi.fn().mockReturnValue({
                  offset: vi.fn().mockResolvedValue(deviceAlerts)
                })
              })
            })
          })
        } as any);

      const client = await createAuthenticatedClient(app);
      const res = await client.get(`/devices/${device.id}/alerts?page=2&limit=1`);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(1);
      expect(body.pagination).toEqual({ page: 2, limit: 1, total: 3 });
    });
  });
});
