import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { deviceRoutes } from './devices';

vi.mock('../services', () => ({}));

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
    })),
    delete: vi.fn(() => ({
      where: vi.fn(() => Promise.resolve())
    }))
  }
}));

vi.mock('../db/schema', () => ({
  devices: {},
  deviceHardware: {},
  deviceNetwork: {},
  deviceMetrics: {},
  deviceSoftware: {},
  deviceGroups: {},
  deviceGroupMemberships: {},
  deviceCommands: {},
  sites: {},
  organizations: {},
  enrollmentKeys: {}
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c, next) => {
    c.set('auth', {
      user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
      scope: 'organization',
      orgId: 'org-123',
      partnerId: null,
      accessibleOrgIds: ['org-123'],
      canAccessOrg: (orgId: string) => orgId === 'org-123',
      orgCondition: vi.fn()
    });
    return next();
  }),
  requireScope: vi.fn(() => async (_c, next) => next()),
  requirePermission: vi.fn(() => async (_c, next) => next())
}));

import { db } from '../db';

describe('device routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route('/devices', deviceRoutes);
  });

  describe('POST /devices/onboarding-token', () => {
    it('should require orgId for partner/system contexts with multiple accessible orgs', async () => {
      const { authMiddleware } = await import('../middleware/auth');
      vi.mocked(authMiddleware).mockImplementation((c, next) => {
        c.set('auth', {
          user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
          scope: 'partner',
          orgId: null,
          partnerId: 'partner-1',
          accessibleOrgIds: ['org-1', 'org-2'],
          canAccessOrg: (orgId: string) => ['org-1', 'org-2'].includes(orgId),
          orgCondition: vi.fn()
        });
        return next();
      });

      const res = await app.request('/devices/onboarding-token', {
        method: 'POST',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('Organization ID required');
    });

    it('should use explicit orgId when provided and accessible', async () => {
      const { authMiddleware } = await import('../middleware/auth');
      vi.mocked(authMiddleware).mockImplementation((c, next) => {
        c.set('auth', {
          user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
          scope: 'partner',
          orgId: null,
          partnerId: 'partner-1',
          accessibleOrgIds: ['org-1', 'org-2'],
          canAccessOrg: (orgId: string) => ['org-1', 'org-2'].includes(orgId),
          orgCondition: vi.fn()
        });
        return next();
      });

      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ id: 'site-1' }])
          })
        })
      } as any);
      vi.mocked(db.insert).mockReturnValueOnce({
        values: vi.fn().mockResolvedValue(undefined)
      } as any);

      const res = await app.request('/devices/onboarding-token?orgId=org-2', {
        method: 'POST',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.token).toContain('enroll_');
      expect(vi.mocked(db.insert)).toHaveBeenCalled();
    });
  });

  describe('GET /devices', () => {
    it('should list devices with filters and pagination', async () => {
      const deviceList = [
        {
          id: 'device-1',
          orgId: 'org-123',
          siteId: '11111111-1111-1111-1111-111111111111',
          agentId: 'agent-1',
          hostname: 'host-1',
          displayName: 'Host One',
          osType: 'linux',
          osVersion: '1.0',
          osBuild: 'build',
          architecture: 'x86_64',
          agentVersion: '2.0',
          status: 'online',
          lastSeenAt: new Date(),
          enrolledAt: new Date(),
          tags: ['prod'],
          createdAt: new Date(),
          updatedAt: new Date(),
          cpuModel: 'Xeon',
          cpuCores: 8,
          ramTotalMb: 16384,
          diskTotalGb: 512
        },
        {
          id: 'device-2',
          orgId: 'org-123',
          siteId: '11111111-1111-1111-1111-111111111111',
          agentId: 'agent-2',
          hostname: 'host-2',
          displayName: 'Host Two',
          osType: 'linux',
          osVersion: '1.1',
          osBuild: 'build2',
          architecture: 'arm64',
          agentVersion: '2.1',
          status: 'online',
          lastSeenAt: new Date(),
          enrolledAt: new Date(),
          tags: ['edge'],
          createdAt: new Date(),
          updatedAt: new Date(),
          cpuModel: 'M2',
          cpuCores: 10,
          ramTotalMb: 8192,
          diskTotalGb: 256
        }
      ];

      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ count: 2 }])
          })
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            leftJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                orderBy: vi.fn().mockReturnValue({
                  limit: vi.fn().mockReturnValue({
                    offset: vi.fn().mockResolvedValue(deviceList)
                  })
                })
              })
            })
          })
        } as any);

      const res = await app.request('/devices?status=online&osType=linux&search=host&page=1&limit=2', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(2);
      expect(body.pagination.total).toBe(2);
      expect(body.data[0].hardware).toBeDefined();
    });
  });

  describe('GET /devices/:id', () => {
    it('should return device details', async () => {
      const device = {
        id: 'device-1',
        orgId: 'org-123',
        siteId: '11111111-1111-1111-1111-111111111111',
        status: 'online'
      };
      const hardware = { id: 'hw-1', deviceId: 'device-1' };
      const networkInterfaces = [{ id: 'net-1', deviceId: 'device-1' }];
      const recentMetrics = [{ id: 'metric-1', deviceId: 'device-1' }];
      const groups = [{ groupId: 'group-1', groupName: 'Ops' }];

      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([device])
            })
          })
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([hardware])
            })
          })
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue(networkInterfaces)
          })
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue(recentMetrics)
              })
            })
          })
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            innerJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue(groups)
            })
          })
        } as any);

      const res = await app.request('/devices/device-1', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBe('device-1');
      expect(body.hardware).toBeDefined();
      expect(body.networkInterfaces).toHaveLength(1);
      expect(body.recentMetrics).toHaveLength(1);
      expect(body.groups).toHaveLength(1);
    });

    it('should return 404 when device is missing', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([])
          })
        })
      } as any);

      const res = await app.request('/devices/missing', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(404);
    });
  });

  describe('POST /devices/:id/commands', () => {
    it('should queue a command for a device', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ id: 'device-1', orgId: 'org-123', status: 'online' }])
          })
        })
      } as any);
      vi.mocked(db.insert).mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{
            id: 'cmd-1',
            deviceId: 'device-1',
            type: 'reboot',
            status: 'pending',
            createdAt: new Date()
          }])
        })
      } as any);

      const res = await app.request('/devices/device-1/commands', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ type: 'reboot' })
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.id).toBe('cmd-1');
      expect(body.status).toBe('pending');
    });

    it('should reject script commands without scriptId', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ id: 'device-1', orgId: 'org-123', status: 'online' }])
          })
        })
      } as any);

      const res = await app.request('/devices/device-1/commands', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ type: 'script', payload: {} })
      });

      expect(res.status).toBe(400);
    });
  });

  describe('PATCH /devices/:id', () => {
    it('should update a device', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: 'device-1',
              orgId: 'org-123',
              siteId: '11111111-1111-1111-1111-111111111111'
            }])
          })
        })
      } as any);
      vi.mocked(db.update).mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{
              id: 'device-1',
              displayName: 'New Name'
            }])
          })
        })
      } as any);

      const res = await app.request('/devices/device-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ displayName: 'New Name' })
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.displayName).toBe('New Name');
    });

    it('should reject empty updates', async () => {
      const res = await app.request('/devices/device-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({})
      });

      expect(res.status).toBe(400);
    });

    it('should reject invalid site moves', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{
                id: 'device-1',
                orgId: 'org-123',
                siteId: '11111111-1111-1111-1111-111111111111'
              }])
            })
          })
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([])
            })
          })
        } as any);

      const res = await app.request('/devices/device-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ siteId: '22222222-2222-2222-2222-222222222222' })
      });

      expect(res.status).toBe(400);
    });
  });

  describe('DELETE /devices/:id', () => {
    it('should decommission a device', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: 'device-1',
              orgId: 'org-123',
              status: 'online'
            }])
          })
        })
      } as any);
      vi.mocked(db.update).mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{
              id: 'device-1',
              status: 'decommissioned'
            }])
          })
        })
      } as any);

      const res = await app.request('/devices/device-1', {
        method: 'DELETE',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.device.status).toBe('decommissioned');
    });

    it('should reject decommissioning an already decommissioned device', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: 'device-1',
              orgId: 'org-123',
              status: 'decommissioned'
            }])
          })
        })
      } as any);

      const res = await app.request('/devices/device-1', {
        method: 'DELETE',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(400);
    });
  });
});
