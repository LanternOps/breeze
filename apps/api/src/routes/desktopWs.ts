import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import type { WSContext } from 'hono/ws';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../db';
import { remoteSessions, devices, users } from '../db/schema';
import { createViewerAccessToken, verifyViewerAccessToken } from '../services/jwt';
import { createWsTicket, consumeDesktopConnectCode, consumeWsTicket, getViewerAccessTokenExpirySeconds } from '../services/remoteSessionAuth';
import { getIceServers, logSessionAudit } from './remote/helpers';
import { webrtcOfferSchema } from './remote/schemas';
import { sendCommandToAgent, isAgentConnected } from './agentWs';
import { checkRemoteAccess } from '../services/remoteAccessPolicy';
import { getRedis } from '../services/redis';
import { rateLimiter } from '../services/rate-limit';
import { getTrustedClientIp } from '../services/clientIp';

// Brief cache for exchange results so duplicate calls (e.g. React effect re-fire)
// return the same token instead of 401 after the one-time code is consumed.
const exchangeCache = new Map<string, { result: { accessToken: string; expiresInSeconds: number; hostname: string | null; osType: string | null }; expiresAt: number }>();
const EXCHANGE_CACHE_TTL_MS = 30_000; // 30 seconds

// Zod validation for desktop user messages
const desktopInputEvent = z.object({
  type: z.enum(['mousemove', 'mousedown', 'mouseup', 'keydown', 'keyup', 'wheel', 'click', 'dblclick', 'mouse_move', 'mouse_down', 'mouse_up', 'key_down', 'key_up']),
  x: z.number().min(-10000).max(100000).optional(),
  y: z.number().min(-10000).max(100000).optional(),
  button: z.union([z.string().max(20), z.number().int().min(0).max(4)]).optional(),
  key: z.string().max(50).optional(),
  modifiers: z.union([
    z.array(z.string().max(20)).max(4),
    z.object({
      ctrl: z.boolean().optional(),
      alt: z.boolean().optional(),
      shift: z.boolean().optional(),
      meta: z.boolean().optional(),
    }),
  ]).optional(),
  delta: z.number().optional(),
  deltaX: z.number().optional(),
  deltaY: z.number().optional(),
  code: z.string().max(50).optional(),
});

const desktopMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('input'), event: desktopInputEvent }),
  z.object({
    type: z.literal('config'),
    quality: z.number().int().min(1).max(100).optional(),
    scaleFactor: z.number().min(0.1).max(2).optional(),
    maxFps: z.number().int().min(1).max(60).optional(),
  }),
  z.object({ type: z.literal('ping') }),
]);

// Store active desktop sessions
interface DesktopSession {
  userWs: WSContext;
  agentId: string;
  userId: string;
  deviceId: string;
  orgId: string;
  startedAt: Date;
  pingInterval?: ReturnType<typeof setInterval>;
  lastPongAt: number;
  // E2: token-bucket for input events (60 events/sec).
  inputTokens: number;
  inputLastRefillMs: number;
  inputOverageLogged: boolean;
  // E2: audit summary counters
  inputEvents: number;
  frameBytes: number;
}

// E2: desktop input event token bucket (60 events/sec/session).
const DESKTOP_INPUT_TOKENS_PER_SEC = 60;
const DESKTOP_INPUT_BUCKET_CAPACITY = 60;

const activeDesktopSessions = new Map<string, DesktopSession>();

// Store frame callbacks — called by agentWs when binary frames arrive
type DesktopFrameCallback = (data: Uint8Array) => void;
const desktopFrameCallbacks = new Map<string, DesktopFrameCallback>();

// Server-side ping/pong constants for stale connection detection
const PING_INTERVAL_MS = 30_000;
const PONG_TIMEOUT_MS = 10_000;

// Exchange cache cleanup interval (Fix #33)
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of exchangeCache) {
    if (now >= entry.expiresAt) {
      exchangeCache.delete(key);
    }
  }
}, 60_000);

// E1: Redis-backed sliding window rate limiter for user WS upgrades.
// Decision: fail closed on Redis outage (matches `rateLimiter` helper default).
// Rationale: viewer/operator-initiated WS — users can retry; an open door
// during a Redis blip is a bigger risk than a temporary 4029.
const USER_WS_RATE_LIMIT = 10;
const USER_WS_RATE_WINDOW_SECONDS = 60;

async function isUserDesktopWsRateLimited(userId: string): Promise<boolean> {
  const redis = getRedis();
  const result = await rateLimiter(
    redis,
    `desktopws:conn:${userId}`,
    USER_WS_RATE_LIMIT,
    USER_WS_RATE_WINDOW_SECONDS
  );
  return !result.allowed;
}

const desktopConnectExchangeSchema = z.object({
  sessionId: z.string().min(1),
  code: z.string().min(1)
});

const desktopSessionIdParamSchema = z.object({
  id: z.string().uuid()
});

type ViewerAccessResult =
  | {
      valid: true;
      session: typeof remoteSessions.$inferSelect;
      device: typeof devices.$inferSelect;
      user: Pick<typeof users.$inferSelect, 'id' | 'email' | 'status'>;
    }
  | {
      valid: false;
      status: 400 | 401 | 403 | 404;
      error: string;
    };

async function validateViewerSessionAccess(
  authorizationHeader: string | undefined,
  sessionId: string
): Promise<ViewerAccessResult> {
  if (!authorizationHeader?.startsWith('Bearer ')) {
    return { valid: false, status: 401, error: 'Missing viewer token' };
  }

  const token = authorizationHeader.slice(7);
  const payload = await verifyViewerAccessToken(token);
  if (!payload) {
    return { valid: false, status: 401, error: 'Invalid or expired viewer token' };
  }

  if (payload.sessionId !== sessionId) {
    return { valid: false, status: 403, error: 'Viewer token does not match session' };
  }

  // Viewer auth bypasses JWT middleware so no RLS context is set.
  // Use system scope — the viewer token already verified ownership.
  return withSystemDbAccessContext(async () => {
    const [result] = await db
      .select({
        session: remoteSessions,
        device: devices,
        user: {
          id: users.id,
          email: users.email,
          status: users.status,
        },
      })
      .from(remoteSessions)
      .innerJoin(devices, eq(remoteSessions.deviceId, devices.id))
      .innerJoin(users, eq(remoteSessions.userId, users.id))
      .where(eq(remoteSessions.id, sessionId))
      .limit(1);

    if (!result) {
      return { valid: false as const, status: 404 as const, error: 'Session not found' };
    }

    const { session, device, user } = result;

    if (session.type !== 'desktop') {
      return { valid: false as const, status: 400 as const, error: 'Session is not a desktop session' };
    }

    if (session.userId !== payload.sub || user.id !== payload.sub || user.email !== payload.email) {
      return { valid: false as const, status: 403 as const, error: 'Viewer token does not match session owner' };
    }

    if (user.status !== 'active') {
      return { valid: false as const, status: 403 as const, error: 'User not found or inactive' };
    }

    return { valid: true as const, session, device, user };
  });
}

/**
 * Validate one-time WS ticket and desktop session access
 */
async function validateDesktopAccess(
  sessionId: string,
  ticket: string | undefined
): Promise<{ valid: boolean; error?: string; session?: typeof remoteSessions.$inferSelect; device?: typeof devices.$inferSelect; userId?: string }> {
  if (!ticket) {
    return { valid: false, error: 'Missing connection ticket' };
  }

  const ticketRecord = await consumeWsTicket(ticket);
  if (!ticketRecord) {
    return { valid: false, error: 'Invalid or expired connection ticket' };
  }

  if (ticketRecord.sessionId !== sessionId || ticketRecord.sessionType !== 'desktop') {
    return { valid: false, error: 'Connection ticket does not match desktop session' };
  }

  // WS ticket auth bypasses JWT middleware so no RLS context is set.
  // Use system scope — the ticket already verified ownership.
  return withSystemDbAccessContext(async () => {
    const [user] = await db
      .select({ id: users.id, status: users.status })
      .from(users)
      .where(eq(users.id, ticketRecord.userId))
      .limit(1);

    if (!user || user.status !== 'active') {
      return { valid: false, error: 'User not found or inactive' };
    }

    const [result] = await db
      .select({
        session: remoteSessions,
        device: devices
      })
      .from(remoteSessions)
      .innerJoin(devices, eq(remoteSessions.deviceId, devices.id))
      .where(eq(remoteSessions.id, sessionId))
      .limit(1);

    if (!result) {
      return { valid: false, error: 'Session not found' };
    }

    const { session, device } = result;

    if (session.type !== 'desktop') {
      return { valid: false, error: 'Session is not a desktop session' };
    }

    if (session.userId !== user.id) {
      return { valid: false, error: 'Session does not belong to this user' };
    }

    if (!['pending', 'connecting', 'active'].includes(session.status)) {
      return { valid: false, error: `Session is ${session.status}` };
    }

    if (device.status !== 'online') {
      return { valid: false, error: 'Device is not online' };
    }

    // Remote access policy enforcement (defense-in-depth)
    const policyCheck = await checkRemoteAccess(device.id, 'webrtcDesktop');
    if (!policyCheck.allowed) {
      return { valid: false, error: policyCheck.reason ?? 'Remote desktop disabled by policy' };
    }

    return { valid: true, session, device, userId: user.id };
  });
}

/**
 * Handle a desktop frame from the agent (binary JPEG data).
 * Called by the agentWs binary fast-path.
 */
export function handleDesktopFrame(sessionId: string, data: Uint8Array): void {
  const callback = desktopFrameCallbacks.get(sessionId);
  if (callback) {
    callback(data);
  }
}

/**
 * Register a callback for desktop frames
 */
export function registerDesktopFrameCallback(sessionId: string, callback: DesktopFrameCallback): void {
  desktopFrameCallbacks.set(sessionId, callback);
}

/**
 * Unregister desktop frame callback
 */
export function unregisterDesktopFrameCallback(sessionId: string): void {
  desktopFrameCallbacks.delete(sessionId);
}

/**
 * Create WebSocket handlers for desktop session
 */
function createDesktopWsHandlers(sessionId: string, ticket: string | undefined) {
  let validationResult: Awaited<ReturnType<typeof validateDesktopAccess>> | null = null;
  const validationPromise = validateDesktopAccess(sessionId, ticket).then(result => {
    validationResult = result;
  });

  return {
    onOpen: async (_event: unknown, ws: WSContext) => {
      // E3: track validation/setup progress so the catch block can clean up
      // any partial state (session entry, frame callback, ping interval, DB row).
      let validated = false;
      let pingInterval: ReturnType<typeof setInterval> | null = null;
      let sessionStored = false;
      let frameCallbackRegistered = false;

      try {
        console.log(`Desktop WebSocket onOpen for session ${sessionId}`);
        await validationPromise;

        if (!validationResult || !validationResult.valid) {
          console.warn(`Desktop WebSocket rejected for session ${sessionId}: ${validationResult?.error}`);
          ws.send(JSON.stringify({
            type: 'error',
            code: 'AUTH_FAILED',
            message: validationResult?.error || 'Authentication failed'
          }));
          ws.close(4001, 'Authentication failed');
          return;
        }

        const { session, device, userId } = validationResult;
        if (!session || !device || !userId) {
          ws.close(4001, 'Invalid session data');
          return;
        }

        if (!isAgentConnected(device.agentId)) {
          ws.send(JSON.stringify({
            type: 'error',
            code: 'AGENT_OFFLINE',
            message: 'Agent is not connected via WebSocket'
          }));
          ws.close(4002, 'Agent offline');
          return;
        }

        // E1: Redis-backed rate limit user WS connections (fail-closed)
        if (await isUserDesktopWsRateLimited(userId)) {
          console.warn(`Desktop WebSocket rate limited for user ${userId}`);
          ws.send(JSON.stringify({
            type: 'error',
            code: 'RATE_LIMITED',
            message: 'Too many connection attempts'
          }));
          ws.close(4029, 'Rate limited');
          return;
        }

        // All validation passed — safe to touch DB state for this session
        validated = true;

        // Store the desktop session
        const now = Date.now();
        activeDesktopSessions.set(sessionId, {
          userWs: ws,
          agentId: device.agentId,
          userId,
          deviceId: device.id,
          orgId: device.orgId,
          startedAt: new Date(),
          lastPongAt: now,
          inputTokens: DESKTOP_INPUT_BUCKET_CAPACITY,
          inputLastRefillMs: now,
          inputOverageLogged: false,
          inputEvents: 0,
          frameBytes: 0,
        });
        sessionStored = true;

        // Register frame callback — relay binary JPEG frames directly to viewer
        registerDesktopFrameCallback(sessionId, (data: Uint8Array) => {
          try {
            // Copy into a fresh ArrayBuffer to satisfy WSContext.send() type
            const buf = new ArrayBuffer(data.byteLength);
            new Uint8Array(buf).set(data);
            const sess = activeDesktopSessions.get(sessionId);
            if (sess) {
              sess.frameBytes += data.byteLength;
            }
            ws.send(buf);
          } catch (error) {
            console.error(`Failed to send desktop frame to session ${sessionId}:`, error);
          }
        });
        frameCallbackRegistered = true;

        // Update session status (system scope — WS auth bypasses JWT middleware)
        await withSystemDbAccessContext(() =>
          db.update(remoteSessions)
            .set({ status: 'active', startedAt: new Date() })
            .where(eq(remoteSessions.id, sessionId))
        );

        // Send desktop_stream_start command to agent
        const startCommand = {
          id: `desk-start-${sessionId}`,
          type: 'desktop_stream_start',
          payload: {
            sessionId,
            quality: 60,
            scaleFactor: 1.0,
            maxFps: 15
          }
        };

        const sent = sendCommandToAgent(device.agentId, startCommand);
        if (!sent) {
          ws.send(JSON.stringify({
            type: 'error',
            code: 'AGENT_SEND_FAILED',
            message: 'Failed to send start command to agent'
          }));
          return;
        }

        // Send connected message to viewer
        ws.send(JSON.stringify({
          type: 'connected',
          sessionId,
          device: {
            hostname: device.hostname,
            osType: device.osType
          }
        }));

        // Start server-side ping/pong for stale connection detection
        pingInterval = setInterval(() => {
          const deskSess = activeDesktopSessions.get(sessionId);
          if (!deskSess) {
            if (pingInterval) clearInterval(pingInterval);
            return;
          }
          const elapsed = Date.now() - deskSess.lastPongAt;
          if (elapsed > PING_INTERVAL_MS + PONG_TIMEOUT_MS) {
            console.warn(`Desktop session ${sessionId} pong timeout (${elapsed}ms), closing`);
            if (pingInterval) clearInterval(pingInterval);
            ws.close(4008, 'Pong timeout');
            return;
          }
          try {
            ws.send(JSON.stringify({ type: 'ping', timestamp: Date.now() }));
          } catch (err) {
            console.warn(`[DesktopWs] Ping send failed for session ${sessionId}, cleaning up`, err);
            if (pingInterval) clearInterval(pingInterval);
          }
        }, PING_INTERVAL_MS);

        const currentSession = activeDesktopSessions.get(sessionId);
        if (currentSession) {
          currentSession.pingInterval = pingInterval;
        }

        console.log(`Desktop session ${sessionId} connected for device ${device.hostname}`);
      } catch (error) {
        // E3: mirror terminalWs.ts onOpen cleanup on early throw.
        console.error(`[DesktopWs] onOpen failed for session ${sessionId}:`, error);

        if (pingInterval) {
          clearInterval(pingInterval);
        }
        if (sessionStored) {
          const partial = activeDesktopSessions.get(sessionId);
          if (partial?.pingInterval) {
            clearInterval(partial.pingInterval);
          }
          activeDesktopSessions.delete(sessionId);
        }
        if (frameCallbackRegistered) {
          unregisterDesktopFrameCallback(sessionId);
        }

        // Best-effort: mark DB session as failed — only if auth/validation already passed.
        if (validated) {
          try {
            await withSystemDbAccessContext(() =>
              db.update(remoteSessions)
                .set({ status: 'failed', endedAt: new Date() })
                .where(eq(remoteSessions.id, sessionId))
            );
          } catch (dbError) {
            console.error(`[DesktopWs] Failed to update session ${sessionId} status to failed:`, dbError);
          }
        }

        try {
          ws.send(JSON.stringify({
            type: 'error',
            code: 'INTERNAL_ERROR',
            message: 'Desktop session setup failed'
          }));
          ws.close(1011, 'internal_error');
        } catch (closeError) {
          console.error(`[DesktopWs] Failed to close WS after onOpen error for session ${sessionId}:`, closeError);
        }
      }
    },

    onMessage: async (event: MessageEvent, ws: WSContext) => {
      const desktopSession = activeDesktopSessions.get(sessionId);
      if (!desktopSession) {
        ws.send(JSON.stringify({
          type: 'error',
          code: 'SESSION_NOT_FOUND',
          message: 'Desktop session not found'
        }));
        return;
      }

      try {
        const data = typeof event.data === 'string' ? event.data : event.data.toString();
        const raw = JSON.parse(data);

        // Handle pong responses for server-initiated ping (not in discriminatedUnion)
        if (raw?.type === 'pong') {
          desktopSession.lastPongAt = Date.now();
          return;
        }

        const parsed = desktopMessageSchema.safeParse(raw);
        if (!parsed.success) {
          console.warn(`Invalid desktop message from session ${sessionId}:`, parsed.error.errors);
          return;
        }
        const message = parsed.data;

        switch (message.type) {
          case 'input': {
            // E2: token-bucket rate limit (60 events/sec). On breach, drop
            // the excess but keep the session open — a stuck mouse should
            // not kill an active remote-control session. Log the first overage.
            const nowMs = Date.now();
            const elapsedMs = Math.max(0, nowMs - desktopSession.inputLastRefillMs);
            const refill = (elapsedMs / 1000) * DESKTOP_INPUT_TOKENS_PER_SEC;
            desktopSession.inputTokens = Math.min(
              DESKTOP_INPUT_BUCKET_CAPACITY,
              desktopSession.inputTokens + refill
            );
            desktopSession.inputLastRefillMs = nowMs;

            if (desktopSession.inputTokens < 1) {
              if (!desktopSession.inputOverageLogged) {
                console.warn(`Desktop session ${sessionId} input rate-limited (token bucket empty)`);
                desktopSession.inputOverageLogged = true;
              }
              break; // drop event, keep session open
            }
            desktopSession.inputTokens -= 1;
            desktopSession.inputEvents += 1;

            const sent = sendCommandToAgent(desktopSession.agentId, {
              id: `desk-input-${Date.now()}`,
              type: 'desktop_input',
              payload: {
                sessionId,
                event: message.event
              }
            });
            if (!sent) {
              ws.send(JSON.stringify({
                type: 'error',
                code: 'AGENT_DISCONNECTED',
                message: 'Agent is no longer connected'
              }));
            }
            break;
          }

          case 'config': {
            const sent = sendCommandToAgent(desktopSession.agentId, {
              id: `desk-config-${Date.now()}`,
              type: 'desktop_config',
              payload: {
                sessionId,
                ...(message.quality !== undefined && { quality: message.quality }),
                ...(message.scaleFactor !== undefined && { scaleFactor: message.scaleFactor }),
                ...(message.maxFps !== undefined && { maxFps: message.maxFps })
              }
            });
            if (!sent) {
              ws.send(JSON.stringify({
                type: 'error',
                code: 'AGENT_DISCONNECTED',
                message: 'Agent is no longer connected'
              }));
            }
            break;
          }

          case 'ping':
            // Client-initiated ping — respond with pong and update timestamp
            desktopSession.lastPongAt = Date.now();
            ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
            break;
        }
      } catch (error) {
        console.error(`Error processing desktop message for session ${sessionId}:`, error);
        ws.send(JSON.stringify({
          type: 'error',
          code: 'MESSAGE_ERROR',
          message: 'Failed to process message'
        }));
      }
    },

    onClose: async (_event: unknown, _ws: WSContext) => {
      const desktopSession = activeDesktopSessions.get(sessionId);

      if (desktopSession) {
        // Clear ping interval
        if (desktopSession.pingInterval) {
          clearInterval(desktopSession.pingInterval);
        }

        // Send desktop_stream_stop to agent
        sendCommandToAgent(desktopSession.agentId, {
          id: `desk-stop-${sessionId}`,
          type: 'desktop_stream_stop',
          payload: { sessionId }
        });

        // Clean up
        activeDesktopSessions.delete(sessionId);
        unregisterDesktopFrameCallback(sessionId);

        // Update session status (system scope — WS auth bypasses JWT middleware)
        const endedAt = new Date();
        const durationSeconds = Math.round((endedAt.getTime() - desktopSession.startedAt.getTime()) / 1000);

        await withSystemDbAccessContext(() =>
          db.update(remoteSessions)
            .set({ status: 'disconnected', endedAt, durationSeconds })
            .where(eq(remoteSessions.id, sessionId))
        );

        // E2: write a session summary audit row on close.
        try {
          await logSessionAudit(
            'desktop.session.summary',
            desktopSession.userId,
            desktopSession.orgId,
            {
              sessionId,
              deviceId: desktopSession.deviceId,
              inputEvents: desktopSession.inputEvents,
              frameBytes: desktopSession.frameBytes,
              durationMs: endedAt.getTime() - desktopSession.startedAt.getTime(),
            }
          );
        } catch (auditErr) {
          console.error(`[DesktopWs] Failed to write session summary for ${sessionId}:`, auditErr);
        }

        console.log(`Desktop session ${sessionId} disconnected (duration: ${durationSeconds}s)`);
      }
    },

    onError: async (event: unknown, _ws: WSContext) => {
      console.error(`Desktop WebSocket error for session ${sessionId}:`, event);
      const desktopSession = activeDesktopSessions.get(sessionId);
      if (desktopSession?.pingInterval) {
        clearInterval(desktopSession.pingInterval);
      }
      activeDesktopSessions.delete(sessionId);
      unregisterDesktopFrameCallback(sessionId);

      if (desktopSession) {
        try {
          sendCommandToAgent(desktopSession.agentId, {
            id: `desk-stop-${sessionId}`,
            type: 'desktop_stream_stop',
            payload: { sessionId }
          });

          const endedAt = new Date();
          const durationSeconds = Math.round((endedAt.getTime() - desktopSession.startedAt.getTime()) / 1000);

          await withSystemDbAccessContext(() =>
            db.update(remoteSessions)
              .set({ status: 'disconnected', endedAt, durationSeconds })
              .where(eq(remoteSessions.id, sessionId))
          );
        } catch (dbError) {
          console.error(`Failed to update session ${sessionId} status after error:`, dbError);
        }
      }
    }
  };
}

/**
 * Create desktop WebSocket routes
 */
export function createDesktopWsRoutes(upgradeWebSocket: Function): Hono {
  const app = new Hono();

  // Health check for debugging route registration
  app.get('/health', (c) => c.json({ ok: true, route: 'desktop-ws' }));

  // Exchange one-time deep-link connect code for an access token.
  // This keeps long-lived bearer credentials out of deep-link URLs.
  app.post(
    '/connect/exchange',
    zValidator('json', desktopConnectExchangeSchema),
    async (c) => {
      const { sessionId, code } = c.req.valid('json');

      // Check cache first — handles duplicate calls from React effect re-fires
      const cacheKey = `${sessionId}:${code}`;
      const cached = exchangeCache.get(cacheKey);
      if (cached && Date.now() < cached.expiresAt) {
        return c.json(cached.result);
      }
      exchangeCache.delete(cacheKey);

      const codeRecord = await consumeDesktopConnectCode(code);

      if (!codeRecord || codeRecord.sessionId !== sessionId) {
        return c.json({ error: 'Invalid or expired connect code' }, 401);
      }

      if (!codeRecord.email) {
        return c.json({ error: 'Invalid or expired connect code' }, 401); // Reject pre-deployment codes missing email field
      }

      // Connect-code exchange bypasses JWT middleware so no RLS context is set.
      // Use system scope — the one-time code already verified ownership.
      const dbResult = await withSystemDbAccessContext(async () => {
        const [session] = await db
          .select({
            id: remoteSessions.id,
            userId: remoteSessions.userId,
            type: remoteSessions.type,
            status: remoteSessions.status,
            deviceId: remoteSessions.deviceId,
          })
          .from(remoteSessions)
          .where(eq(remoteSessions.id, sessionId))
          .limit(1);

        let hostname: string | undefined;
        let osType: string | undefined;
        if (session?.deviceId) {
          try {
            const [device] = await db
              .select({ hostname: devices.hostname, osType: devices.osType })
              .from(devices)
              .where(eq(devices.id, session.deviceId))
              .limit(1);
            hostname = device?.hostname ?? undefined;
            osType = device?.osType ?? undefined;
          } catch (err) {
            console.error('Failed to look up device hostname for viewer title:', err);
          }
        }

        return { session, hostname, osType };
      });

      const { session, hostname, osType } = dbResult;

      if (!session || session.type !== 'desktop' || session.userId !== codeRecord.userId) {
        return c.json({ error: 'Invalid or expired connect code' }, 401);
      }

      if (!['pending', 'connecting', 'active'].includes(session.status)) {
        return c.json({ error: 'Session is not available for connection' }, 400);
      }

      const accessToken = await createViewerAccessToken({
        sub: codeRecord.userId,
        email: codeRecord.email,
        sessionId: session.id,
      });
      const result = {
        accessToken,
        expiresInSeconds: getViewerAccessTokenExpirySeconds(),
        hostname: hostname ?? null,
        osType: osType ?? null,
      };

      // Cache the result briefly for duplicate requests
      exchangeCache.set(cacheKey, { result, expiresAt: Date.now() + EXCHANGE_CACHE_TTL_MS });

      return c.json(result);
    }
  );

  app.get(
    '/:id/viewer/ice-servers',
    zValidator('param', desktopSessionIdParamSchema),
    async (c) => {
      const { id: sessionId } = c.req.valid('param');
      const access = await validateViewerSessionAccess(c.req.header('Authorization'), sessionId);
      if (!access.valid) {
        return c.json({ error: access.error }, access.status);
      }

      if (!['pending', 'connecting', 'active', 'disconnected'].includes(access.session.status)) {
        return c.json({
          error: 'Cannot fetch ICE servers for session in current state',
          status: access.session.status
        }, 400);
      }

      return c.json({ iceServers: getIceServers() });
    }
  );

  app.post(
    '/:id/viewer/ws-ticket',
    zValidator('param', desktopSessionIdParamSchema),
    async (c) => {
      const { id: sessionId } = c.req.valid('param');
      const access = await validateViewerSessionAccess(c.req.header('Authorization'), sessionId);
      if (!access.valid) {
        return c.json({ error: access.error }, access.status);
      }

      if (!['pending', 'connecting', 'active'].includes(access.session.status)) {
        return c.json({
          error: 'Cannot mint WebSocket ticket for session in current state',
          status: access.session.status
        }, 400);
      }

      try {
        const ticket = await createWsTicket({
          sessionId: access.session.id,
          sessionType: 'desktop',
          userId: access.user.id
        });
        return c.json(ticket);
      } catch (error) {
        console.error('[desktop-ws] Failed to create viewer WebSocket ticket:', error);
        return c.json({ error: 'Unable to create WebSocket ticket. Please try again later.' }, 503);
      }
    }
  );

  app.post(
    '/:id/viewer/offer',
    zValidator('param', desktopSessionIdParamSchema),
    zValidator('json', webrtcOfferSchema),
    async (c) => {
      const { id: sessionId } = c.req.valid('param');
      const data = c.req.valid('json');
      const access = await validateViewerSessionAccess(c.req.header('Authorization'), sessionId);
      if (!access.valid) {
        return c.json({ error: access.error }, access.status);
      }

      if (!['pending', 'connecting', 'active', 'disconnected'].includes(access.session.status)) {
        return c.json({
          error: 'Cannot submit offer for session in current state',
          status: access.session.status
        }, 400);
      }

      const [updated] = await withSystemDbAccessContext(() =>
        db.update(remoteSessions)
          .set({
            webrtcOffer: data.offer,
            webrtcAnswer: null,
            status: 'connecting',
            ...(access.session.status === 'disconnected' || access.session.status === 'active' ? { endedAt: null } : {}),
          })
          .where(eq(remoteSessions.id, sessionId))
          .returning()
      );

      if (!updated) {
        return c.json({ error: 'Failed to update session' }, 500);
      }

      await logSessionAudit(
        'session_offer_submitted',
        access.user.id,
        access.device.orgId,
        { sessionId, type: access.session.type, via: 'viewer_token' },
        getTrustedClientIp(c, 'unknown')
      );

      if (!access.device.agentId) {
        console.error(`[desktop-ws] Device ${access.device.id} has no agentId, cannot send start_desktop for session ${sessionId}`);
        return c.json({ error: 'Device has no agent connection identifier' }, 502);
      }

      const agentReachable = sendCommandToAgent(access.device.agentId, {
        id: `desk-start-${sessionId}`,
        type: 'start_desktop',
        payload: { sessionId, offer: data.offer, iceServers: getIceServers(), ...(data.displayIndex != null ? { displayIndex: data.displayIndex } : {}), ...(data.targetSessionId != null ? { targetSessionId: data.targetSessionId } : {}) }
      });

      if (!agentReachable) {
        console.warn(`[desktop-ws] Agent ${access.device.agentId} not connected, cannot send start_desktop for session ${sessionId}`);
        return c.json({ error: 'Agent is not currently connected. Please verify the device is online and try again.' }, 502);
      }

      return c.json({
        id: updated.id,
        status: updated.status,
        webrtcOffer: updated.webrtcOffer,
      });
    }
  );

  app.get(
    '/:id/viewer/session',
    zValidator('param', desktopSessionIdParamSchema),
    async (c) => {
      const { id: sessionId } = c.req.valid('param');
      const access = await validateViewerSessionAccess(c.req.header('Authorization'), sessionId);
      if (!access.valid) {
        return c.json({ error: access.error }, access.status);
      }

      return c.json({
        id: access.session.id,
        status: access.session.status,
        webrtcAnswer: access.session.webrtcAnswer,
        errorMessage: access.session.errorMessage,
        startedAt: access.session.startedAt,
        endedAt: access.session.endedAt,
      });
    }
  );

  // WebSocket route for desktop sessions
  // GET /api/v1/desktop-ws/:id/ws?ticket=xxx
  app.get(
    '/:id/ws',
    upgradeWebSocket((c: { req: { param: (key: string) => string; query: (key: string) => string | undefined } }) => {
      const sessionId = c.req.param('id');
      const ticket = c.req.query('ticket');
      return createDesktopWsHandlers(sessionId, ticket);
    })
  );

  return app;
}

/**
 * Check if an agent owns a given desktop session
 */
export function isDesktopSessionOwnedByAgent(sessionId: string, agentId: string): boolean {
  const session = activeDesktopSessions.get(sessionId);
  return session !== undefined && session.agentId === agentId;
}

/**
 * Get count of active desktop sessions
 */
export function getActiveDesktopSessionCount(): number {
  return activeDesktopSessions.size;
}
