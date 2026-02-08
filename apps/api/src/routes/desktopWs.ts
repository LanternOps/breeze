import { Hono } from 'hono';
import type { WSContext } from 'hono/ws';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { remoteSessions, devices, users } from '../db/schema';
import { verifyToken } from '../services/jwt';
import { getRedis } from '../services/redis';
import { sendCommandToAgent, isAgentConnected } from './agentWs';

// Types for desktop messages
interface DesktopInputMessage {
  type: 'input';
  event: {
    type: string;
    x?: number;
    y?: number;
    button?: string;
    key?: string;
    modifiers?: string[];
    delta?: number;
  };
}

interface DesktopConfigMessage {
  type: 'config';
  quality?: number;
  scaleFactor?: number;
  maxFps?: number;
}

interface DesktopPingMessage {
  type: 'ping';
}

type DesktopMessage = DesktopInputMessage | DesktopConfigMessage | DesktopPingMessage;

// Store active desktop sessions
interface DesktopSession {
  userWs: WSContext;
  agentId: string;
  userId: string;
  deviceId: string;
  startedAt: Date;
}

const activeDesktopSessions = new Map<string, DesktopSession>();

// Store frame callbacks — called by agentWs when binary frames arrive
type DesktopFrameCallback = (data: Uint8Array) => void;
const desktopFrameCallbacks = new Map<string, DesktopFrameCallback>();

/**
 * Validate user token and desktop session access
 */
async function validateDesktopAccess(
  sessionId: string,
  token: string | undefined
): Promise<{ valid: boolean; error?: string; session?: typeof remoteSessions.$inferSelect; device?: typeof devices.$inferSelect; userId?: string }> {
  if (!token) {
    return { valid: false, error: 'Missing authentication token' };
  }

  const payload = await verifyToken(token);
  if (!payload || payload.type !== 'access') {
    return { valid: false, error: 'Invalid or expired token' };
  }

  const redis = getRedis();
  if (redis) {
    try {
      const revoked = await redis.get(`token:revoked:${payload.sub}`);
      if (revoked) {
        return { valid: false, error: 'Invalid or expired token' };
      }
    } catch (error) {
      console.warn('[desktopWs] Failed to check token revocation state:', error);
    }
  }

  const [user] = await db
    .select({ id: users.id, status: users.status })
    .from(users)
    .where(eq(users.id, payload.sub))
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

  return { valid: true, session, device, userId: user.id };
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
function createDesktopWsHandlers(sessionId: string, token: string | undefined) {
  let validationResult: Awaited<ReturnType<typeof validateDesktopAccess>> | null = null;
  const validationPromise = validateDesktopAccess(sessionId, token).then(result => {
    validationResult = result;
  });

  return {
    onOpen: async (_event: unknown, ws: WSContext) => {
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

      // Store the desktop session
      activeDesktopSessions.set(sessionId, {
        userWs: ws,
        agentId: device.agentId,
        userId,
        deviceId: device.id,
        startedAt: new Date()
      });

      // Register frame callback — relay binary JPEG frames directly to viewer
      registerDesktopFrameCallback(sessionId, (data: Uint8Array) => {
        try {
          // Copy into a fresh ArrayBuffer to satisfy WSContext.send() type
          const buf = new ArrayBuffer(data.byteLength);
          new Uint8Array(buf).set(data);
          ws.send(buf);
        } catch (error) {
          console.error(`Failed to send desktop frame to session ${sessionId}:`, error);
        }
      });

      // Update session status
      await db
        .update(remoteSessions)
        .set({
          status: 'active',
          startedAt: new Date()
        })
        .where(eq(remoteSessions.id, sessionId));

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

      console.log(`Desktop session ${sessionId} connected for device ${device.hostname}`);
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
        const message: DesktopMessage = JSON.parse(data);

        switch (message.type) {
          case 'input': {
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
            ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
            break;

          default:
            console.warn(`Unknown desktop message type from session ${sessionId}`);
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
        // Send desktop_stream_stop to agent
        sendCommandToAgent(desktopSession.agentId, {
          id: `desk-stop-${sessionId}`,
          type: 'desktop_stream_stop',
          payload: { sessionId }
        });

        // Clean up
        activeDesktopSessions.delete(sessionId);
        unregisterDesktopFrameCallback(sessionId);

        // Update session status
        const endedAt = new Date();
        const durationSeconds = Math.round((endedAt.getTime() - desktopSession.startedAt.getTime()) / 1000);

        await db
          .update(remoteSessions)
          .set({
            status: 'disconnected',
            endedAt,
            durationSeconds
          })
          .where(eq(remoteSessions.id, sessionId));

        console.log(`Desktop session ${sessionId} disconnected (duration: ${durationSeconds}s)`);
      }
    },

    onError: async (event: unknown, _ws: WSContext) => {
      console.error(`Desktop WebSocket error for session ${sessionId}:`, event);
      const desktopSession = activeDesktopSessions.get(sessionId);
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

          await db
            .update(remoteSessions)
            .set({
              status: 'disconnected',
              endedAt,
              durationSeconds
            })
            .where(eq(remoteSessions.id, sessionId));
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

  // WebSocket route for desktop sessions
  // GET /api/v1/desktop-ws/:id/ws?token=xxx
  app.get(
    '/:id/ws',
    upgradeWebSocket((c: { req: { param: (key: string) => string; query: (key: string) => string | undefined } }) => {
      const sessionId = c.req.param('id');
      const token = c.req.query('token');
      return createDesktopWsHandlers(sessionId, token);
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
