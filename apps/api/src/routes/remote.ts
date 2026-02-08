import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, eq, sql, desc, gte, lte, inArray, or } from 'drizzle-orm';
import { db } from '../db';
import {
  remoteSessions,
  fileTransfers,
  devices,
  users,
  auditLogs
} from '../db/schema';
import { authMiddleware, requireScope } from '../middleware/auth';
import { sendCommandToAgent } from './agentWs';
import { createHmac } from 'crypto';
import { saveChunk, assembleChunks, getFileStream, getFileSize, hasAssembledFile, getTotalBytesReceived, MAX_TRANSFER_SIZE_BYTES } from '../services/fileStorage';
import { Readable } from 'stream';

export const remoteRoutes = new Hono();

// ============================================
// TURN CREDENTIAL GENERATION (RFC 5389 time-limited HMAC)
// ============================================

function generateTurnCredentials(): { username: string; credential: string } | null {
  const secret = process.env.TURN_SECRET;
  if (!secret) return null;

  const ttl = 86400; // 24 hours
  const expiry = Math.floor(Date.now() / 1000) + ttl;
  const username = `${expiry}:breeze`;
  const credential = createHmac('sha1', secret).update(username).digest('base64');

  return { username, credential };
}

function getIceServers(): Array<{ urls: string | string[]; username?: string; credential?: string }> {
  const servers: Array<{ urls: string | string[]; username?: string; credential?: string }> = [
    { urls: 'stun:stun.l.google.com:19302' }
  ];

  const turnHost = process.env.TURN_HOST;
  const turnPort = process.env.TURN_PORT || '3478';

  if (turnHost) {
    const creds = generateTurnCredentials();
    if (creds) {
      servers.push({
        urls: [
          `turn:${turnHost}:${turnPort}?transport=udp`,
          `turn:${turnHost}:${turnPort}?transport=tcp`
        ],
        username: creds.username,
        credential: creds.credential
      });
    }
  }

  return servers;
}

// ============================================
// HELPER FUNCTIONS
// ============================================

function getPagination(query: { page?: string; limit?: string }) {
  const page = Math.max(1, Number.parseInt(query.page ?? '1', 10) || 1);
  const limit = Math.min(100, Math.max(1, Number.parseInt(query.limit ?? '50', 10) || 50));
  return { page, limit, offset: (page - 1) * limit };
}

function hasSessionOrTransferOwnership(
  auth: { scope: string; user: { id: string } },
  ownerUserId: string
) {
  if (auth.scope === 'system') {
    return true;
  }
  return auth.user.id === ownerUserId;
}

function ensureOrgAccess(orgId: string, auth: { canAccessOrg: (orgId: string) => boolean }) {
  return auth.canAccessOrg(orgId);
}

async function getDeviceWithOrgCheck(deviceId: string, auth: { canAccessOrg: (orgId: string) => boolean }) {
  const [device] = await db
    .select()
    .from(devices)
    .where(eq(devices.id, deviceId))
    .limit(1);

  if (!device) {
    return null;
  }

  const hasAccess = ensureOrgAccess(device.orgId, auth);
  if (!hasAccess) {
    return null;
  }

  return device;
}

async function getSessionWithOrgCheck(sessionId: string, auth: { canAccessOrg: (orgId: string) => boolean }) {
  const [session] = await db
    .select({
      session: remoteSessions,
      device: devices
    })
    .from(remoteSessions)
    .innerJoin(devices, eq(remoteSessions.deviceId, devices.id))
    .where(eq(remoteSessions.id, sessionId))
    .limit(1);

  if (!session) {
    return null;
  }

  const hasAccess = ensureOrgAccess(session.device.orgId, auth);
  if (!hasAccess) {
    return null;
  }

  return session;
}

async function getTransferWithOrgCheck(transferId: string, auth: { canAccessOrg: (orgId: string) => boolean }) {
  const [transfer] = await db
    .select({
      transfer: fileTransfers,
      device: devices
    })
    .from(fileTransfers)
    .innerJoin(devices, eq(fileTransfers.deviceId, devices.id))
    .where(eq(fileTransfers.id, transferId))
    .limit(1);

  if (!transfer) {
    return null;
  }

  const hasAccess = ensureOrgAccess(transfer.device.orgId, auth);
  if (!hasAccess) {
    return null;
  }

  return transfer;
}

// Rate limiting helper - check concurrent sessions per org
async function checkSessionRateLimit(orgId: string, maxConcurrent: number = 10): Promise<{ allowed: boolean; currentCount: number }> {
  const countResult = await db
    .select({ count: sql<number>`count(*)` })
    .from(remoteSessions)
    .innerJoin(devices, eq(remoteSessions.deviceId, devices.id))
    .where(
      and(
        eq(devices.orgId, orgId),
        inArray(remoteSessions.status, ['pending', 'connecting', 'active'])
      )
    );

  const currentCount = Number(countResult[0]?.count ?? 0);
  return {
    allowed: currentCount < maxConcurrent,
    currentCount
  };
}

// Log audit event for session activity
async function logSessionAudit(
  action: string,
  actorId: string,
  orgId: string,
  details: Record<string, unknown>,
  ipAddress?: string
) {
  try {
    await db.insert(auditLogs).values({
      orgId,
      actorType: 'user',
      actorId,
      action,
      resourceType: 'remote_session',
      resourceId: details.sessionId as string,
      details,
      ipAddress,
      result: 'success'
    });
  } catch (error) {
    console.error('Failed to log session audit:', error);
  }
}

// ============================================
// VALIDATION SCHEMAS
// ============================================

// Session schemas
const createSessionSchema = z.object({
  deviceId: z.string().uuid(),
  type: z.enum(['terminal', 'desktop', 'file_transfer'])
});

const listSessionsSchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  deviceId: z.string().uuid().optional(),
  status: z.enum(['pending', 'connecting', 'active', 'disconnected', 'failed']).optional(),
  type: z.enum(['terminal', 'desktop', 'file_transfer']).optional(),
  includeEnded: z.enum(['true', 'false']).optional()
});

const sessionHistorySchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  deviceId: z.string().uuid().optional(),
  userId: z.string().uuid().optional(),
  type: z.enum(['terminal', 'desktop', 'file_transfer']).optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional()
});

const webrtcOfferSchema = z.object({
  offer: z.string().min(1).max(65536)
});

const webrtcAnswerSchema = z.object({
  answer: z.string().min(1).max(65536)
});

const iceCandidateSchema = z.object({
  candidate: z.object({
    candidate: z.string(),
    sdpMid: z.string().nullable().optional(),
    sdpMLineIndex: z.number().nullable().optional(),
    usernameFragment: z.string().nullable().optional()
  })
});

// File transfer schemas
const createTransferSchema = z.object({
  deviceId: z.string().uuid(),
  sessionId: z.string().uuid().optional(),
  direction: z.enum(['upload', 'download']),
  remotePath: z.string().min(1),
  localFilename: z.string().min(1),
  sizeBytes: z.number().int().min(0)
});

const listTransfersSchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  deviceId: z.string().uuid().optional(),
  status: z.enum(['pending', 'transferring', 'completed', 'failed']).optional(),
  direction: z.enum(['upload', 'download']).optional()
});

// ============================================
// APPLY AUTH MIDDLEWARE
// ============================================

remoteRoutes.use('*', authMiddleware);

// ============================================
// REMOTE SESSIONS ENDPOINTS
// ============================================

// DELETE /remote/sessions/stale - Cleanup stale sessions (dev only)
remoteRoutes.delete(
  '/sessions/stale',
  requireScope('system', 'partner'),
  async (c) => {
    const auth = c.get('auth');
    const activeStatuses: Array<'pending' | 'connecting' | 'active'> = ['pending', 'connecting', 'active'];

    let scopedSessionIds: string[] = [];

    if (auth.scope === 'partner') {
      const orgIds = auth.accessibleOrgIds ?? [];
      if (orgIds.length === 0) {
        return c.json({ cleaned: 0, ids: [] });
      }

      const partnerSessions = await db
        .select({ id: remoteSessions.id })
        .from(remoteSessions)
        .innerJoin(devices, eq(remoteSessions.deviceId, devices.id))
        .where(
          and(
            inArray(remoteSessions.status, activeStatuses),
            inArray(devices.orgId, orgIds)
          )
        );

      scopedSessionIds = partnerSessions.map((session) => session.id);
    } else {
      const allActiveSessions = await db
        .select({ id: remoteSessions.id })
        .from(remoteSessions)
        .where(inArray(remoteSessions.status, activeStatuses));

      scopedSessionIds = allActiveSessions.map((session) => session.id);
    }

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
remoteRoutes.post(
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
        maxAllowed: 10
      }, 429);
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
remoteRoutes.get(
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
remoteRoutes.get(
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
remoteRoutes.get(
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

// GET /remote/ice-servers - Get ICE server configuration (including TURN credentials)
remoteRoutes.get(
  '/ice-servers',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    return c.json({ iceServers: getIceServers() });
  }
);

// POST /remote/sessions/:id/offer - Submit WebRTC offer (from web client)
remoteRoutes.post(
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
        payload: { sessionId, offer: data.offer, iceServers: getIceServers() }
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
remoteRoutes.post(
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
remoteRoutes.post(
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
remoteRoutes.post(
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

// ============================================
// FILE TRANSFERS ENDPOINTS
// ============================================

// POST /remote/transfers - Initiate file transfer
remoteRoutes.post(
  '/transfers',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', createTransferSchema),
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

    // Verify session if provided
    if (data.sessionId) {
      const sessionResult = await getSessionWithOrgCheck(data.sessionId, auth);
      if (!sessionResult) {
        return c.json({ error: 'Session not found' }, 404);
      }
      if (sessionResult.session.status !== 'active') {
        return c.json({ error: 'Session is not active' }, 400);
      }
      if (!hasSessionOrTransferOwnership(auth, sessionResult.session.userId)) {
        return c.json({ error: 'Access denied' }, 403);
      }
    }

    // Create transfer record
    const [transfer] = await db
      .insert(fileTransfers)
      .values({
        sessionId: data.sessionId || null,
        deviceId: data.deviceId,
        userId: auth.user.id,
        direction: data.direction,
        remotePath: data.remotePath,
        localFilename: data.localFilename,
        sizeBytes: BigInt(data.sizeBytes),
        status: 'pending',
        progressPercent: 0
      })
      .returning();

    if (!transfer) {
      return c.json({ error: 'Failed to create transfer' }, 500);
    }

    // Log audit event
    await logSessionAudit(
      'file_transfer_initiated',
      auth.user.id,
      device.orgId,
      {
        transferId: transfer.id,
        deviceId: data.deviceId,
        deviceHostname: device.hostname,
        direction: data.direction,
        remotePath: data.remotePath,
        localFilename: data.localFilename,
        sizeBytes: data.sizeBytes
      },
      c.req.header('X-Forwarded-For') || c.req.header('X-Real-IP')
    );

    return c.json({
      id: transfer.id,
      sessionId: transfer.sessionId,
      deviceId: transfer.deviceId,
      userId: transfer.userId,
      direction: transfer.direction,
      remotePath: transfer.remotePath,
      localFilename: transfer.localFilename,
      sizeBytes: Number(transfer.sizeBytes),
      status: transfer.status,
      progressPercent: transfer.progressPercent,
      createdAt: transfer.createdAt,
      device: {
        id: device.id,
        hostname: device.hostname
      }
    }, 201);
  }
);

// GET /remote/transfers - List transfers
remoteRoutes.get(
  '/transfers',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', listTransfersSchema),
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
      conditions.push(eq(fileTransfers.userId, auth.user.id));
    }

    // Additional filters
    if (query.deviceId) {
      conditions.push(eq(fileTransfers.deviceId, query.deviceId));
    }

    if (query.status) {
      conditions.push(eq(fileTransfers.status, query.status));
    }

    if (query.direction) {
      conditions.push(eq(fileTransfers.direction, query.direction));
    }

    const whereCondition = conditions.length > 0 ? and(...conditions) : undefined;

    // Get total count
    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(fileTransfers)
      .innerJoin(devices, eq(fileTransfers.deviceId, devices.id))
      .where(whereCondition);
    const total = Number(countResult[0]?.count ?? 0);

    // Get transfers with device info
    const transfersList = await db
      .select({
        id: fileTransfers.id,
        sessionId: fileTransfers.sessionId,
        deviceId: fileTransfers.deviceId,
        userId: fileTransfers.userId,
        direction: fileTransfers.direction,
        remotePath: fileTransfers.remotePath,
        localFilename: fileTransfers.localFilename,
        sizeBytes: fileTransfers.sizeBytes,
        status: fileTransfers.status,
        progressPercent: fileTransfers.progressPercent,
        errorMessage: fileTransfers.errorMessage,
        createdAt: fileTransfers.createdAt,
        completedAt: fileTransfers.completedAt,
        deviceHostname: devices.hostname,
        userName: users.name
      })
      .from(fileTransfers)
      .innerJoin(devices, eq(fileTransfers.deviceId, devices.id))
      .leftJoin(users, eq(fileTransfers.userId, users.id))
      .where(whereCondition)
      .orderBy(desc(fileTransfers.createdAt))
      .limit(limit)
      .offset(offset);

    return c.json({
      data: transfersList.map(t => ({
        id: t.id,
        sessionId: t.sessionId,
        deviceId: t.deviceId,
        userId: t.userId,
        direction: t.direction,
        remotePath: t.remotePath,
        localFilename: t.localFilename,
        sizeBytes: Number(t.sizeBytes),
        status: t.status,
        progressPercent: t.progressPercent,
        errorMessage: t.errorMessage,
        createdAt: t.createdAt,
        completedAt: t.completedAt,
        device: { hostname: t.deviceHostname },
        user: { name: t.userName }
      })),
      pagination: { page, limit, total }
    });
  }
);

// GET /remote/transfers/:id - Get transfer details/progress
remoteRoutes.get(
  '/transfers/:id',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const transferId = c.req.param('id');

    const result = await getTransferWithOrgCheck(transferId, auth);
    if (!result) {
      return c.json({ error: 'Transfer not found' }, 404);
    }

    const { transfer, device } = result;
    if (!hasSessionOrTransferOwnership(auth, transfer.userId)) {
      return c.json({ error: 'Access denied' }, 403);
    }

    // Get user info
    const [user] = await db
      .select({ name: users.name, email: users.email })
      .from(users)
      .where(eq(users.id, transfer.userId))
      .limit(1);

    return c.json({
      id: transfer.id,
      sessionId: transfer.sessionId,
      deviceId: transfer.deviceId,
      userId: transfer.userId,
      direction: transfer.direction,
      remotePath: transfer.remotePath,
      localFilename: transfer.localFilename,
      sizeBytes: Number(transfer.sizeBytes),
      status: transfer.status,
      progressPercent: transfer.progressPercent,
      errorMessage: transfer.errorMessage,
      createdAt: transfer.createdAt,
      completedAt: transfer.completedAt,
      device: {
        id: device.id,
        hostname: device.hostname,
        osType: device.osType
      },
      user: user ? { name: user.name, email: user.email } : null
    });
  }
);

// POST /remote/transfers/:id/cancel - Cancel transfer
remoteRoutes.post(
  '/transfers/:id/cancel',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const transferId = c.req.param('id');

    const result = await getTransferWithOrgCheck(transferId, auth);
    if (!result) {
      return c.json({ error: 'Transfer not found' }, 404);
    }

    const { transfer, device } = result;
    if (!hasSessionOrTransferOwnership(auth, transfer.userId)) {
      return c.json({ error: 'Access denied' }, 403);
    }

    // Only allow cancelling pending or transferring transfers
    if (!['pending', 'transferring'].includes(transfer.status)) {
      return c.json({
        error: 'Cannot cancel transfer in current state',
        status: transfer.status
      }, 400);
    }

    const [updated] = await db
      .update(fileTransfers)
      .set({
        status: 'failed',
        errorMessage: 'Cancelled by user',
        completedAt: new Date()
      })
      .where(eq(fileTransfers.id, transferId))
      .returning();

    if (!updated) {
      return c.json({ error: 'Failed to update transfer' }, 500);
    }

    // Log audit event
    await logSessionAudit(
      'file_transfer_cancelled',
      auth.user.id,
      device.orgId,
      {
        transferId,
        deviceId: device.id,
        deviceHostname: device.hostname,
        direction: transfer.direction,
        remotePath: transfer.remotePath
      },
      c.req.header('X-Forwarded-For') || c.req.header('X-Real-IP')
    );

    return c.json({
      id: updated.id,
      status: updated.status,
      errorMessage: updated.errorMessage,
      completedAt: updated.completedAt
    });
  }
);

// POST /remote/transfers/:id/chunks - Upload a chunk (from agent, multipart)
remoteRoutes.post(
  '/transfers/:id/chunks',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const transferId = c.req.param('id');

    const result = await getTransferWithOrgCheck(transferId, auth);
    if (!result) {
      return c.json({ error: 'Transfer not found' }, 404);
    }

    const { transfer } = result;

    if (!['pending', 'transferring'].includes(transfer.status)) {
      return c.json({ error: 'Cannot upload chunks in current state', status: transfer.status }, 400);
    }

    // Parse multipart form data
    const formData = await c.req.formData();
    const chunkIndexStr = formData.get('chunkIndex');
    const chunkFile = formData.get('data');

    if (chunkIndexStr === null || !chunkFile) {
      return c.json({ error: 'Missing chunkIndex or data' }, 400);
    }

    const chunkIndex = parseInt(String(chunkIndexStr), 10);
    if (isNaN(chunkIndex) || chunkIndex < 0) {
      return c.json({ error: 'Invalid chunkIndex' }, 400);
    }

    let chunkData: Buffer;
    if (chunkFile instanceof File) {
      chunkData = Buffer.from(await chunkFile.arrayBuffer());
    } else {
      chunkData = Buffer.from(String(chunkFile));
    }

    // Check total size doesn't exceed limit
    const currentBytes = getTotalBytesReceived(transferId);
    if (currentBytes + chunkData.length > MAX_TRANSFER_SIZE_BYTES) {
      return c.json({ error: `Transfer exceeds maximum size of ${MAX_TRANSFER_SIZE_BYTES / (1024 * 1024)}MB` }, 413);
    }

    await saveChunk(transferId, chunkIndex, chunkData);

    // Update progress
    const totalReceived = currentBytes + chunkData.length;
    const sizeBytes = Number(transfer.sizeBytes);
    const progressPercent = sizeBytes > 0
      ? Math.min(100, Math.round((totalReceived / sizeBytes) * 100))
      : 0;

    const updates: Record<string, unknown> = {
      status: 'transferring',
      progressPercent
    };

    // If all bytes received, assemble and mark complete
    if (sizeBytes > 0 && totalReceived >= sizeBytes) {
      try {
        await assembleChunks(transferId);
        updates.status = 'completed';
        updates.progressPercent = 100;
        updates.completedAt = new Date();
      } catch (err) {
        updates.status = 'failed';
        updates.errorMessage = `Assembly failed: ${err instanceof Error ? err.message : 'unknown'}`;
      }
    }

    await db
      .update(fileTransfers)
      .set(updates)
      .where(eq(fileTransfers.id, transferId));

    return c.json({
      chunkIndex,
      bytesReceived: totalReceived,
      progressPercent: updates.progressPercent,
      status: updates.status
    });
  }
);

// GET /remote/transfers/:id/download - Download completed file (upload direction)
remoteRoutes.get(
  '/transfers/:id/download',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const transferId = c.req.param('id');

    const result = await getTransferWithOrgCheck(transferId, auth);
    if (!result) {
      return c.json({ error: 'Transfer not found' }, 404);
    }

    const { transfer } = result;
    if (!hasSessionOrTransferOwnership(auth, transfer.userId)) {
      return c.json({ error: 'Access denied' }, 403);
    }

    // Only allow download for completed upload transfers
    if (transfer.direction !== 'upload') {
      return c.json({ error: 'Can only download files from upload transfers' }, 400);
    }

    if (transfer.status !== 'completed') {
      return c.json({
        error: 'Transfer is not completed',
        status: transfer.status
      }, 400);
    }

    if (!hasAssembledFile(transferId)) {
      return c.json({ error: 'File not found in storage' }, 404);
    }

    const fileSize = getFileSize(transferId);
    const stream = getFileStream(transferId);
    if (!stream) {
      return c.json({ error: 'Failed to read file' }, 500);
    }

    // Convert Node.js Readable to a web ReadableStream
    const webStream = Readable.toWeb(stream) as ReadableStream;

    return new Response(webStream, {
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${encodeURIComponent(transfer.localFilename)}"`,
        'Content-Length': String(fileSize),
      },
    });
  }
);

// ============================================
// INTERNAL ENDPOINTS (for agent use)
// ============================================

// PATCH /remote/transfers/:id/progress - Update transfer progress (called by agent)
remoteRoutes.patch(
  '/transfers/:id/progress',
  requireScope('system'),
  async (c) => {
    const auth = c.get('auth');
    const transferId = c.req.param('id');
    const body = await c.req.json<{
      progressPercent?: number;
      status?: 'transferring' | 'completed' | 'failed';
      errorMessage?: string;
    }>();

    const result = await getTransferWithOrgCheck(transferId, auth);
    if (!result) {
      return c.json({ error: 'Transfer not found' }, 404);
    }

    const { transfer } = result;

    // Only allow updates for pending or transferring transfers
    if (!['pending', 'transferring'].includes(transfer.status)) {
      return c.json({
        error: 'Cannot update transfer in current state',
        status: transfer.status
      }, 400);
    }

    const updates: Record<string, unknown> = {};

    if (body.progressPercent !== undefined) {
      updates.progressPercent = Math.min(100, Math.max(0, body.progressPercent));
    }

    if (body.status) {
      updates.status = body.status;
      if (body.status === 'completed' || body.status === 'failed') {
        updates.completedAt = new Date();
      }
    }

    if (body.errorMessage) {
      updates.errorMessage = body.errorMessage;
    }

    if (Object.keys(updates).length === 0) {
      return c.json({ error: 'No updates provided' }, 400);
    }

    const [updated] = await db
      .update(fileTransfers)
      .set(updates)
      .where(eq(fileTransfers.id, transferId))
      .returning();

    if (!updated) {
      return c.json({ error: 'Failed to update transfer' }, 500);
    }

    return c.json({
      id: updated.id,
      status: updated.status,
      progressPercent: updated.progressPercent,
      completedAt: updated.completedAt
    });
  }
);
