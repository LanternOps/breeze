import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { remoteRoutes } from './remote';

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
    }))
  }
}));

vi.mock('../db/schema', () => ({
  remoteSessions: {},
  fileTransfers: {},
  devices: {},
  organizations: {},
  users: {},
  auditLogs: {}
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c, next) => {
    c.set('auth', {
      user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
      scope: 'organization',
      orgId: 'org-123',
      partnerId: null
    });
    return next();
  }),
  requireScope: vi.fn(() => async (_c, next) => next())
}));

import { db } from '../db';

describe('remote routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route('/remote', remoteRoutes);
  });

  describe('POST /remote/sessions', () => {
    it('should create a remote session when device is online', async () => {
      const device = {
        id: '11111111-1111-1111-1111-111111111111',
        orgId: 'org-123',
        hostname: 'host-1',
        osType: 'linux',
        status: 'online'
      };
      const session = {
        id: 'session-1',
        deviceId: '11111111-1111-1111-1111-111111111111',
        userId: 'user-123',
        type: 'desktop',
        status: 'pending',
        createdAt: new Date()
      };

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
            innerJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue([{ count: 0 }])
            })
          })
        } as any);

      vi.mocked(db.insert)
        .mockReturnValueOnce({
          values: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([session])
          })
        } as any)
        .mockReturnValueOnce({
          values: vi.fn().mockResolvedValue(undefined)
        } as any);

      const res = await app.request('/remote/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({
          deviceId: '11111111-1111-1111-1111-111111111111',
          type: 'desktop'
        })
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.id).toBe('session-1');
      expect(body.status).toBe('pending');
      expect(body.device.hostname).toBe('host-1');
    });

    it('should reject session creation when org hits concurrency limit', async () => {
      const device = {
        id: '11111111-1111-1111-1111-111111111111',
        orgId: 'org-123',
        hostname: 'host-1',
        osType: 'linux',
        status: 'online'
      };

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
            innerJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue([{ count: 10 }])
            })
          })
        } as any);

      const res = await app.request('/remote/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({
          deviceId: '11111111-1111-1111-1111-111111111111',
          type: 'desktop'
        })
      });

      expect(res.status).toBe(429);
      const body = await res.json();
      expect(body.currentCount).toBe(10);
    });
  });

  describe('POST /remote/sessions/:id/offer', () => {
    it('should accept a WebRTC offer and move to connecting', async () => {
      const sessionResult = {
        session: {
          id: 'session-1',
          status: 'pending',
          type: 'desktop',
          iceCandidates: []
        },
        device: {
          id: 'device-1',
          orgId: 'org-123'
        }
      };

      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([sessionResult])
            })
          })
        })
      } as any);

      vi.mocked(db.update).mockReturnValueOnce({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{
              id: 'session-1',
              status: 'connecting',
              webrtcOffer: 'offer-sdp'
            }])
          })
        })
      } as any);

      vi.mocked(db.insert).mockReturnValueOnce({
        values: vi.fn().mockResolvedValue(undefined)
      } as any);

      const res = await app.request('/remote/sessions/session-1/offer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ offer: 'offer-sdp' })
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe('connecting');
      expect(body.webrtcOffer).toBe('offer-sdp');
    });
  });

  describe('POST /remote/sessions/:id/answer', () => {
    it('should accept a WebRTC answer and activate the session', async () => {
      const sessionResult = {
        session: {
          id: 'session-1',
          status: 'connecting',
          type: 'desktop',
          iceCandidates: []
        },
        device: {
          id: 'device-1',
          orgId: 'org-123'
        }
      };
      const startedAt = new Date();

      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([sessionResult])
            })
          })
        })
      } as any);

      vi.mocked(db.update).mockReturnValueOnce({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{
              id: 'session-1',
              status: 'active',
              webrtcAnswer: 'answer-sdp',
              startedAt
            }])
          })
        })
      } as any);

      vi.mocked(db.insert).mockReturnValueOnce({
        values: vi.fn().mockResolvedValue(undefined)
      } as any);

      const res = await app.request('/remote/sessions/session-1/answer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ answer: 'answer-sdp' })
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe('active');
      expect(body.webrtcAnswer).toBe('answer-sdp');
      expect(body.startedAt).toBeDefined();
    });
  });

  describe('POST /remote/sessions/:id/ice', () => {
    it('should append an ICE candidate', async () => {
      const sessionResult = {
        session: {
          id: 'session-1',
          status: 'active',
          type: 'desktop',
          iceCandidates: [
            { candidate: 'candidate-1', sdpMid: '0', sdpMLineIndex: 0 }
          ]
        },
        device: {
          id: 'device-1',
          orgId: 'org-123'
        }
      };

      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([sessionResult])
            })
          })
        })
      } as any);

      vi.mocked(db.update).mockReturnValueOnce({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{
              id: 'session-1',
              iceCandidates: [
                { candidate: 'candidate-1', sdpMid: '0', sdpMLineIndex: 0 },
                { candidate: 'candidate-2', sdpMid: '0', sdpMLineIndex: 0 }
              ]
            }])
          })
        })
      } as any);

      const res = await app.request('/remote/sessions/session-1/ice', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({
          candidate: { candidate: 'candidate-2', sdpMid: '0', sdpMLineIndex: 0 }
        })
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.iceCandidatesCount).toBe(2);
    });
  });
});
