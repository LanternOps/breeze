import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { agentRoutes } from './agents';

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
        where: vi.fn(() => Promise.resolve())
      }))
    })),
    transaction: vi.fn()
  }
}));

vi.mock('../db/schema', () => ({
  devices: {},
  deviceHardware: {},
  deviceNetwork: {},
  deviceMetrics: {},
  deviceCommands: {},
  enrollmentKeys: {}
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c, next) => next()),
  requireScope: vi.fn(() => async (_c, next) => next())
}));

import { db } from '../db';

describe('agent routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route('/agents', agentRoutes);
  });

  describe('POST /agents/enroll', () => {
    it('should enroll an agent with a valid enrollment key', async () => {
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: 'key-123',
              key: 'enroll-key',
              orgId: 'org-123',
              siteId: 'site-123'
            }])
          })
        })
      } as any);

      const tx = {
        insert: vi.fn().mockReturnValue({
          values: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{
              id: 'device-123'
            }])
          })
        }),
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue(undefined)
          })
        })
      };
      vi.mocked(db.transaction).mockImplementation(async (fn) => fn(tx as any));

      const res = await app.request('/agents/enroll', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enrollmentKey: 'enroll-key',
          hostname: 'agent-host',
          osType: 'linux',
          osVersion: '1.0',
          architecture: 'x86_64',
          agentVersion: '2.0'
        })
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.agentId).toBeDefined();
      expect(body.deviceId).toBe('device-123');
      expect(body.authToken).toBeDefined();
      expect(body.orgId).toBe('org-123');
      expect(body.siteId).toBe('site-123');
      expect(body.config).toBeDefined();
    });

    it('should reject invalid enrollment keys', async () => {
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([])
          })
        })
      } as any);

      const res = await app.request('/agents/enroll', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enrollmentKey: 'bad-key',
          hostname: 'agent-host',
          osType: 'linux',
          osVersion: '1.0',
          architecture: 'x86_64',
          agentVersion: '2.0'
        })
      });

      expect(res.status).toBe(401);
    });
  });

  describe('POST /agents/:id/heartbeat', () => {
    it('should return pending commands and store metrics', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{
                id: 'device-123',
                agentId: 'agent-123'
              }])
            })
          })
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([{
                  id: 'cmd-1',
                  type: 'script',
                  payload: { scriptId: 'script-1' }
                }])
              })
            })
          })
        } as any);

      vi.mocked(db.update).mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined)
        })
      } as any);

      vi.mocked(db.insert).mockReturnValue({
        values: vi.fn().mockResolvedValue(undefined)
      } as any);

      const res = await app.request('/agents/agent-123/heartbeat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          metrics: {
            cpuPercent: 10,
            ramPercent: 20,
            ramUsedMb: 1024,
            diskPercent: 30,
            diskUsedGb: 100
          },
          status: 'ok',
          agentVersion: '2.0'
        })
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.commands).toHaveLength(1);
      expect(body.commands[0].id).toBe('cmd-1');
    });

    it('should return 404 when device is missing', async () => {
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([])
          })
        })
      } as any);

      const res = await app.request('/agents/agent-404/heartbeat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          metrics: {
            cpuPercent: 10,
            ramPercent: 20,
            ramUsedMb: 1024,
            diskPercent: 30,
            diskUsedGb: 100
          },
          status: 'ok',
          agentVersion: '2.0'
        })
      });

      expect(res.status).toBe(404);
    });
  });

  describe('POST /agents/:id/commands/:commandId/result', () => {
    it('should store command results', async () => {
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: 'cmd-1',
              status: 'sent'
            }])
          })
        })
      } as any);

      vi.mocked(db.update).mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined)
        })
      } as any);

      const res = await app.request('/agents/agent-123/commands/cmd-1/result', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: 'completed',
          exitCode: 0,
          stdout: 'ok',
          durationMs: 1200
        })
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
    });

    it('should return 404 for unknown commands', async () => {
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([])
          })
        })
      } as any);

      const res = await app.request('/agents/agent-123/commands/missing/result', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: 'failed',
          durationMs: 500
        })
      });

      expect(res.status).toBe(404);
    });
  });
});
