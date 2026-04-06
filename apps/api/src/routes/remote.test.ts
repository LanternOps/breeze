import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import { remoteRoutes } from './remote';

// Valid UUIDs for test IDs
const SESSION_UUID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DEVICE_UUID = '11111111-1111-1111-1111-111111111111';
const TRANSFER_UUID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const USER_UUID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ORG_UUID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

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

vi.mock('../services/permissions', () => ({
  PERMISSIONS: {
    REMOTE_ACCESS: { resource: 'remote', action: 'access' }
  }
}));

vi.mock('../services/remoteSessionAuth', () => ({
  createDesktopConnectCode: vi.fn(async () => ({ code: 'test-code' })),
  createWsTicket: vi.fn(async () => ({ ticket: 'test-ticket' }))
}));

vi.mock('./agentWs', () => ({
  sendCommandToAgent: vi.fn(() => true)
}));

const mockDb = vi.hoisted(() => ({
  select: vi.fn(),
  insert: vi.fn(),
  update: vi.fn()
}));

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  db: mockDb
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

/** Helper to build a fluent mock chain for db.select() */
function mockSelectChain(result: unknown) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(result)
      }),
      innerJoin: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue(result)
        }),
        leftJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(result)
        })
      })
    })
  } as any;
}

function mockSelectInnerJoinChain(result: unknown) {
  return {
    from: vi.fn().mockReturnValue({
      innerJoin: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue(result)
        })
      })
    })
  } as any;
}

function mockSelectSubqueryChain() {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        getSQL: () => sql`select 1`
      })
    })
  } as any;
}

function mockSelectCountChain(count: number) {
  return {
    from: vi.fn().mockReturnValue({
      innerJoin: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ count }])
      })
    })
  } as any;
}

function mockInsertReturning(result: unknown) {
  return {
    values: vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue(result)
    })
  } as any;
}

function mockInsertNoReturn() {
  return {
    values: vi.fn().mockResolvedValue(undefined)
  } as any;
}

function mockUpdateReturning(result: unknown) {
  return {
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue(result)
      })
    })
  } as any;
}

function mockUpdateNoReturn() {
  return {
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined)
    })
  } as any;
}

function resetDbMocks() {
  // Reset each mock function and provide a default fallback
  mockDb.select.mockReset().mockReturnValue(mockSelectChain([]));
  mockDb.insert.mockReset().mockReturnValue(mockInsertNoReturn());
  mockDb.update.mockReset().mockReturnValue(mockUpdateNoReturn());
}

describe('remote routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    resetDbMocks();
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
        id: DEVICE_UUID,
        orgId: 'org-123',
        hostname: 'host-1',
        osType: 'linux',
        status: 'online'
      };
      const session = {
        id: SESSION_UUID,
        deviceId: DEVICE_UUID,
        userId: 'user-123',
        type: 'desktop',
        status: 'pending',
        createdAt: new Date()
      };

      // 1. getDeviceWithOrgCheck -> db.select().from().where().limit()
      vi.mocked(db.select)
        .mockReturnValueOnce(mockSelectChain([device]))
        // 2. expireStaleSessions subquery -> db.select().from().where() (subquery)
        .mockReturnValueOnce(mockSelectSubqueryChain())
        // 3. checkSessionRateLimit count -> db.select().from().innerJoin().where()
        .mockReturnValueOnce(mockSelectCountChain(0))
        // 4. checkUserSessionRateLimit count -> db.select().from().where()
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ count: 0 }])
          })
        } as any);

      // 1. db.insert for session creation
      // 2. db.insert for audit log
      vi.mocked(db.insert)
        .mockReturnValueOnce(mockInsertReturning([session]))
        .mockReturnValueOnce(mockInsertNoReturn());

      // expireStaleSessions -> db.update (stale cleanup)
      // expireStaleSessionsForUser -> db.update (user stale cleanup)
      vi.mocked(db.update)
        .mockReturnValueOnce(mockUpdateNoReturn())
        .mockReturnValueOnce(mockUpdateNoReturn());

      const res = await app.request('/remote/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({
          deviceId: DEVICE_UUID,
          type: 'desktop'
        })
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.id).toBe(SESSION_UUID);
      expect(body.status).toBe('pending');
      expect(body.device.hostname).toBe('host-1');
    });

    it('should reject session creation when org hits concurrency limit', async () => {
      const device = {
        id: DEVICE_UUID,
        orgId: 'org-123',
        hostname: 'host-1',
        osType: 'linux',
        status: 'online'
      };

      // 1. getDeviceWithOrgCheck
      vi.mocked(db.select)
        .mockReturnValueOnce(mockSelectChain([device]))
        // 2. expireStaleSessions subquery
        .mockReturnValueOnce(mockSelectSubqueryChain())
        // 3. checkSessionRateLimit count (returns 10 = at limit)
        .mockReturnValueOnce(mockSelectCountChain(10));

      // expireStaleSessions -> db.update (stale cleanup)
      vi.mocked(db.update)
        .mockReturnValueOnce(mockUpdateNoReturn());

      const res = await app.request('/remote/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({
          deviceId: DEVICE_UUID,
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
          id: SESSION_UUID,
          userId: 'user-123',
          status: 'pending',
          type: 'desktop',
          iceCandidates: []
        },
        device: {
          id: DEVICE_UUID,
          orgId: 'org-123',
          agentId: 'agent-abc123'
        }
      };

      // getSessionWithOrgCheck
      vi.mocked(db.select).mockReturnValueOnce(
        mockSelectInnerJoinChain([sessionResult])
      );

      // update session
      vi.mocked(db.update).mockReturnValueOnce(mockUpdateReturning([{
        id: SESSION_UUID,
        status: 'connecting',
        webrtcOffer: 'offer-sdp'
      }]));

      // audit log insert
      vi.mocked(db.insert).mockReturnValueOnce(mockInsertNoReturn());

      const res = await app.request(`/remote/sessions/${SESSION_UUID}/offer`, {
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
          id: TRANSFER_UUID,
          deviceId: DEVICE_UUID,
          userId: 'other-user',
          direction: 'download',
          status: 'pending',
          sizeBytes: BigInt(3),
          progressPercent: 0
        },
        device: {
          id: DEVICE_UUID,
          orgId: 'org-123'
        }
      };

      // getTransferWithOrgCheck
      vi.mocked(db.select).mockReturnValueOnce(
        mockSelectInnerJoinChain([transferResult])
      );

      const form = new FormData();
      form.set('chunkIndex', '0');
      form.set('data', new File([new Uint8Array([1, 2, 3])], 'chunk.bin'));

      const res = await app.request(`/remote/transfers/${TRANSFER_UUID}/chunks`, {
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
          id: TRANSFER_UUID,
          deviceId: DEVICE_UUID,
          userId: 'user-123',
          direction: 'download',
          status: 'pending',
          sizeBytes: BigInt(3),
          progressPercent: 0
        },
        device: {
          id: DEVICE_UUID,
          orgId: 'org-123'
        }
      };

      // getTransferWithOrgCheck
      vi.mocked(db.select).mockReturnValueOnce(
        mockSelectInnerJoinChain([transferResult])
      );

      // db.update for progress update (no returning)
      vi.mocked(db.update).mockReturnValueOnce({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined)
        })
      } as any);

      const form = new FormData();
      form.set('chunkIndex', '0');
      form.set('data', new File([new Uint8Array([1, 2, 3])], 'chunk.bin'));

      const res = await app.request(`/remote/transfers/${TRANSFER_UUID}/chunks`, {
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
          id: SESSION_UUID,
          userId: 'user-123',
          status: 'connecting',
          type: 'desktop',
          iceCandidates: []
        },
        device: {
          id: DEVICE_UUID,
          orgId: 'org-123'
        }
      };
      const startedAt = new Date();

      // getSessionWithOrgCheck
      vi.mocked(db.select).mockReturnValueOnce(
        mockSelectInnerJoinChain([sessionResult])
      );

      // update session
      vi.mocked(db.update).mockReturnValueOnce(mockUpdateReturning([{
        id: SESSION_UUID,
        status: 'active',
        webrtcAnswer: 'answer-sdp',
        startedAt
      }]));

      // audit log insert
      vi.mocked(db.insert).mockReturnValueOnce(mockInsertNoReturn());

      const res = await app.request(`/remote/sessions/${SESSION_UUID}/answer`, {
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
          id: SESSION_UUID,
          userId: 'user-123',
          status: 'active',
          type: 'desktop',
          iceCandidates: [
            { candidate: 'candidate-1', sdpMid: '0', sdpMLineIndex: 0 }
          ]
        },
        device: {
          id: DEVICE_UUID,
          orgId: 'org-123'
        }
      };

      // getSessionWithOrgCheck
      vi.mocked(db.select).mockReturnValueOnce(
        mockSelectInnerJoinChain([sessionResult])
      );

      // update session
      vi.mocked(db.update).mockReturnValueOnce(mockUpdateReturning([{
        id: SESSION_UUID,
        iceCandidates: [
          { candidate: 'candidate-1', sdpMid: '0', sdpMLineIndex: 0 },
          { candidate: 'candidate-2', sdpMid: '0', sdpMLineIndex: 0 }
        ]
      }]));

      const res = await app.request(`/remote/sessions/${SESSION_UUID}/ice`, {
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

      // stale session select
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ id: 'session-a' }, { id: 'session-b' }])
          })
        })
      } as any);

      // update stale sessions
      vi.mocked(db.update).mockReturnValueOnce(mockUpdateReturning([
        { id: 'session-a' },
        { id: 'session-b' }
      ]));

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
