import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, eq, sql, desc, gte, lte, inArray, or } from 'drizzle-orm';
import { db } from '../db';
import {
  remoteSessions,
  fileTransfers,
  devices,
  organizations,
  users,
  auditLogs
} from '../db/schema';
import { authMiddleware, requireScope } from '../middleware/auth';

export const remoteRoutes = new Hono();

// ============================================
// HELPER FUNCTIONS
// ============================================

function getPagination(query: { page?: string; limit?: string }) {
  const page = Math.max(1, Number.parseInt(query.page ?? '1', 10) || 1);
  const limit = Math.min(100, Math.max(1, Number.parseInt(query.limit ?? '50', 10) || 50));
  return { page, limit, offset: (page - 1) * limit };
}

async function ensureOrgAccess(orgId: string, auth: { scope: string; partnerId: string | null; orgId: string | null }) {
  if (auth.scope === 'organization') {
    return auth.orgId === orgId;
  }

  if (auth.scope === 'partner') {
    const [org] = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(
        and(
          eq(organizations.id, orgId),
          eq(organizations.partnerId, auth.partnerId as string)
        )
      )
      .limit(1);

    return Boolean(org);
  }

  // system scope has access to all
  return true;
}

async function getDeviceWithOrgCheck(deviceId: string, auth: { scope: string; partnerId: string | null; orgId: string | null }) {
  const [device] = await db
    .select()
    .from(devices)
    .where(eq(devices.id, deviceId))
    .limit(1);

  if (!device) {
    return null;
  }

  const hasAccess = await ensureOrgAccess(device.orgId, auth);
  if (!hasAccess) {
    return null;
  }

  return device;
}

async function getSessionWithOrgCheck(sessionId: string, auth: { scope: string; partnerId: string | null; orgId: string | null }) {
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

  const hasAccess = await ensureOrgAccess(session.device.orgId, auth);
  if (!hasAccess) {
    return null;
  }

  return session;
}

async function getTransferWithOrgCheck(transferId: string, auth: { scope: string; partnerId: string | null; orgId: string | null }) {
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

  const hasAccess = await ensureOrgAccess(transfer.device.orgId, auth);
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
  offer: z.string().min(1)
});

const webrtcAnswerSchema = z.object({
  answer: z.string().min(1)
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
      const partnerOrgs = await db
        .select({ id: organizations.id })
        .from(organizations)
        .where(eq(organizations.partnerId, auth.partnerId as string));

      const orgIds = partnerOrgs.map(o => o.id);
      if (orgIds.length === 0) {
        return c.json({
          data: [],
          pagination: { page, limit, total: 0 }
        });
      }
      conditions.push(inArray(devices.orgId, orgIds));
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
      const partnerOrgs = await db
        .select({ id: organizations.id })
        .from(organizations)
        .where(eq(organizations.partnerId, auth.partnerId as string));

      const orgIds = partnerOrgs.map(o => o.id);
      if (orgIds.length === 0) {
        return c.json({
          data: [],
          pagination: { page, limit, total: 0 },
          stats: { totalSessions: 0, totalDurationSeconds: 0, avgDurationSeconds: 0 }
        });
      }
      conditions.push(inArray(devices.orgId, orgIds));
    }

    // Additional filters
    if (query.deviceId) {
      conditions.push(eq(remoteSessions.deviceId, query.deviceId));
    }

    if (query.userId) {
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

    return c.json({
      id: updated.id,
      status: updated.status,
      webrtcOffer: updated.webrtcOffer
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
      const partnerOrgs = await db
        .select({ id: organizations.id })
        .from(organizations)
        .where(eq(organizations.partnerId, auth.partnerId as string));

      const orgIds = partnerOrgs.map(o => o.id);
      if (orgIds.length === 0) {
        return c.json({
          data: [],
          pagination: { page, limit, total: 0 }
        });
      }
      conditions.push(inArray(devices.orgId, orgIds));
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

    // In a real implementation, this would stream the file from storage
    // For now, return a placeholder response with download metadata
    return c.json({
      id: transfer.id,
      filename: transfer.localFilename,
      sizeBytes: Number(transfer.sizeBytes),
      // downloadUrl would point to actual file storage (S3, etc.)
      downloadUrl: `/api/storage/transfers/${transfer.id}/file`,
      expiresAt: new Date(Date.now() + 3600000).toISOString() // 1 hour expiry
    });
  }
);

// ============================================
// INTERNAL ENDPOINTS (for agent use)
// ============================================

// PATCH /remote/transfers/:id/progress - Update transfer progress (called by agent)
remoteRoutes.patch(
  '/transfers/:id/progress',
  requireScope('organization', 'partner', 'system'),
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
