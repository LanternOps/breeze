import { Hono } from 'hono';
import type { WSContext } from 'hono/ws';
import { eq, and } from 'drizzle-orm';
import { db } from '../db';
import { remoteSessions, devices, users } from '../db/schema';
import { verifyToken } from '../services/jwt';
import { getRedis } from '../services/redis';
import { sendCommandToAgent, isAgentConnected } from './agentWs';

// Types for terminal messages
interface TerminalDataMessage {
  type: 'data';
  data: string;
}

interface TerminalResizeMessage {
  type: 'resize';
  cols: number;
  rows: number;
}

interface TerminalPingMessage {
  type: 'ping';
}

type TerminalMessage = TerminalDataMessage | TerminalResizeMessage | TerminalPingMessage;

// Store active terminal sessions
// Map<sessionId, { userWs: WSContext, agentId: string, userId: string }>
interface TerminalSession {
  userWs: WSContext;
  agentId: string;
  userId: string;
  deviceId: string;
  startedAt: Date;
}

const activeTerminalSessions = new Map<string, TerminalSession>();

// Store pending terminal output to relay back to user
// Map<sessionId, callback>
type TerminalOutputCallback = (data: string) => void;
const terminalOutputCallbacks = new Map<string, TerminalOutputCallback>();

/**
 * Validate user token and session access
 */
async function validateTerminalAccess(
  sessionId: string,
  token: string | undefined
): Promise<{ valid: boolean; error?: string; session?: typeof remoteSessions.$inferSelect; device?: typeof devices.$inferSelect; userId?: string }> {
  if (!token) {
    return { valid: false, error: 'Missing authentication token' };
  }

  // Verify JWT token
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
      console.warn('[terminalWs] Failed to check token revocation state:', error);
    }
  }

  // Check user exists and is active
  const [user] = await db
    .select({ id: users.id, status: users.status })
    .from(users)
    .where(eq(users.id, payload.sub))
    .limit(1);

  if (!user || user.status !== 'active') {
    return { valid: false, error: 'User not found or inactive' };
  }

  // Get session with device info
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

  // Check session is for terminal
  if (session.type !== 'terminal') {
    return { valid: false, error: 'Session is not a terminal session' };
  }

  // Check session belongs to this user
  if (session.userId !== user.id) {
    return { valid: false, error: 'Session does not belong to this user' };
  }

  // Check session status
  if (!['pending', 'connecting', 'active'].includes(session.status)) {
    return { valid: false, error: `Session is ${session.status}` };
  }

  // Check device is online
  if (device.status !== 'online') {
    return { valid: false, error: 'Device is not online' };
  }

  return { valid: true, session, device, userId: user.id };
}

/**
 * Handle terminal output from agent
 * Called by agentWs when it receives terminal data
 */
export function handleTerminalOutput(sessionId: string, data: string): void {
  const callback = terminalOutputCallbacks.get(sessionId);
  if (callback) {
    callback(data);
  }
}

/**
 * Register a callback for terminal output
 */
export function registerTerminalOutputCallback(sessionId: string, callback: TerminalOutputCallback): void {
  terminalOutputCallbacks.set(sessionId, callback);
}

/**
 * Unregister terminal output callback
 */
export function unregisterTerminalOutputCallback(sessionId: string): void {
  terminalOutputCallbacks.delete(sessionId);
}

/**
 * Get active terminal session
 */
export function getActiveTerminalSession(sessionId: string): TerminalSession | undefined {
  return activeTerminalSessions.get(sessionId);
}

/**
 * Create WebSocket handlers for terminal session
 */
function createTerminalWsHandlers(sessionId: string, token: string | undefined) {
  let validationResult: Awaited<ReturnType<typeof validateTerminalAccess>> | null = null;
  const validationPromise = validateTerminalAccess(sessionId, token).then(result => {
    validationResult = result;
  });

  return {
    onOpen: async (_event: unknown, ws: WSContext) => {
      console.log(`Terminal WebSocket onOpen for session ${sessionId}`);
      await validationPromise;
      console.log(`Terminal validation result:`, validationResult?.valid, validationResult?.error);

      if (!validationResult || !validationResult.valid) {
        console.warn(`Terminal WebSocket rejected for session ${sessionId}: ${validationResult?.error}`);
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

      // Check if agent is connected
      console.log(`Checking if agent ${device.agentId} is connected...`);
      if (!isAgentConnected(device.agentId)) {
        console.warn(`Agent ${device.agentId} is not connected via WebSocket`);
        ws.send(JSON.stringify({
          type: 'error',
          code: 'AGENT_OFFLINE',
          message: 'Agent is not connected via WebSocket'
        }));
        ws.close(4002, 'Agent offline');
        return;
      }
      console.log(`Agent ${device.agentId} is connected`);

      // Store the terminal session
      activeTerminalSessions.set(sessionId, {
        userWs: ws,
        agentId: device.agentId,
        userId,
        deviceId: device.id,
        startedAt: new Date()
      });

      // Register callback for terminal output
      registerTerminalOutputCallback(sessionId, (data: string) => {
        try {
          ws.send(JSON.stringify({ type: 'output', data }));
        } catch (error) {
          console.error(`Failed to send terminal output to session ${sessionId}:`, error);
        }
      });

      console.log(`Terminal session ${sessionId} connected for device ${device.hostname}`);

      // Update session status
      await db
        .update(remoteSessions)
        .set({
          status: 'active',
          startedAt: new Date()
        })
        .where(eq(remoteSessions.id, sessionId));

      // Send connected message to user
      ws.send(JSON.stringify({
        type: 'connected',
        sessionId,
        device: {
          hostname: device.hostname,
          osType: device.osType
        }
      }));

      // Send terminal_start command to agent
      const startCommand = {
        id: `term-start-${sessionId}`,
        type: 'terminal_start',
        payload: {
          sessionId,
          cols: 80,
          rows: 24,
          shell: device.osType === 'windows' ? 'powershell' : undefined
        }
      };

      const sent = sendCommandToAgent(device.agentId, startCommand);
      if (!sent) {
        ws.send(JSON.stringify({
          type: 'error',
          code: 'AGENT_SEND_FAILED',
          message: 'Failed to send start command to agent'
        }));
      }
    },

    onMessage: async (event: MessageEvent, ws: WSContext) => {
      const termSession = activeTerminalSessions.get(sessionId);
      if (!termSession) {
        ws.send(JSON.stringify({
          type: 'error',
          code: 'SESSION_NOT_FOUND',
          message: 'Terminal session not found'
        }));
        return;
      }

      try {
        const data = typeof event.data === 'string' ? event.data : event.data.toString();
        const message: TerminalMessage = JSON.parse(data);

        switch (message.type) {
          case 'data':
            // Send terminal input to agent
            sendCommandToAgent(termSession.agentId, {
              id: `term-data-${Date.now()}`,
              type: 'terminal_data',
              payload: {
                sessionId,
                data: message.data
              }
            });
            break;

          case 'resize':
            // Send resize command to agent
            sendCommandToAgent(termSession.agentId, {
              id: `term-resize-${Date.now()}`,
              type: 'terminal_resize',
              payload: {
                sessionId,
                cols: message.cols,
                rows: message.rows
              }
            });
            break;

          case 'ping':
            ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
            break;

          default:
            console.warn(`Unknown terminal message type from session ${sessionId}`);
        }
      } catch (error) {
        console.error(`Error processing terminal message for session ${sessionId}:`, error);
        ws.send(JSON.stringify({
          type: 'error',
          code: 'MESSAGE_ERROR',
          message: 'Failed to process message'
        }));
      }
    },

    onClose: async (_event: unknown, _ws: WSContext) => {
      const termSession = activeTerminalSessions.get(sessionId);

      if (termSession) {
        // Send terminal_stop command to agent
        sendCommandToAgent(termSession.agentId, {
          id: `term-stop-${sessionId}`,
          type: 'terminal_stop',
          payload: { sessionId }
        });

        // Clean up
        activeTerminalSessions.delete(sessionId);
        unregisterTerminalOutputCallback(sessionId);

        // Update session status
        const endedAt = new Date();
        const startedAt = termSession.startedAt;
        const durationSeconds = Math.round((endedAt.getTime() - startedAt.getTime()) / 1000);

        await db
          .update(remoteSessions)
          .set({
            status: 'disconnected',
            endedAt,
            durationSeconds
          })
          .where(eq(remoteSessions.id, sessionId));

        console.log(`Terminal session ${sessionId} disconnected (duration: ${durationSeconds}s)`);
      }
    },

    onError: async (event: unknown, _ws: WSContext) => {
      console.error(`Terminal WebSocket error for session ${sessionId}:`, event);
      const termSession = activeTerminalSessions.get(sessionId);
      activeTerminalSessions.delete(sessionId);
      unregisterTerminalOutputCallback(sessionId);

      // Update session status in database to match onClose behavior
      if (termSession) {
        try {
          const endedAt = new Date();
          const durationSeconds = Math.round((endedAt.getTime() - termSession.startedAt.getTime()) / 1000);

          await db
            .update(remoteSessions)
            .set({
              status: 'disconnected',
              endedAt,
              durationSeconds
            })
            .where(eq(remoteSessions.id, sessionId));

          console.log(`Terminal session ${sessionId} errored and cleaned up (duration: ${durationSeconds}s)`);
        } catch (dbError) {
          console.error(`Failed to update session ${sessionId} status after error:`, dbError);
        }
      }
    }
  };
}

/**
 * Create terminal WebSocket routes
 */
export function createTerminalWsRoutes(upgradeWebSocket: Function): Hono {
  const app = new Hono();

  // WebSocket route for terminal sessions
  // GET /api/v1/remote/sessions/:id/ws?token=xxx
  app.get(
    '/:id/ws',
    upgradeWebSocket((c: { req: { param: (key: string) => string; query: (key: string) => string | undefined } }) => {
      const sessionId = c.req.param('id');
      const token = c.req.query('token');
      return createTerminalWsHandlers(sessionId, token);
    })
  );

  return app;
}

/**
 * Get count of active terminal sessions
 */
export function getActiveTerminalSessionCount(): number {
  return activeTerminalSessions.size;
}

/**
 * Get all active terminal session IDs
 */
export function getActiveTerminalSessionIds(): string[] {
  return Array.from(activeTerminalSessions.keys());
}
