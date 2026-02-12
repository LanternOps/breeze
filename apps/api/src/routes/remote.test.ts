import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import { remoteRoutes } from './remote';

const mockAuthState = vi.hoisted(() => ({
  scope: 'organization' as 'organization' | 'partner' | 'system',
  orgId: 'org-123' as string | null,
  partnerId: null as string | null,
  accessibleOrgIds: ['org-123'] as string[] | null
}));

vi.mock('../services', () => ({}));

vi.mock('../services/fileStorage', () => ({
  saveChunk: vi.fn(async () => undefined),
  assembleChunks: vi.fn(async () => undefined),
  getFileStream: vi.fn(() => null),
  getFileSize: vi.fn(() => 0),
  hasAssembledFile: vi.fn(() => true),
  getTotalBytesReceived: vi.fn(() => 0),
  MAX_TRANSFER_SIZE_BYTES: 10 * 1024 * 1024
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
  remoteSessions: {},
  fileTransfers: {},
  devices: {},
  organizations: {},
  users: {},
  auditLogs: {}
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
      token: {
        sub: 'user-123',
        email: 'test@example.com',
        roleId: 'role-123',
        orgId: mockAuthState.orgId,
        partnerId: mockAuthState.partnerId,
        scope: mockAuthState.scope,
        type: 'access',
        mfa: true,
      },
      scope: mockAuthState.scope,
      orgId: mockAuthState.orgId,
      partnerId: mockAuthState.partnerId,
      accessibleOrgIds: mockAuthState.accessibleOrgIds,
      canAccessOrg: (orgId: string) => {
        if (mockAuthState.accessibleOrgIds === null) return true;
        return mockAuthState.accessibleOrgIds.includes(orgId);
      }
    });
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (_c: any, next: any) => next()),
  requireMfa: vi.fn(() => async (_c: any, next: any) => next()),
}));

import { db } from '../db';

describe('remote routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthState.scope = 'organization';
    mockAuthState.orgId = 'org-123';
    mockAuthState.partnerId = null;
    mockAuthState.accessibleOrgIds = ['org-123'];
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
        // Used as a subquery in expireStaleSessions(orgId)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              getSQL: () => sql`select 1`
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
        // Used as a subquery in expireStaleSessions(orgId)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              getSQL: () => sql`select 1`
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
          userId: 'user-123',
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

  describe('POST /remote/transfers/:id/chunks', () => {
    it('should deny chunk upload when user does not own the transfer', async () => {
      const transferResult = {
        transfer: {
          id: 'transfer-1',
          deviceId: 'device-1',
          userId: 'other-user',
          direction: 'download',
          status: 'pending',
          sizeBytes: BigInt(3),
          progressPercent: 0
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
              limit: vi.fn().mockResolvedValue([transferResult])
            })
          })
        })
      } as any);

      const form = new FormData();
      form.set('chunkIndex', '0');
      form.set('data', new File([new Uint8Array([1, 2, 3])], 'chunk.bin'));

      const res = await app.request('/remote/transfers/transfer-1/chunks', {
        method: 'POST',
        headers: { Authorization: 'Bearer token' },
        body: form
      });

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toBe('Access denied');
    });

    it('should accept chunk upload for transfer owner', async () => {
      const transferResult = {
        transfer: {
          id: 'transfer-1',
          deviceId: 'device-1',
          userId: 'user-123',
          direction: 'download',
          status: 'pending',
          sizeBytes: BigInt(3),
          progressPercent: 0
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
              limit: vi.fn().mockResolvedValue([transferResult])
            })
          })
        })
      } as any);

      const form = new FormData();
      form.set('chunkIndex', '0');
      form.set('data', new File([new Uint8Array([1, 2, 3])], 'chunk.bin'));

      const res = await app.request('/remote/transfers/transfer-1/chunks', {
        method: 'POST',
        headers: { Authorization: 'Bearer token' },
        body: form
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe('completed');
      expect(body.progressPercent).toBe(100);
    });
  });

  describe('POST /remote/sessions/:id/answer', () => {
    it('should accept a WebRTC answer and activate the session', async () => {
      const sessionResult = {
        session: {
          id: 'session-1',
          userId: 'user-123',
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
          userId: 'user-123',
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

  describe('DELETE /remote/sessions/stale', () => {
    it('cleans only partner-scoped sessions', async () => {
      mockAuthState.scope = 'partner';
      mockAuthState.orgId = null;
      mockAuthState.partnerId = 'partner-123';
      mockAuthState.accessibleOrgIds = ['org-123', 'org-456'];

      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ id: 'session-a' }, { id: 'session-b' }])
          })
        })
      } as any);

      vi.mocked(db.update).mockReturnValueOnce({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ id: 'session-a' }, { id: 'session-b' }])
          })
        })
      } as any);

      const res = await app.request('/remote/sessions/stale', {
        method: 'DELETE',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.cleaned).toBe(2);
      expect(body.ids).toEqual(['session-a', 'session-b']);
    });
  });
});
