import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import { remoteRoutes } from './remote';

// Valid UUIDs for test IDs
const SESSION_UUID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DEVICE_UUID = '11111111-1111-1111-1111-111111111111';
const USER_UUID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ORG_UUID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

const mockAuthState = vi.hoisted(() => ({
  scope: 'organization' as 'organization' | 'partner' | 'system',
  orgId: 'org-123' as string | null,
  partnerId: null as string | null,
  accessibleOrgIds: ['org-123'] as string[] | null,
  allowedSiteIds: undefined as string[] | undefined
}));

vi.mock('../services', () => ({}));

vi.mock('../services/permissions', () => ({
  canAccessSite: (permissions: { allowedSiteIds?: string[] }, siteId: string) => !permissions.allowedSiteIds || permissions.allowedSiteIds.includes(siteId),
  PERMISSIONS: {
    REMOTE_ACCESS: { resource: 'remote', action: 'access' },
    // sessions.ts gained requirePermission(DEVICES_READ) — the mock
    // must export it or the remote/ router fails to load here.
    DEVICES_READ: { resource: 'devices', action: 'read' }
  }
}));

vi.mock('../services/remoteSessionAuth', () => ({
  createDesktopConnectCode: vi.fn(async () => ({ code: 'test-code' })),
  createWsTicket: vi.fn(async () => ({ ticket: 'test-ticket' }))
}));

vi.mock('./agentWs', () => ({
  sendCommandToAgent: vi.fn(() => true)
}));

vi.mock('../services/viewerTokenRevocation', () => ({
  revokeViewerSession: vi.fn(async () => undefined)
}));

const mockDb = vi.hoisted(() => ({
  select: vi.fn(),
  insert: vi.fn(),
  update: vi.fn()
}));

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: mockDb
}));

vi.mock('../db/schema', () => ({
  remoteSessions: {
    id: 'remoteSessions.id',
    status: 'remoteSessions.status',
    desktopStartCommandId: 'remoteSessions.desktopStartCommandId',
    desktopPromptMode: 'remoteSessions.desktopPromptMode',
  },
  devices: {},
  organizations: {},
  users: {},
  auditLogs: {},
  patchPolicies: {},
  alertRules: {},
  backupConfigs: {},
  securityPolicies: {},
  automationPolicies: {},
  maintenanceWindows: {},
  softwarePolicies: {},
  sensitiveDataPolicies: {},
  peripheralPolicies: {}
}));

vi.mock('../services/remoteAccessPolicy', () => ({
  checkRemoteAccess: vi.fn().mockResolvedValue({ allowed: true }),
  resolveDesktopSessionPolicy: vi.fn().mockResolvedValue({
    clipboard: { hostToViewer: true, viewerToHost: true },
    idleTimeoutMinutes: 5,
    maxSessionDurationHours: 8,
  }),
  resolveRemoteAccessForDevice: vi.fn().mockResolvedValue({
    settings: { webrtcDesktop: true, vncRelay: true, remoteTools: true, enableProxy: true, defaultAllowedPorts: [], autoEnableProxy: false, maxConcurrentTunnels: 5, idleTimeoutMinutes: 5, maxSessionDurationHours: 8 },
    policyName: null,
    policyId: null,
  }),
}));

vi.mock('../services/remoteRevocationLease', () => ({
  AGENT_UPGRADE_REQUIRED_CODE: 'agent_upgrade_required',
  AGENT_UPGRADE_REQUIRED_MESSAGE: 'agent update required',
  isRevocationLeaseCapable: vi.fn(async () => true),
  prepareRevocationLeaseForStart: vi.fn(async () => ({
    ok: true,
    lease: {
      token: 'lease-token',
      expiresAt: 1_000_060_000,
      hardDeadline: 1_000_600_000,
      renewEverySec: 25,
      graceSec: 90,
    },
  })),
  renewRevocationLease: vi.fn(async () => ({
    status: 'renewed',
    expiresAt: 1,
    hardDeadline: 2,
    renewEverySec: 25,
    graceSec: 90,
  })),
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
  requirePermission: vi.fn(() => async (c: any, next: any) => {
    // Only the real mounted requirePermission chain populates this context.
    // authMiddleware and requireScope above deliberately do not seed it.
    c.set('permissions', { allowedSiteIds: mockAuthState.allowedSiteIds });
    return next();
  }),
  requireMfa: vi.fn(() => async (_c: any, next: any) => next()),
}));

import { db } from '../db';
import { checkRemoteAccess } from '../services/remoteAccessPolicy';
import { sendCommandToAgent } from './agentWs';
import { remoteAccessInlineSettingsSchema } from '@breeze/shared/validators';

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
  // Reset each mock function and provide a default fallback.
  // db.update defaults to a .returning()-capable chain: expireStaleSessions /
  // expireStaleSessionsForUser now ALWAYS call .returning() (the duck-type guard
  // was removed), so the default must support it or a late/extra stale-sweep
  // call throws "reading 'returning' of undefined".
  mockDb.select.mockReset().mockReturnValue(mockSelectChain([]));
  mockDb.insert.mockReset().mockReturnValue(mockInsertNoReturn());
  mockDb.update.mockReset().mockReturnValue(mockUpdateReturning([]));
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
    mockAuthState.allowedSiteIds = undefined;
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
        } as any)
        // 5. createRemoteSession -> users.permissions_epoch revocation-lease
        // baseline (a desktop session without it would be unrenewable, so the
        // create 503s rather than mint one).
        .mockReturnValueOnce(mockSelectChain([{ permissionsEpoch: 1 }]));

      // 1. db.insert for session creation
      // 2. db.insert for audit log
      vi.mocked(db.insert)
        .mockReturnValueOnce(mockInsertReturning([session]))
        .mockReturnValueOnce(mockInsertNoReturn());

      // expireStaleSessions -> db.update (stale cleanup, now always .returning())
      // expireStaleSessionsForUser -> db.update (user stale cleanup, .returning())
      // terminate stale device+type sessions -> db.update (still guarded in sessions.ts)
      vi.mocked(db.update)
        .mockReturnValueOnce(mockUpdateReturning([]))
        .mockReturnValueOnce(mockUpdateReturning([]))
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

      // expireStaleSessions -> db.update (stale cleanup, now always .returning())
      vi.mocked(db.update)
        .mockReturnValueOnce(mockUpdateReturning([]));

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

    // Finding #1 (H5): the remote-access policy must be re-enforced at offer
    // time, not just at session creation. A viewer holding an existing,
    // still-in-flight session must NOT be able to (re)start a live stream after
    // the webrtcDesktop policy is revoked mid-session — and the denied offer must
    // not flip session status or leak a start_desktop command to the agent (GAP2).
    it('rejects the offer with 403 when remote-access policy is denied (mid-session revocation)', async () => {
      const sessionResult = {
        session: {
          id: SESSION_UUID,
          userId: 'user-123',
          status: 'active', // still in-flight — policy gate must fire BEFORE the status gate
          type: 'desktop',
          iceCandidates: []
        },
        device: { id: DEVICE_UUID, orgId: 'org-123', agentId: 'agent-abc123' }
      };

      // getSessionWithOrgCheck
      vi.mocked(db.select).mockReturnValueOnce(
        mockSelectInnerJoinChain([sessionResult])
      );
      // Policy was revoked mid-session → checkRemoteAccess denies.
      vi.mocked(checkRemoteAccess).mockResolvedValueOnce({
        allowed: false,
        reason: 'Remote desktop disabled by policy',
        policyName: 'Test Policy',
      } as any);

      // Clear before the request so a late async write or command leaked by a
      // prior test can't be miscounted against this denied offer.
      vi.mocked(db.update).mockClear();
      vi.mocked(sendCommandToAgent).mockClear();

      const res = await app.request(`/remote/sessions/${SESSION_UUID}/offer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ offer: 'offer-sdp' })
      });

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.code).toBe('REMOTE_ACCESS_POLICY_DENIED');
      expect(body.capability).toBe('webrtcDesktop');
      // The denied offer must NOT mutate the session (no resume of capture)
      // and must NOT leak a start_desktop command to the agent.
      expect(db.update).not.toHaveBeenCalled();
      expect(vi.mocked(sendCommandToAgent)).not.toHaveBeenCalled();
    });

    // Finding #5 (H5): an ended ('disconnected'/'failed') session must not be
    // resurrected to 'connecting' by a lingering offer/token — the client must
    // create a fresh session to reconnect.
    it('rejects the offer with 400 when the session is in a terminal (disconnected) state', async () => {
      const sessionResult = {
        session: {
          id: SESSION_UUID,
          userId: 'user-123',
          status: 'disconnected', // terminal — must not be flipped back to connecting
          type: 'desktop',
          iceCandidates: []
        },
        device: { id: DEVICE_UUID, orgId: 'org-123', agentId: 'agent-abc123' }
      };

      // getSessionWithOrgCheck (checkRemoteAccess stays allowed by default, so
      // we reach the status gate).
      vi.mocked(db.select).mockReturnValueOnce(
        mockSelectInnerJoinChain([sessionResult])
      );

      const res = await app.request(`/remote/sessions/${SESSION_UUID}/offer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ offer: 'offer-sdp' })
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('Cannot submit offer for session in current state');
      expect(body.status).toBe('disconnected');
      // A terminal session must not be resurrected.
      expect(db.update).not.toHaveBeenCalled();
    });
  });

  describe('capability routes inherit the parent permission context', () => {
    const cases = [
      ['ws-ticket', 'POST', `/remote/sessions/${SESSION_UUID}/ws-ticket`, undefined],
      ['desktop-connect-code', 'POST', `/remote/sessions/${SESSION_UUID}/desktop-connect-code`, undefined],
      ['ICE servers', 'GET', `/remote/ice-servers?sessionId=${SESSION_UUID}`, undefined],
      ['ICE candidate', 'POST', `/remote/sessions/${SESSION_UUID}/ice`, { candidate: { candidate: 'synthetic', sdpMid: '0', sdpMLineIndex: 0 } }],
    ] as const;

    it.each(cases)('%s enforces a live parent-loaded site ceiling before effects', async (_label, method, url, payload) => {
      const { createWsTicket, createDesktopConnectCode } = await import('../services/remoteSessionAuth');
      const session = { id: SESSION_UUID, type: 'desktop', status: 'active', userId: 'user-123', deviceId: DEVICE_UUID, orgId: 'org-123', iceCandidates: [] };
      const device = { id: DEVICE_UUID, orgId: 'org-123', siteId: 'site-allowed', status: 'online' };
      mockAuthState.allowedSiteIds = ['site-allowed'];
      const request = () => app.request(url, {
        method, headers: { 'Content-Type': 'application/json' },
        ...(payload ? { body: JSON.stringify(payload) } : {}),
      });
      vi.mocked(db.select).mockReturnValueOnce(mockSelectInnerJoinChain([{ session, device }]));
      vi.mocked(db.update).mockReturnValueOnce(mockUpdateReturning([{ id: SESSION_UUID, iceCandidates: [] }]));
      expect((await request()).status).toBe(200);

      vi.clearAllMocks();
      resetDbMocks();
      mockAuthState.allowedSiteIds = ['site-hidden'];
      vi.mocked(db.select).mockReturnValueOnce(mockSelectInnerJoinChain([{ session, device }]));
      const denial = await request();
      expect(denial.status).toBe(403);
      expect(await denial.json()).toEqual({ error: 'Access to this site denied' });
      expect(createWsTicket).not.toHaveBeenCalled();
      expect(createDesktopConnectCode).not.toHaveBeenCalled();
      expect(checkRemoteAccess).not.toHaveBeenCalled();
      expect(db.update).not.toHaveBeenCalled();
      expect(db.insert).not.toHaveBeenCalled();
      expect(sendCommandToAgent).not.toHaveBeenCalled();
    });
  });

  describe('GET /remote/ice-servers', () => {
    it('requires a sessionId so TURN credentials are session scoped', async () => {
      const res = await app.request('/remote/ice-servers');

      expect(res.status).toBe(400);
    });

    it('returns ICE servers for an active desktop session owned by the caller', async () => {
      const session = {
        id: SESSION_UUID,
        type: 'desktop',
        userId: 'user-123',
        status: 'active',
        deviceId: DEVICE_UUID,
        orgId: 'org-123',
        iceCandidates: []
      };
      const device = {
        id: DEVICE_UUID,
        orgId: 'org-123',
        status: 'online'
      };
      vi.mocked(db.select).mockReturnValueOnce(mockSelectInnerJoinChain([{ session, device }]));

      const res = await app.request(`/remote/ice-servers?sessionId=${SESSION_UUID}`);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.iceServers).toEqual(expect.any(Array));
    });

    it('rejects disconnected non-reconnectable terminal sessions', async () => {
      const session = {
        id: SESSION_UUID,
        type: 'terminal',
        userId: 'user-123',
        status: 'active',
        deviceId: DEVICE_UUID,
        orgId: 'org-123',
        iceCandidates: []
      };
      const device = {
        id: DEVICE_UUID,
        orgId: 'org-123',
        status: 'online'
      };
      vi.mocked(db.select).mockReturnValueOnce(mockSelectInnerJoinChain([{ session, device }]));

      const res = await app.request(`/remote/ice-servers?sessionId=${SESSION_UUID}`);

      expect(res.status).toBe(400);
    });
  });

  describe('retired user-authenticated endpoint verdict routes', () => {
    it.each([
      ['answer', { answer: 'answer-sdp', consentReason: 'user' }],
      ['deny', { reason: 'user' }],
    ])('does not let a session owner submit an agent %s verdict', async (route, body) => {
      // Fully rig the former handler's read/write chains. This makes the
      // regression fail against the affected baseline because an owned,
      // connecting session is otherwise accepted and mutated.
      vi.mocked(db.select).mockReturnValueOnce(mockSelectInnerJoinChain([{
        session: {
          id: SESSION_UUID,
          userId: 'user-123',
          status: 'connecting',
          type: 'desktop',
          iceCandidates: [],
        },
        device: { id: DEVICE_UUID, orgId: 'org-123', agentId: 'agent-123' },
      }]));
      vi.mocked(db.update).mockReturnValueOnce(mockUpdateReturning([{
        id: SESSION_UUID,
        status: route === 'answer' ? 'active' : 'denied',
        webrtcAnswer: route === 'answer' ? 'answer-sdp' : null,
        startedAt: new Date(),
        endedAt: new Date(),
      }]));
      vi.mocked(db.insert).mockReturnValueOnce(mockInsertNoReturn());

      const res = await app.request(`/remote/sessions/${SESSION_UUID}/${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify(body),
      });

      expect(res.status).toBe(404);
      expect(db.select).not.toHaveBeenCalled();
      expect(db.update).not.toHaveBeenCalled();
      expect(db.insert).not.toHaveBeenCalled();
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

  describe('POST /remote/sessions/:id/end', () => {
    function mockActiveSession() {
      vi.mocked(db.select).mockReturnValueOnce(
        mockSelectInnerJoinChain([
          {
            session: {
              id: SESSION_UUID,
              userId: 'user-123',
              status: 'active',
              type: 'desktop',
              startedAt: new Date('2026-05-02T10:00:00.000Z'),
              createdAt: new Date('2026-05-02T10:00:00.000Z'),
              bytesTransferred: BigInt(0),
              recordingUrl: null,
            },
            device: {
              id: DEVICE_UUID,
              orgId: 'org-123',
              hostname: 'host-1',
            },
          },
        ]),
      );
    }

    it.each([
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox(1)',
      '//evil.example.com/recording',
    ])('rejects unsafe recordingUrl %s', async (recordingUrl) => {
      mockActiveSession();

      const res = await app.request(`/remote/sessions/${SESSION_UUID}/end`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ recordingUrl }),
      });

      expect(res.status).toBe(400);
      expect(vi.mocked(db.update)).not.toHaveBeenCalled();
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

  // The resolver casts inlineSettings (untyped JSONB) through this schema before
  // anything reaches the agent. Valid input passes; malformed / out-of-range
  // input is rejected so the resolver falls back to safe DEFAULTS. (The real
  // remoteAccessPolicy module is mocked in this suite, so we exercise the schema
  // gate directly — it's the load-bearing piece of the resolver's safety.)
  describe('remoteAccessInlineSettingsSchema', () => {
    it('accepts a well-formed partial settings object', () => {
      const result = remoteAccessInlineSettingsSchema.safeParse({
        clipboardHostToViewer: false,
        clipboardViewerToHost: true,
        idleTimeoutMinutes: 10,
        maxSessionDurationHours: 4,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.clipboardHostToViewer).toBe(false);
        expect(result.data.idleTimeoutMinutes).toBe(10);
      }
    });

    it('accepts an empty object (all fields optional → merged over DEFAULTS)', () => {
      expect(remoteAccessInlineSettingsSchema.safeParse({}).success).toBe(true);
    });

    it('rejects a non-boolean clipboard flag', () => {
      const result = remoteAccessInlineSettingsSchema.safeParse({
        clipboardHostToViewer: 'yes',
      });
      expect(result.success).toBe(false);
    });

    it('rejects an out-of-range (negative) idle timeout', () => {
      expect(
        remoteAccessInlineSettingsSchema.safeParse({ idleTimeoutMinutes: -5 }).success
      ).toBe(false);
    });

    it('rejects an out-of-range (too large) max session duration', () => {
      // 169h exceeds the 168h (7 day) ceiling.
      expect(
        remoteAccessInlineSettingsSchema.safeParse({ maxSessionDurationHours: 169 }).success
      ).toBe(false);
    });

    it('allows the 0 sentinel but rejects negative maxSessionDurationHours', () => {
      expect(
        remoteAccessInlineSettingsSchema.safeParse({ maxSessionDurationHours: 0 }).success
      ).toBe(true);
      expect(
        remoteAccessInlineSettingsSchema.safeParse({ maxSessionDurationHours: -1 }).success
      ).toBe(false);
    });
  });
});
