import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, eq, sql, desc, gte, lte, inArray } from 'drizzle-orm';
import { db } from '../../db';
import {
  remoteSessions,
  devices,
  users
} from '../../db/schema';
import { requireScope } from '../../middleware/auth';
import { sendCommandToAgent } from '../agentWs';
import { createDesktopConnectCode, createWsTicket } from '../../services/remoteSessionAuth';
import {
  createSessionSchema,
  listSessionsSchema,
  sessionHistorySchema,
  webrtcOfferSchema,
  webrtcAnswerSchema,
  iceCandidateSchema
} from './schemas';
import {
  getPagination,
  getIceServers,
  getDeviceWithOrgCheck,
  getSessionWithOrgCheck,
  hasSessionOrTransferOwnership,
  checkSessionRateLimit,
  checkUserSessionRateLimit,
  logSessionAudit,
  MAX_ACTIVE_REMOTE_SESSIONS_PER_ORG,
  MAX_ACTIVE_REMOTE_SESSIONS_PER_USER
} from './helpers';

export const sessionRoutes = new Hono();

// DELETE /remote/sessions/stale - Cleanup stale sessions, optionally scoped to a device
sessionRoutes.delete(
  '/sessions/stale',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const deviceId = c.req.query('deviceId');
    const activeStatuses: Array<'pending' | 'connecting' | 'active'> = ['pending', 'connecting', 'active'];

    const conditions: ReturnType<typeof eq>[] = [
      inArray(remoteSessions.status, activeStatuses)
    ];

    // Scope by device if specified
    if (deviceId) {
      const device = await getDeviceWithOrgCheck(deviceId, auth);
      if (!device) {
        return c.json({ error: 'Device not found or access denied' }, 404);
      }
      conditions.push(eq(remoteSessions.deviceId, deviceId));
    }

    // Scope by org access
    if (auth.scope === 'organization') {
      if (!auth.orgId) {
        return c.json({ error: 'Organization context required' }, 403);
      }
      conditions.push(eq(devices.orgId, auth.orgId));
    } else if (auth.scope === 'partner') {
      const orgIds = auth.accessibleOrgIds ?? [];
      if (orgIds.length === 0) {
        return c.json({ cleaned: 0, ids: [] });
      }
      conditions.push(inArray(devices.orgId, orgIds));
    }

    const staleSessions = await db
      .select({ id: remoteSessions.id })
      .from(remoteSessions)
      .innerJoin(devices, eq(remoteSessions.deviceId, devices.id))
      .where(and(...conditions));

    const scopedSessionIds = staleSessions.map((session) => session.id);

    if (scopedSessionIds.length === 0) {
      return c.json({ cleaned: 0, ids: [] });
    }

    const result = await db
      .update(remoteSessions)
      .set({ status: 'disconnected', endedAt: new Date() })
      .where(inArray(remoteSessions.id, scopedSessionIds))
      .returning({ id: remoteSessions.id });

    return c.json({ cleaned: result.length, ids: result.map(r => r.id) });
  }
);

// POST /remote/sessions - Initiate remote session
sessionRoutes.post(
  '/sessions',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', createSessionSchema),
  async (c) => {
    const auth = c.get('auth');
    const data = c.req.valid('json');

    // Verify device access
    const device = await getDeviceWithOrgCheck(data.deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found or access denied' }, 404);
    }

    // Check device is online
    if (device.status !== 'online') {
      return c.json({ error: 'Device is not online', deviceStatus: device.status }, 400);
    }

    // Check rate limit for org
    const rateLimit = await checkSessionRateLimit(device.orgId);
    if (!rateLimit.allowed) {
      return c.json({
        error: 'Maximum concurrent sessions reached for this organization',
        currentCount: rateLimit.currentCount,
        maxAllowed: MAX_ACTIVE_REMOTE_SESSIONS_PER_ORG
      }, 429);
    }

    // Guardrail: cap concurrent sessions per user to reduce blast radius of a compromised account.
    if (auth.scope !== 'system') {
      const userLimit = await checkUserSessionRateLimit(auth.user.id);
      if (!userLimit.allowed) {
        return c.json({
          error: 'Maximum concurrent sessions reached for this user',
          currentCount: userLimit.currentCount,
          maxAllowed: MAX_ACTIVE_REMOTE_SESSIONS_PER_USER
        }, 429);
      }
    }

    // Create session
    const [session] = await db
      .insert(remoteSessions)
      .values({
        deviceId: data.deviceId,
        userId: auth.user.id,
        type: data.type,
        status: 'pending',
        iceCandidates: []
      })
      .returning();

    if (!session) {
      return c.json({ error: 'Failed to create session' }, 500);
    }

    // Log audit event
    await logSessionAudit(
      'session_initiated',
      auth.user.id,
      device.orgId,
      {
        sessionId: session.id,
        deviceId: data.deviceId,
        deviceHostname: device.hostname,
        type: data.type
      },
      c.req.header('X-Forwarded-For') || c.req.header('X-Real-IP')
    );

    return c.json({
      id: session.id,
      deviceId: session.deviceId,
      userId: session.userId,
      type: session.type,
      status: session.status,
      createdAt: session.createdAt,
      device: {
        id: device.id,
        hostname: device.hostname,
        osType: device.osType
      }
    }, 201);
  }
);

// GET /remote/sessions - List active/recent sessions
sessionRoutes.get(
  '/sessions',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', listSessionsSchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const { page, limit, offset } = getPagination(query);

    // Build conditions array
    const conditions: ReturnType<typeof eq>[] = [];

    // Filter by org access based on scope
    if (auth.scope === 'organization') {
    if (!auth.orgId) {
      return c.json({ error: 'Organization context required' }, 403);
    }
    conditions.push(eq(devices.orgId, auth.orgId));
  } else if (auth.scope === 'partner') {
    const orgIds = auth.accessibleOrgIds ?? [];
    if (orgIds.length === 0) {
      return c.json({
        data: [],
        pagination: { page, limit, total: 0 }
      });
    }
    conditions.push(inArray(devices.orgId, orgIds));
    }

    if (auth.scope !== 'system') {
      conditions.push(eq(remoteSessions.userId, auth.user.id));
    }

    // Additional filters
    if (query.deviceId) {
      conditions.push(eq(remoteSessions.deviceId, query.deviceId));
    }

    if (query.status) {
      conditions.push(eq(remoteSessions.status, query.status));
    }

    if (query.type) {
      conditions.push(eq(remoteSessions.type, query.type));
    }

    // By default, only show active sessions unless includeEnded is true
    if (query.includeEnded !== 'true') {
      conditions.push(
        inArray(remoteSessions.status, ['pending', 'connecting', 'active'])
      );
    }

    const whereCondition = conditions.length > 0 ? and(...conditions) : undefined;

    // Get total count
    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(remoteSessions)
      .innerJoin(devices, eq(remoteSessions.deviceId, devices.id))
      .where(whereCondition);
    const total = Number(countResult[0]?.count ?? 0);

    // Get sessions with device and user info
    const sessionsList = await db
      .select({
        id: remoteSessions.id,
        deviceId: remoteSessions.deviceId,
        userId: remoteSessions.userId,
        type: remoteSessions.type,
        status: remoteSessions.status,
        startedAt: remoteSessions.startedAt,
        endedAt: remoteSessions.endedAt,
        durationSeconds: remoteSessions.durationSeconds,
        bytesTransferred: remoteSessions.bytesTransferred,
        createdAt: remoteSessions.createdAt,
        deviceHostname: devices.hostname,
        deviceOsType: devices.osType,
        userName: users.name,
        userEmail: users.email
      })
      .from(remoteSessions)
      .innerJoin(devices, eq(remoteSessions.deviceId, devices.id))
      .leftJoin(users, eq(remoteSessions.userId, users.id))
      .where(whereCondition)
      .orderBy(desc(remoteSessions.createdAt))
      .limit(limit)
      .offset(offset);

    return c.json({
      data: sessionsList.map(s => ({
        id: s.id,
        deviceId: s.deviceId,
        userId: s.userId,
        type: s.type,
        status: s.status,
        startedAt: s.startedAt,
        endedAt: s.endedAt,
        durationSeconds: s.durationSeconds,
        bytesTransferred: s.bytesTransferred ? Number(s.bytesTransferred) : null,
        createdAt: s.createdAt,
        device: {
          hostname: s.deviceHostname,
          osType: s.deviceOsType
        },
        user: {
          name: s.userName,
          email: s.userEmail
        }
      })),
      pagination: { page, limit, total }
    });
  }
);

// GET /remote/sessions/history - Session history with duration stats
sessionRoutes.get(
  '/sessions/history',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', sessionHistorySchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const { page, limit, offset } = getPagination(query);

    // Build conditions array
    const conditions: ReturnType<typeof eq>[] = [];

    // Filter by org access based on scope
    if (auth.scope === 'organization') {
    if (!auth.orgId) {
      return c.json({ error: 'Organization context required' }, 403);
    }
    conditions.push(eq(devices.orgId, auth.orgId));
  } else if (auth.scope === 'partner') {
    const orgIds = auth.accessibleOrgIds ?? [];
    if (orgIds.length === 0) {
      return c.json({
        data: [],
        pagination: { page, limit, total: 0 },
        stats: { totalSessions: 0, totalDurationSeconds: 0, avgDurationSeconds: 0 }
      });
    }
    conditions.push(inArray(devices.orgId, orgIds));
    }

    if (auth.scope !== 'system') {
      conditions.push(eq(remoteSessions.userId, auth.user.id));
    }

    // Additional filters
    if (query.deviceId) {
      conditions.push(eq(remoteSessions.deviceId, query.deviceId));
    }

    if (query.userId) {
      if (auth.scope !== 'system' && query.userId !== auth.user.id) {
        return c.json({ error: 'Access denied' }, 403);
      }
      conditions.push(eq(remoteSessions.userId, query.userId));
    }

    if (query.type) {
      conditions.push(eq(remoteSessions.type, query.type));
    }

    if (query.startDate) {
      conditions.push(gte(remoteSessions.createdAt, new Date(query.startDate)));
    }

    if (query.endDate) {
      conditions.push(lte(remoteSessions.createdAt, new Date(query.endDate)));
    }

    // Only include completed sessions in history
    conditions.push(
      inArray(remoteSessions.status, ['disconnected', 'failed'])
    );

    const whereCondition = conditions.length > 0 ? and(...conditions) : undefined;

    // Get total count and stats
    const countResult = await db
      .select({
        count: sql<number>`count(*)`,
        totalDuration: sql<number>`COALESCE(SUM(${remoteSessions.durationSeconds}), 0)`,
        avgDuration: sql<number>`COALESCE(AVG(${remoteSessions.durationSeconds}), 0)`
      })
      .from(remoteSessions)
      .innerJoin(devices, eq(remoteSessions.deviceId, devices.id))
      .where(whereCondition);

    const total = Number(countResult[0]?.count ?? 0);
    const totalDurationSeconds = Number(countResult[0]?.totalDuration ?? 0);
    const avgDurationSeconds = Number(countResult[0]?.avgDuration ?? 0);

    // Get sessions with device and user info
    const sessionsList = await db
      .select({
        id: remoteSessions.id,
        deviceId: remoteSessions.deviceId,
        userId: remoteSessions.userId,
        type: remoteSessions.type,
        status: remoteSessions.status,
        startedAt: remoteSessions.startedAt,
        endedAt: remoteSessions.endedAt,
        durationSeconds: remoteSessions.durationSeconds,
        bytesTransferred: remoteSessions.bytesTransferred,
        recordingUrl: remoteSessions.recordingUrl,
        createdAt: remoteSessions.createdAt,
        deviceHostname: devices.hostname,
        deviceOsType: devices.osType,
        userName: users.name,
        userEmail: users.email
      })
      .from(remoteSessions)
      .innerJoin(devices, eq(remoteSessions.deviceId, devices.id))
      .leftJoin(users, eq(remoteSessions.userId, users.id))
      .where(whereCondition)
      .orderBy(desc(remoteSessions.createdAt))
      .limit(limit)
      .offset(offset);

    return c.json({
      data: sessionsList.map(s => ({
        id: s.id,
        deviceId: s.deviceId,
        userId: s.userId,
        type: s.type,
        status: s.status,
        startedAt: s.startedAt,
        endedAt: s.endedAt,
        durationSeconds: s.durationSeconds,
        bytesTransferred: s.bytesTransferred ? Number(s.bytesTransferred) : null,
        recordingUrl: s.recordingUrl,
        createdAt: s.createdAt,
        device: {
          hostname: s.deviceHostname,
          osType: s.deviceOsType
        },
        user: {
          name: s.userName,
          email: s.userEmail
        }
      })),
      pagination: { page, limit, total },
      stats: {
        totalSessions: total,
        totalDurationSeconds,
        avgDurationSeconds: Math.round(avgDurationSeconds)
      }
    });
  }
);

// GET /remote/sessions/:id - Get session details
sessionRoutes.get(
  '/sessions/:id',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const sessionId = c.req.param('id');

    // Skip reserved routes
    if (['history'].includes(sessionId)) {
      return c.notFound();
    }

    const result = await getSessionWithOrgCheck(sessionId, auth);
    if (!result) {
      return c.json({ error: 'Session not found' }, 404);
    }

    const { session, device } = result;
    if (!hasSessionOrTransferOwnership(auth, session.userId)) {
      return c.json({ error: 'Access denied' }, 403);
    }

    // Get user info
    const [user] = await db
      .select({ name: users.name, email: users.email })
      .from(users)
      .where(eq(users.id, session.userId))
      .limit(1);

    return c.json({
      id: session.id,
      deviceId: session.deviceId,
      userId: session.userId,
      type: session.type,
      status: session.status,
      webrtcOffer: session.webrtcOffer,
      webrtcAnswer: session.webrtcAnswer,
      iceCandidates: session.iceCandidates,
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      durationSeconds: session.durationSeconds,
      bytesTransferred: session.bytesTransferred ? Number(session.bytesTransferred) : null,
      recordingUrl: session.recordingUrl,
      createdAt: session.createdAt,
      device: {
        id: device.id,
        hostname: device.hostname,
        osType: device.osType,
        status: device.status
      },
      user: user ? { name: user.name, email: user.email } : null
    });
  }
);

// POST /remote/sessions/:id/ws-ticket - Mint one-time WS ticket for terminal/desktop sessions
sessionRoutes.post(
  '/sessions/:id/ws-ticket',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const sessionId = c.req.param('id');

    const result = await getSessionWithOrgCheck(sessionId, auth);
    if (!result) {
      return c.json({ error: 'Session not found' }, 404);
    }

    const { session } = result;
    if (!hasSessionOrTransferOwnership(auth, session.userId)) {
      return c.json({ error: 'Access denied' }, 403);
    }

    if (session.type !== 'terminal' && session.type !== 'desktop') {
      return c.json({ error: 'WebSocket ticket only supported for terminal or desktop sessions' }, 400);
    }

    if (!['pending', 'connecting', 'active'].includes(session.status)) {
      return c.json({
        error: 'Cannot mint WebSocket ticket for session in current state',
        status: session.status
      }, 400);
    }

    try {
      const ticket = await createWsTicket({
        sessionId: session.id,
        sessionType: session.type,
        userId: auth.user.id
      });
      return c.json(ticket);
    } catch (error) {
      console.error('[remote] Failed to create WS ticket:', error);
      return c.json({ error: 'Unable to create WebSocket ticket. Please try again later.' }, 503);
    }
  }
);

// POST /remote/sessions/:id/desktop-connect-code - Mint one-time desktop connect code for deep links
sessionRoutes.post(
  '/sessions/:id/desktop-connect-code',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const sessionId = c.req.param('id');

    const result = await getSessionWithOrgCheck(sessionId, auth);
    if (!result) {
      return c.json({ error: 'Session not found' }, 404);
    }

    const { session } = result;
    if (!hasSessionOrTransferOwnership(auth, session.userId)) {
      return c.json({ error: 'Access denied' }, 403);
    }

    if (session.type !== 'desktop') {
      return c.json({ error: 'Desktop connect code only supported for desktop sessions' }, 400);
    }

    if (!['pending', 'connecting', 'active'].includes(session.status)) {
      return c.json({
        error: 'Cannot mint desktop connect code for session in current state',
        status: session.status
      }, 400);
    }

    try {
      const code = await createDesktopConnectCode({
        sessionId: session.id,
        userId: auth.user.id,
        tokenPayload: {
          sub: auth.user.id,
          email: auth.user.email,
          roleId: auth.token.roleId,
          orgId: auth.token.orgId,
          partnerId: auth.token.partnerId,
          scope: auth.token.scope,
          mfa: auth.token.mfa
        }
      });

      return c.json(code);
    } catch (error) {
      console.error('[remote] Failed to create desktop connect code:', error);
      return c.json({ error: 'Unable to create desktop connect code. Please try again later.' }, 503);
    }
  }
);

// GET /remote/ice-servers - Get ICE server configuration (including TURN credentials)
sessionRoutes.get(
  '/ice-servers',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    return c.json({ iceServers: getIceServers() });
  }
);

// POST /remote/sessions/:id/offer - Submit WebRTC offer (from web client)
sessionRoutes.post(
  '/sessions/:id/offer',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', webrtcOfferSchema),
  async (c) => {
    const auth = c.get('auth');
    const sessionId = c.req.param('id');
    const data = c.req.valid('json');

    const result = await getSessionWithOrgCheck(sessionId, auth);
    if (!result) {
      return c.json({ error: 'Session not found' }, 404);
    }

    const { session, device } = result;
    if (!hasSessionOrTransferOwnership(auth, session.userId)) {
      return c.json({ error: 'Access denied' }, 403);
    }

    // Only allow offer in pending or connecting state
    if (!['pending', 'connecting'].includes(session.status)) {
      return c.json({
        error: 'Cannot submit offer for session in current state',
        status: session.status
      }, 400);
    }

    const [updated] = await db
      .update(remoteSessions)
      .set({
        webrtcOffer: data.offer,
        status: 'connecting'
      })
      .where(eq(remoteSessions.id, sessionId))
      .returning();

    if (!updated) {
      return c.json({ error: 'Failed to update session' }, 500);
    }

    // Log audit event
    await logSessionAudit(
      'session_offer_submitted',
      auth.user.id,
      device.orgId,
      { sessionId, type: session.type },
      c.req.header('X-Forwarded-For') || c.req.header('X-Real-IP')
    );

    // Send start_desktop command to agent with the offer and ICE servers
    // The agent will create a pion PeerConnection and return the answer
    let agentReachable = false;
    if (device.agentId) {
      agentReachable = sendCommandToAgent(device.agentId, {
        id: `desk-${sessionId}`,
        type: 'start_desktop',
        payload: { sessionId, offer: data.offer, iceServers: getIceServers(), ...(data.displayIndex != null ? { displayIndex: data.displayIndex } : {}) }
      });
      if (!agentReachable) {
        console.warn(`[Remote] Agent ${device.agentId} not connected, cannot send start_desktop for session ${sessionId}`);
      }
    }

    return c.json({
      id: updated.id,
      status: updated.status,
      webrtcOffer: updated.webrtcOffer,
      ...(agentReachable ? {} : { warning: 'Agent is not currently connected; the offer will be delivered when it reconnects' })
    });
  }
);

// POST /remote/sessions/:id/answer - Submit WebRTC answer (from agent)
sessionRoutes.post(
  '/sessions/:id/answer',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', webrtcAnswerSchema),
  async (c) => {
    const auth = c.get('auth');
    const sessionId = c.req.param('id');
    const data = c.req.valid('json');

    const result = await getSessionWithOrgCheck(sessionId, auth);
    if (!result) {
      return c.json({ error: 'Session not found' }, 404);
    }

    const { session, device } = result;
    if (!hasSessionOrTransferOwnership(auth, session.userId)) {
      return c.json({ error: 'Access denied' }, 403);
    }

    // Only allow answer in connecting state
    if (session.status !== 'connecting') {
      return c.json({
        error: 'Cannot submit answer for session in current state',
        status: session.status
      }, 400);
    }

    const [updated] = await db
      .update(remoteSessions)
      .set({
        webrtcAnswer: data.answer,
        status: 'active',
        startedAt: new Date()
      })
      .where(eq(remoteSessions.id, sessionId))
      .returning();

    if (!updated) {
      return c.json({ error: 'Failed to update session' }, 500);
    }

    // Log audit event
    await logSessionAudit(
      'session_connected',
      auth.user.id,
      device.orgId,
      { sessionId, type: session.type },
      c.req.header('X-Forwarded-For') || c.req.header('X-Real-IP')
    );

    return c.json({
      id: updated.id,
      status: updated.status,
      webrtcAnswer: updated.webrtcAnswer,
      startedAt: updated.startedAt
    });
  }
);

// POST /remote/sessions/:id/ice - Add ICE candidate
sessionRoutes.post(
  '/sessions/:id/ice',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', iceCandidateSchema),
  async (c) => {
    const auth = c.get('auth');
    const sessionId = c.req.param('id');
    const data = c.req.valid('json');

    const result = await getSessionWithOrgCheck(sessionId, auth);
    if (!result) {
      return c.json({ error: 'Session not found' }, 404);
    }

    const { session } = result;
    if (!hasSessionOrTransferOwnership(auth, session.userId)) {
      return c.json({ error: 'Access denied' }, 403);
    }

    // Only allow ICE candidates in connecting or active state
    if (!['connecting', 'active'].includes(session.status)) {
      return c.json({
        error: 'Cannot add ICE candidate for session in current state',
        status: session.status
      }, 400);
    }

    // Append ICE candidate to array
    const currentCandidates = (session.iceCandidates as unknown[]) || [];
    const updatedCandidates = [...currentCandidates, data.candidate];

    const [updated] = await db
      .update(remoteSessions)
      .set({
        iceCandidates: updatedCandidates
      })
      .where(eq(remoteSessions.id, sessionId))
      .returning();

    if (!updated) {
      return c.json({ error: 'Failed to update session' }, 500);
    }

    return c.json({
      id: updated.id,
      iceCandidatesCount: (updated.iceCandidates as unknown[]).length
    });
  }
);

// POST /remote/sessions/:id/end - End session
sessionRoutes.post(
  '/sessions/:id/end',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const sessionId = c.req.param('id');
    const body = await c.req.json<{ bytesTransferred?: number; recordingUrl?: string }>().catch(() => ({}));

    const result = await getSessionWithOrgCheck(sessionId, auth);
    if (!result) {
      return c.json({ error: 'Session not found' }, 404);
    }

    const { session, device } = result;
    if (!hasSessionOrTransferOwnership(auth, session.userId)) {
      return c.json({ error: 'Access denied' }, 403);
    }

    // Don't allow ending already ended sessions
    if (['disconnected', 'failed'].includes(session.status)) {
      return c.json({
        error: 'Session is already ended',
        status: session.status
      }, 400);
    }

    const endedAt = new Date();
    const startedAt = session.startedAt || session.createdAt;
    const durationSeconds = Math.round((endedAt.getTime() - startedAt.getTime()) / 1000);

    // Type guard for body properties
    const typedBody = body as { bytesTransferred?: number; recordingUrl?: string };

    const [updated] = await db
      .update(remoteSessions)
      .set({
        status: 'disconnected',
        endedAt,
        durationSeconds,
        bytesTransferred: typedBody.bytesTransferred !== undefined ? BigInt(typedBody.bytesTransferred) : session.bytesTransferred,
        recordingUrl: typedBody.recordingUrl || session.recordingUrl
      })
      .where(eq(remoteSessions.id, sessionId))
      .returning();

    if (!updated) {
      return c.json({ error: 'Failed to update session' }, 500);
    }

    // Log audit event
    await logSessionAudit(
      'session_ended',
      auth.user.id,
      device.orgId,
      {
        sessionId,
        deviceId: device.id,
        deviceHostname: device.hostname,
        type: session.type,
        durationSeconds
      },
      c.req.header('X-Forwarded-For') || c.req.header('X-Real-IP')
    );

    return c.json({
      id: updated.id,
      status: updated.status,
      endedAt: updated.endedAt,
      durationSeconds: updated.durationSeconds,
      bytesTransferred: updated.bytesTransferred ? Number(updated.bytesTransferred) : null
    });
  }
);
